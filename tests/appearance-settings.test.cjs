'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../app/core/store.cjs');
const { saveAppearanceSettings } = require('../app/core/appearance-settings.cjs');
const { DEFAULTS, normalizeAppearance, getAppearanceTheme, contrastRatio } = require('../app/renderer/appearance.js');

const colors = () => ({ chatBackground:'#ABC', memberName:'#123456', importantName:'#654321', memberBubble:'#FFF', importantBubble:'#123', importantText:null });
const contextFor = (accountId = 'appearance-a') => ({ accountId, epoch:7, busy:false, closing:false });
const payloadFor = (appearance = colors(), accountId = 'appearance-a') => ({ accountId, appearance });
function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root,{recursive:true}).sort().filter(relative => fs.statSync(path.join(root,relative)).isFile())
    .map(relative => [relative,fs.readFileSync(path.join(root,relative)).toString('base64')]));
}
function setup(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot,'weiyue-appearance-settings-'));
  t.after(() => {
    // The only recursive removal is this test's freshly allocated Temp directory.
    assert.equal(path.dirname(path.resolve(root)),tempRoot);
    assert.ok(path.basename(root).startsWith('weiyue-appearance-settings-'));
    assert.equal(fs.realpathSync(root),path.resolve(root));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const accountRoot = path.join(root,'accounts'), store = new Store(accountRoot);
  for (const accountId of ['appearance-a','appearance-b']) {
    store.ensureAccount({id:accountId,name:'合成配色测试',kind:'import'});
    const message = id => ({id,groupId:'synthetic-group',senderId:'synthetic-member',senderName:'合成成员',text:'仅供本地测试',time:1000 + Number(id)});
    store.mergeMessages(accountId,[{id:'synthetic-group',name:'合成群',selected:true}],[message('1'),message('2')]);
    store.setReadPosition(accountId,'synthetic-group','2',{offset:-12.5,followTail:false,seenId:'2'});
    store.mergeMessages(accountId,[],[message('3')]);
    store.bookmark(accountId,{groupId:'synthetic-group',messageIds:['1'],note:'合成备注',tags:['合成标签']});
    store.setImportant(accountId,'synthetic-member',true);
    store.update(accountId,state => {
      state.settings = {autoSyncEnabled:false,endpoint:'https://example.invalid/v1',model:'synthetic-model',unrelated:{value:['keep',false,3]}};
      state.summaries = [{id:'synthetic-summary',groupId:'synthetic-group',body:'合成摘要',range:{start:1000,end:1004},refs:[{id:'1',groupId:'synthetic-group'}]}];
      state.exports = {'synthetic-export':{summaryId:'synthetic-summary',status:'complete'}};
    });
  }
  fs.mkdirSync(path.join(root,'credentials'));
  fs.writeFileSync(path.join(root,'credentials','synthetic.bin'),'SYNTHETIC-OPAQUE-SENTINEL');
  fs.writeFileSync(path.join(root,'preferences.json'),JSON.stringify({activeId:'appearance-a',unrelated:'keep'}));
  return {root,accountRoot,store};
}
function save(store, payload = payloadFor(), getContext = () => contextFor()) {
  return saveAppearanceSettings({store,payload,getContext});
}
function withoutAppearance(state) {
  const copy = structuredClone(state);
  delete copy.settings.appearance;
  return copy;
}

test('appearance save persists six canonical fields across restart without changing any other account or reading field', t => {
  const {root,accountRoot,store} = setup(t), beforeA = store.get('appearance-a'), beforeB = store.get('appearance-b'), filesBefore = snapshot(root);
  assert.deepEqual(beforeA.readStates['synthetic-group'].unreadIds,['3']);
  const result = save(store);
  const expected = {chatBackground:'#aabbcc',memberName:'#123456',importantName:'#654321',memberBubble:'#ffffff',importantBubble:'#112233',importantText:null};
  assert.deepEqual(result,expected);
  const reopened = new Store(accountRoot), afterA = reopened.get('appearance-a');
  assert.deepEqual(afterA.settings.appearance,expected);
  assert.deepEqual(withoutAppearance(afterA),beforeA);
  assert.deepEqual(reopened.get('appearance-b'),beforeB);
  const filesAfter = snapshot(root), changed = Object.keys(filesBefore).filter(name => filesBefore[name] !== filesAfter[name]);
  assert.deepEqual(Object.keys(filesAfter),Object.keys(filesBefore));
  assert.deepEqual(changed,[path.relative(root,store._file('appearance-a'))]);
});

test('appearance reads and defaults do not migrate or write an old configuration', t => {
  const {root,accountRoot,store} = setup(t), original = snapshot(root), state = new Store(accountRoot).get('appearance-a');
  assert.equal(Object.hasOwn(state.settings,'appearance'),false);
  const normalized = normalizeAppearance(state.settings.appearance);
  assert.deepEqual(normalized,DEFAULTS);
  assert.deepEqual([normalized.importantName,normalized.importantText,normalized.importantBubble],['#860000','#860000','#fcd3d4']);
  normalized.chatBackground = '#000000';
  assert.equal(Object.hasOwn(store.get('appearance-a').settings,'appearance'),false);
  assert.deepEqual(snapshot(root),original);
});

test('partially corrupt legacy appearance falls back in memory without discarding valid colors or rewriting original bytes', t => {
  const {root,accountRoot,store} = setup(t);
  store.update('appearance-a',state => { state.settings.appearance = {chatBackground:'#BAD',memberName:'url(https://example.invalid/x)',importantBubble:'#112233',unexpected:'legacy'}; });
  const before = snapshot(root), state = new Store(accountRoot).get('appearance-a');
  const result = normalizeAppearance(state.settings.appearance);
  assert.deepEqual(result,{...DEFAULTS,chatBackground:'#bbaadd',importantBubble:'#112233',importantText:null});
  assert.deepEqual(snapshot(root),before);
  assert.equal(state.settings.appearance.unexpected,'legacy');
});

test('complete old five-color settings retain every original color and automatic text without any migration write', t => {
  const {root,accountRoot,store} = setup(t);
  const legacy = {chatBackground:'#123456',memberName:'#abcdef',importantName:'#193e32',memberBubble:'#eeeeee',importantBubble:'#244f42'};
  store.update('appearance-a',state => { state.settings.appearance = {...legacy}; });
  const before = snapshot(root), beforeState = store.get('appearance-a');
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = new Store(accountRoot).get('appearance-a'), normalized = normalizeAppearance(state.settings.appearance);
    assert.deepEqual(normalized,{...legacy,importantText:null});
    assert.deepEqual(state,beforeState);
    assert.ok(contrastRatio(getAppearanceTheme(normalized).importantText,legacy.importantBubble) >= 4.5);
    assert.deepEqual(snapshot(root),before);
  }
  save(store,payloadFor(normalizeAppearance(legacy)));
  const after = new Store(accountRoot).get('appearance-a');
  assert.deepEqual(after.settings.appearance,{...legacy,importantText:null});
  assert.deepEqual(withoutAppearance(after),withoutAppearance(beforeState));
});

test('invalid stored important text falls back to automatic in memory without altering old valid colors or bytes', t => {
  const {root,accountRoot,store} = setup(t);
  for (const importantText of [null,'url(https://example.invalid/x)','#ff000080',false,123,{}]) {
    const appearance = {...colors(),importantText};
    store.update('appearance-a',state => { state.settings.appearance = appearance; });
    const before = snapshot(root), state = new Store(accountRoot).get('appearance-a');
    assert.deepEqual(normalizeAppearance(state.settings.appearance),{chatBackground:'#aabbcc',memberName:'#123456',importantName:'#654321',memberBubble:'#ffffff',importantBubble:'#112233',importantText:null});
    assert.deepEqual(snapshot(root),before);
  }
});

test('explicit important text and automatic mode persist across restart while preserving every other setting and reading field', t => {
  const {root,accountRoot,store} = setup(t), before = store.get('appearance-a'), beforeB = store.get('appearance-b');
  for (const [requested,canonical] of [['#A13','#aa1133'],['#860000','#860000'],[null,null]]) {
    save(store,payloadFor({...colors(),importantText:requested}));
    const after = new Store(accountRoot).get('appearance-a');
    assert.equal(after.settings.appearance.importantText,canonical);
    assert.deepEqual(withoutAppearance(after),before);
    assert.deepEqual(new Store(accountRoot).get('appearance-b'),beforeB);
  }
  const persisted = snapshot(root);
  getAppearanceTheme(new Store(accountRoot).get('appearance-a').settings.appearance);
  assert.deepEqual(snapshot(root),persisted);
});

test('explicit low-contrast important text is retained with a warning and auto mode restores readable text without rewriting other choices', t => {
  const {accountRoot,store} = setup(t);
  const appearance = {...DEFAULTS,importantBubble:'#777777',importantText:'#777777'};
  save(store,payloadFor(appearance));
  const explicit = new Store(accountRoot).get('appearance-a').settings.appearance, explicitTheme = getAppearanceTheme(explicit);
  assert.equal(explicit.importantText,'#777777');
  assert.equal(explicitTheme.importantText,'#777777');
  assert.equal(explicitTheme.warnings.find(warning => warning.field === 'importantText')?.contrast,1);
  assert.ok(contrastRatio(explicitTheme.importantLink,explicit.importantBubble) >= 4.5);
  save(store,payloadFor({...explicit,importantText:null}));
  const automatic = new Store(accountRoot).get('appearance-a').settings.appearance, autoTheme = getAppearanceTheme(automatic);
  assert.deepEqual(automatic,{...explicit,importantText:null});
  assert.ok(contrastRatio(autoTheme.importantText,automatic.importantBubble) >= 4.5);
  assert.equal(autoTheme.warnings.some(warning => warning.field === 'importantText'),false);
});

test('low-contrast nicknames remain exactly user-selected and generate warnings instead of silent correction', t => {
  const {accountRoot,store} = setup(t), appearance = {...colors(),chatBackground:'#777777',memberName:'#777777',importantName:'#777777'};
  save(store,payloadFor(appearance));
  const saved = new Store(accountRoot).get('appearance-a').settings.appearance, theme = getAppearanceTheme(saved);
  assert.equal(saved.memberName,'#777777');
  assert.equal(saved.importantName,'#777777');
  assert.deepEqual(theme.warnings.map(warning => warning.field),['memberName','importantName']);
  assert.ok(theme.warnings.every(warning => warning.contrast === 1));
});

test('restoring defaults is an explicit save and preserves unrelated settings and all message state', t => {
  const {accountRoot,store} = setup(t);
  save(store);
  const before = store.get('appearance-a');
  save(store,payloadFor({...DEFAULTS}));
  const after = new Store(accountRoot).get('appearance-a');
  assert.deepEqual(after.settings.appearance,DEFAULTS);
  assert.deepEqual(withoutAppearance(after),withoutAppearance(before));
});

test('returned values and payload changes cannot mutate persisted appearance', t => {
  const {root,store} = setup(t), payload = payloadFor(), result = save(store,payload), persisted = snapshot(root);
  payload.appearance.memberBubble = '#000000';
  result.memberName = '#ffffff';
  assert.deepEqual(snapshot(root),persisted);
  assert.equal(store.get('appearance-a').settings.appearance.memberBubble,'#ffffff');
  assert.equal(store.get('appearance-a').settings.appearance.memberName,'#123456');
});

test('invalid or injected appearance payloads fail before any file changes', t => {
  const {root,store} = setup(t), before = snapshot(root);
  const badPayloads = [null,[],{}, {...payloadFor(),extra:true}, {...payloadFor(),accountId:5}, {...payloadFor(),accountId:'x\0y'},
    payloadFor({...colors(),memberBubble:'#fff; background:url(https://example.invalid/x)'}),payloadFor({...colors(),memberBubble:'var(--other)'}),
    payloadFor({...colors(),memberBubble:'#ffffff80'}),payloadFor({...colors(),memberBubble:'white'}),payloadFor({...colors(),memberBubble:''}),
    payloadFor({...colors(),memberBubble:null}),payloadFor({...colors(),memberBubble:123}),payloadFor({...colors(),unknown:'#fff'}),
    ...['',false,0,'var(--other)','#ffffff80','red','#fff; color: red'].map(importantText => payloadFor({...colors(),importantText})),
    payloadFor(Object.fromEntries(Object.entries(colors()).filter(([key]) => key !== 'importantText'))),
    payloadFor(Object.fromEntries(Object.entries(colors()).filter(([key]) => key !== 'importantName'))),payloadFor([]),
    Object.assign(Object.create({inherited:true}),payloadFor()),payloadFor(Object.assign(Object.create({inherited:true}),colors())),
    payloadFor(JSON.parse('{"__proto__":{"polluted":true},"chatBackground":"#000","memberName":"#000","importantName":"#000","memberBubble":"#fff","importantBubble":"#000"}'))];
  let getterCalls = 0;
  const accessor = {...colors()};Object.defineProperty(accessor,'memberName',{enumerable:true,get(){getterCalls++;return '#fff';}});
  badPayloads.push(payloadFor(accessor));
  for (const payload of badPayloads) {
    assert.throws(() => save(store,payload),{code:'APPEARANCE_INVALID'});
    assert.deepEqual(snapshot(root),before);
  }
  assert.equal(getterCalls,0);
  assert.equal({}.polluted,undefined);
});

test('an old account dialog cannot write to the active account or create an unknown account', t => {
  const {root,store} = setup(t), before = snapshot(root);
  for (const id of ['appearance-b','unknown-account']) {
    assert.throws(() => save(store,payloadFor(colors(),id)),{code:'APPEARANCE_ACCOUNT_CHANGED'});
    assert.deepEqual(snapshot(root),before);
  }
});

test('busy and closing contexts reject saves without changing any persisted bytes', t => {
  const {root,store} = setup(t), before = snapshot(root);
  for (const [field,code] of [['busy','APPEARANCE_BUSY'],['closing','APPEARANCE_CLOSING']]) {
    assert.throws(() => save(store,payloadFor(),() => ({...contextFor(),[field]:true})),{code});
    assert.deepEqual(snapshot(root),before);
  }
});

test('account or epoch changes after initial context capture reject before Store.update', t => {
  const {root,store} = setup(t), before = snapshot(root);
  for (const changed of [{accountId:'appearance-b'},{epoch:8}]) {
    let calls = 0, updates = 0;
    const wrapped = {update(){updates++;throw new Error('must not reach storage');}};
    assert.throws(() => save(wrapped,payloadFor(),() => ++calls === 1 ? contextFor() : {...contextFor(),...changed}),{code:'APPEARANCE_ACCOUNT_CHANGED'});
    assert.equal(updates,0);
    assert.deepEqual(snapshot(root),before);
  }
  assert.deepEqual(store.get('appearance-a').settings, new Store(path.join(root,'accounts')).get('appearance-a').settings);
});

test('a reused mutable context still captures the original owner epoch rather than following its mutation', t => {
  const {root,store} = setup(t), before = snapshot(root), context = contextFor();
  let calls = 0;
  assert.throws(() => save(store,payloadFor(),() => {if (++calls > 1) context.epoch = 8;return context;}),{code:'APPEARANCE_ACCOUNT_CHANGED'});
  assert.deepEqual(snapshot(root),before);
});

test('context guards are rechecked inside the real Store transaction before modifying a state', t => {
  const {root,store} = setup(t), before = snapshot(root);
  for (const [change,code] of [[{accountId:'appearance-b'},'APPEARANCE_ACCOUNT_CHANGED'],[{epoch:8},'APPEARANCE_ACCOUNT_CHANGED'],[{busy:true},'APPEARANCE_BUSY'],[{closing:true},'APPEARANCE_CLOSING']]) {
    let context = contextFor();
    const wrapped = {update(id,mutator){context={...context,...change};return store.update(id,mutator);}};
    assert.throws(() => save(wrapped,payloadFor(),() => ({...context})),{code});
    assert.deepEqual(snapshot(root),before);
  }
});

test('storage failure is propagated with no optimistic result or additional settings writes', t => {
  const {root,store} = setup(t), before = snapshot(root), failure = new Error('Synthetic persistence failure');
  let writes = 0;
  const wrapped = {update(){writes++;throw failure;}};
  assert.throws(() => save(wrapped),error => error === failure);
  assert.equal(writes,1);
  assert.deepEqual(snapshot(root),before);
  assert.equal(Object.hasOwn(store.get('appearance-a').settings,'appearance'),false);
});

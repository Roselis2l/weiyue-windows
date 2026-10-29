'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store,normalizeMessage}=require('../app/core/store.cjs');
const {normalizeMessages}=require('../app/core/weibo.cjs');
const {recallOf,NOTICE}=require('../app/core/message-recalls.cjs');
const {resolveNotionSource}=require('../app/core/notion.cjs');
const START=Date.parse('2026-10-21T09:00:00+08:00');
const secret='SYNTHETIC_WITHDRAWN_ORIGINAL_49382';
const message=(id='9007199254740993101',extra={})=>({id,groupId:'g',senderId:'u',senderName:'合成成员',text:secret,time:START,...extra});
const notice=(id,extra={})=>message(id,{time:START+99999,text:'official notice',contextVersion:1,systemNotice:{kind:'weibo-system',type:344,subType:101},...extra});
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-recall-public-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root);store.ensureAccount({id:'a',kind:'import',name:'合成账号'});store.mergeMessages('a',[{id:'g',name:'合成群'},{id:'h',name:'合成群二'}],[]);return{store,root};}

test('only verified group withdrawal structures classify; user text and generic notices do not',()=>{
  assert.equal(recallOf(message('1',{text:'某人撤回了一条消息'})),null);
  for(const [type,subType] of [[321,101],[331,0],[344,999],[0,101]])assert.equal(recallOf(message('1',{systemNotice:{kind:'weibo-system',type,subType}})),null);
  for(const subType of [101,331])assert.equal(recallOf(notice('1',{systemNotice:{kind:'weibo-system',type:344,subType}})).state,'withdrawn');
});
test('official history normalization scrubs stale media before rich-media parsing',()=>{
  const result=normalizeMessages({messages:[{mid:'9007199254740993101',gid:'8',from_uid:'2',content:secret,created_at:new Date(START).toUTCString(),type:344,sub_type:101,from_user:{screen_name:'合成成员'},attachments:{invalid:true},pic_ids:['private']}]},'8')[0];
  assert.equal(result.recall.state,'withdrawn');assert.equal(result.text,NOTICE);assert.equal(result.images,undefined);assert.equal(result.attachments,undefined);
});
test('recall strips original content atomically and keeps message ID, time, anchors and unread',t=>{
  const {store}=setup(t),one=message();store.mergeMessages('a',[],[one]);store.setReadPosition('a','g',one.id,{offset:29,seenId:one.id});
  const before=store.getReadStats('a','g');assert.equal(store.mergeMessages('a',[],[notice(one.id)]),0);
  const after=store.getReadStats('a','g');assert.deepEqual(after,before);
  const saved=store.get('a').messages[0];assert.equal(saved.time,one.time);assert.equal(saved.text,NOTICE);assert.equal(store.get('a').schemaVersion,4);
  assert.equal(JSON.stringify(saved).includes(secret),false);
});
test('repeat or late original pages cannot revive a withdrawn row or increase unread',t=>{
  const {store,root}=setup(t);store.mergeMessages('a',[],[message()]);store.mergeMessages('a',[],[notice(message().id)]);const epoch=store.contentEpoch('a');
  const reopened=new Store(root);reopened.mergeMessages('a',[],[message(),notice(message().id)]);
  assert.equal(reopened.contentEpoch('a'),epoch);assert.equal(reopened.queryMessages('a',{keyword:secret}).total,0);assert.equal(reopened.getReadStats('a','g').unreadCount,0);
});
test('missing originals create safe placeholders and never borrow another group or account',t=>{
  const {store}=setup(t);store.ensureAccount({id:'b',kind:'import',name:'合成账号二'});store.mergeMessages('b',[{id:'g',name:'合成群'}],[message()]);
  store.mergeMessages('a',[],[message(undefined,{groupId:'h'}),notice(message().id)]);
  assert.equal(store.queryMessages('a',{groupId:'g'}).messages[0].recall.originalAvailable,false);assert.equal(store.queryMessages('a',{groupId:'h'}).messages[0].text,secret);assert.equal(store.queryMessages('b').messages[0].text,secret);
});
test('public projections hide opaque local data before search, bookmarks, summaries and Notion source',t=>{
  const {store}=setup(t);store.mergeMessages('a',[],[message()]);const bookmark=store.bookmark('a',{groupId:'g',messageIds:[message().id],note:secret,tags:[secret]});
  store.update('a',state=>{state.messages[0].editionData={opaque:secret};state.summaries.push({id:'s',title:secret,body:secret,groupId:'g',start:START,end:START+60000,refs:[{groupId:'g',id:message().id,text:secret}],mode:'local',createdAt:START});state.exports.e={summaryId:'s',draft:{body:secret},status:'partial'};});
  store.mergeMessages('a',[],[notice(message().id)]);const visible=store.getVisible('a');
  assert.equal(JSON.stringify(visible).includes(secret),false);assert.equal(store.bookmarks('a',{keyword:secret}).length,0);assert.equal(store.queryMessages('a',{keyword:secret}).total,0);
  assert.equal(JSON.stringify(resolveNotionSource(visible,{summaryId:'s'})).includes(secret),false);assert.equal(JSON.stringify(resolveNotionSource(visible,{bookmarkIds:[bookmark.id]})).includes(secret),false);
  assert.equal(store.get('a').messages[0].editionData.opaque,secret);
});
test('legacy structured withdrawal projection is read-only; no schema migration on open',t=>{
  const {store}=setup(t);const file=store._file('a'),raw=JSON.parse(fs.readFileSync(file,'utf8'));raw.messages=[notice(message().id)];raw.schemaVersion=1;fs.writeFileSync(file,JSON.stringify(raw));const bytes=fs.readFileSync(file);
  assert.equal(store.getVisible('a').messages[0].text,NOTICE);assert.equal(store.get('a').schemaVersion,1);assert.deepEqual(fs.readFileSync(file),bytes);
});
test('sync/import cannot inject opaque stored payloads and malformed recall fails atomically',t=>{
  const {store}=setup(t);store.mergeMessages('a',[],[message(undefined,{editionData:{opaque:'untrusted'}})]);assert.equal(store.get('a').messages[0].editionData,undefined);
  const bytes=fs.readFileSync(store._file('a'));assert.throws(()=>store.mergeMessages('a',[],[message(undefined,{recall:{state:'withdrawn',protocol:'guess',observedAt:START}})]));assert.deepEqual(fs.readFileSync(store._file('a')),bytes);
});
test('permanent tombstones dominate recall and old imports; schema never downgrades',t=>{
  const {store}=setup(t);store.mergeMessages('a',[],[message()]);store.mergeMessages('a',[],[notice(message().id)]);
  const selection={groupId:'g',startMinute:'2026-10-21T09:00',endMinute:'2026-10-21T09:00',retainSenderIds:[],retainSummaryRanges:false,mode:'permanent'};
  const preview=store.previewMessageCleanup('a',selection);assert.equal(preview.deleteCount,1);store.applyMessageCleanup('a',selection,preview.fingerprint);
  store.mergeMessages('a',[],[message(),notice(message().id)]);assert.equal(store.get('a').messages.length,0);assert.equal(store.get('a').schemaVersion,4);assert.equal(store.get('a').messageTombstones.length,1);
});
test('cleanup preview exposes safe text while maintaining the raw-state confirmation fingerprint',t=>{
  const {store}=setup(t);store.mergeMessages('a',[],[notice(message().id)]);store.update('a',state=>{state.messages[0].editionData={opaque:secret};});
  const selection={groupId:'g',startMinute:'2026-10-21T09:00',endMinute:'2026-10-21T09:02',retainSenderIds:[],retainSummaryRanges:false};
  const preview=store.previewMessageCleanup('a',selection);assert.equal(JSON.stringify(preview).includes(secret),false);assert.equal(store.applyMessageCleanup('a',selection,preview.fingerprint).deletedCount,1);
});
test('visible snapshots are immutable, isolated and invalidated by successful writes',t=>{
  const {store}=setup(t);store.mergeMessages('a',[],[message()]);const a=store.getVisibleSnapshot('a');assert.equal(store.getVisibleSnapshot('a'),a);assert.throws(()=>{a.messages[0].text='bad';});
  store.mergeMessages('a',[],[notice(message().id)]);const b=store.getVisibleSnapshot('a');assert.notEqual(a,b);const copy=store.getVisible('a');copy.messages[0].text='bad';assert.equal(store.getVisibleSnapshot('a').messages[0].text,NOTICE);
});
test('content epoch hashes each immutable snapshot once and recomputes only after a state change',t=>{
  const {store}=setup(t);store.mergeMessages('a',[],[message()]);
  const policy=require('../app/core/edition-policy.cjs'),original=policy.contentEpoch;let calls=0;
  policy.contentEpoch=state=>{calls++;return original(state);};
  try{
    const before=store.contentEpoch('a');for(let i=0;i<20;i++)assert.equal(store.contentEpoch('a'),before);assert.equal(calls,1);
    store.mergeMessages('a',[],[notice(message().id)]);const after=store.contentEpoch('a');assert.notEqual(after,before);assert.equal(calls,2);
    for(let i=0;i<20;i++)assert.equal(store.contentEpoch('a'),after);assert.equal(calls,2);
  }finally{policy.contentEpoch=original;}
});

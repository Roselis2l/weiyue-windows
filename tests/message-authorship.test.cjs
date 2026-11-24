'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store,filterMessages}=require('../app/core/store.cjs');
const {stableSenderId,classifyMessageAuthorship,authoredSenderId,isMemberAuthoredMessage}=require('../app/core/message-authorship.cjs');
const retained=require('../app/edition.json').id==='retained';
const START=Date.parse('2026-11-23T00:00:00+08:00'),A='9007199254740993101',B='9007199254740993102';
const notice={kind:'weibo-system',type:321,subType:101};
const recall={state:'withdrawn',protocol:'weibo-group-344',observedAt:START+1000};
const message=(id,overrides={})=>({id:String(id),groupId:'g',senderId:A,senderName:'Same name',time:START+Number(id),text:'Synthetic content',...overrides});
const withdrawal=id=>message(id,{text:'Synthetic withdrawal notice',systemNotice:{kind:'weibo-system',type:344,subType:331}});
const ids=rows=>rows.map(m=>m.id);
function setup(t){
  const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'weiyue-authorship-test-'));
  t.after(()=>{const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),parent.toLowerCase());assert.ok(path.basename(resolved).startsWith('weiyue-authorship-test-'));fs.rmSync(resolved,{recursive:true,force:true});});
  const store=new Store(root);store.ensureAccount({id:'synthetic',kind:'import',name:'Synthetic account'});
  store.mergeMessages('synthetic',[{id:'g',name:'Synthetic group'},{id:'h',name:'Other synthetic group'}],[],{history:true});
  return{store,root};
}

test('stable authors use exact normalized IDs, never names or unknown placeholders',()=>{
  for(const value of [null,undefined,'',' ',0,'0',A+' ',123,Number.MAX_SAFE_INTEGER+1,'unknown:123','bad\u0000id'])assert.equal(stableSenderId(value),null);
  assert.equal(stableSenderId(A),A);assert.equal(stableSenderId('member-a'),'member-a');
  for(const senderName of ['Same name','粉丝群','微博系统',''])assert.equal(authoredSenderId(message(1,{senderName})),A);
  const sameName=[message(1),message(2,{senderId:B})];
  assert.deepEqual(ids(filterMessages(sameName,{senderIds:[A]})),['1']);
  assert.deepEqual(ids(filterMessages(sameName,{senderIds:[B]})),['2']);
  assert.deepEqual(filterMessages(sameName,{senderIds:['Same name']}),[]);
});

test('official system metadata excludes associated member IDs from all member filters only',()=>{
  const rows=[message(1),message(2,{systemNotice:notice}),withdrawal(3),message(4,{senderId:'unknown:4'}),message(5,{senderId:''})];
  assert.deepEqual(ids(filterMessages(rows,{})),['1','2','3','4','5']);
  assert.deepEqual(ids(filterMessages(rows,{senderIds:[]})),['1','2','3','4','5']);
  for(const query of [{senderId:A},{senderIds:[A]},{importantOnly:true},{senderId:A,senderIds:[A,B],importantOnly:true}]){
    assert.deepEqual(ids(filterMessages(rows,query,[A,'unknown:4'])),['1']);
  }
  assert.deepEqual(filterMessages(rows,{senderIds:['unknown:4']}),[]);
  assert.deepEqual(classifyMessageAuthorship(rows[1]),{messageType:'system-notice',senderId:null,associatedSenderId:A,withdrawn:false,originalAvailable:false,authored:false});
  assert.equal(classifyMessageAuthorship(rows[2]).messageType,'withdrawn-unavailable');
});

test('member replies and forwards retain their own author without adopting quoted identities',()=>{
  const rows=[message(1,{quote:{senderId:B,text:'Synthetic quoted member'},references:[{author:B,senderId:B}]}),
    message(2,{sharedPost:{author:B,senderId:B},text:'Synthetic forwarded post'}),
    message(3,{senderId:B,quote:{senderId:A},references:[{author:A,senderId:A}]})];
  assert.deepEqual(ids(filterMessages(rows,{senderIds:[A]})),['1','2']);
  assert.deepEqual(ids(filterMessages(rows,{senderIds:[B]})),['3']);
  assert.equal(authoredSenderId(rows[0]),A);assert.equal(authoredSenderId(rows[1]),A);
});

test('retained visible originals follow original identity and type; placeholders never inspect hidden archives',()=>{
  const original=message(1,{recall:{...recall,originalAvailable:true},recalledMediaLocalOnly:true});
  assert.deepEqual(classifyMessageAuthorship(original),{messageType:'member-message',senderId:A,associatedSenderId:null,withdrawn:true,originalAvailable:true,authored:true});
  assert.equal(authoredSenderId({...original,systemNotice:notice}),null);
  for(const record of [withdrawal(1),{...original,recall:{...recall,originalAvailable:false}},
    {...original,localDeletion:{batchId:'synthetic'}},{...original,contentUnavailable:true},
    {...withdrawal(1),recall:{...recall,originalAvailable:true}}])assert.equal(isMemberAuthoredMessage(record),false);
  const hidden=withdrawal(2);Object.defineProperty(hidden,'editionData',{get(){throw new Error('Private archive must never be read');}});
  assert.equal(authoredSenderId(hidden),null);
  assert.equal(authoredSenderId(message(3,{recall:{state:'withdrawn',protocol:'invalid',observedAt:START,originalAvailable:true}})),null);
});

test('synthetic 277 associations resolve to 255 retained authors or 254 public authors without writes',t=>{
  const {store,root}=setup(t);
  const originals=Array.from({length:255},(_,i)=>message(i+1));
  const notices=Array.from({length:20},(_,i)=>message(i+256,{systemNotice:notice}));
  store.mergeMessages('synthetic',[],[...originals,...notices],{history:true});
  store.mergeMessages('synthetic',[],[withdrawal(255),withdrawal(276),withdrawal(277)],{history:true});
  store.setReadPosition('synthetic','g','1',{seenId:'1',offset:13,followTail:false});
  store.setImportant('synthetic',A,true);
  const before=store.get('synthetic'),beforeStats=store.getReadStats('synthetic','g'),bytes=fs.readFileSync(store._file('synthetic'));
  assert.equal(before.messages.length,277);
  assert.equal(store.queryMessages('synthetic',{groupId:'g'}).total,277);
  for(const query of [{senderId:A},{senderIds:[A]},{importantOnly:true}]){
    assert.equal(store.queryMessages('synthetic',{...query,groupId:'g',start:START,end:START+86400000}).total,retained?255:254);
  }
  const visible=store.getVisibleSnapshot('synthetic').messages;
  assert.equal(visible.filter(m=>!m.recall&&isMemberAuthoredMessage(m)).length,254);
  assert.equal(visible.filter(m=>classifyMessageAuthorship(m).messageType==='system-notice').length,20);
  assert.equal(visible.filter(m=>classifyMessageAuthorship(m).messageType==='withdrawn-unavailable').length,retained?2:3);
  assert.equal(new Store(root).queryMessages('synthetic',{groupId:'g',senderIds:[A]}).total,retained?255:254);
  assert.deepEqual(store.getReadStats('synthetic','g'),beforeStats);assert.deepEqual(store.get('synthetic'),before);
  assert.deepEqual(fs.readFileSync(store._file('synthetic')),bytes);
});

test('stored original author wins over withdrawal association and stays account and group isolated',t=>{
  const {store}=setup(t);
  store.mergeMessages('synthetic',[],[message(1,{senderId:B}),message(1,{groupId:'h'})],{history:true});
  store.mergeMessages('synthetic',[],[withdrawal(1)],{history:true});
  store.ensureAccount({id:'second',kind:'import',name:'Second synthetic account'});
  store.mergeMessages('second',[{id:'g',name:'Synthetic group'}],[message(1)],{history:true});
  assert.equal(store.queryMessages('synthetic',{groupId:'g',senderIds:[A]}).total,0);
  assert.equal(store.queryMessages('synthetic',{groupId:'g',senderIds:[B]}).total,retained?1:0);
  assert.equal(store.queryMessages('synthetic',{groupId:'h',senderIds:[A]}).total,1);
  assert.equal(store.queryMessages('second',{groupId:'g',senderIds:[A]}).total,1);
});

test('reading filter classification does not weaken cleanup member-retention protection',t=>{
  const {store}=setup(t);store.mergeMessages('synthetic',[],[message(1,{systemNotice:notice}),message(2,{senderId:B})],{history:true});
  const selection={groupId:'g',startMinute:'2026-11-23T00:00',endMinute:'2026-11-23T00:00',retainSenderIds:[A],retainSummaryRanges:false};
  const before=fs.readFileSync(store._file('synthetic'));
  assert.equal(store.queryMessages('synthetic',{groupId:'g',senderIds:[A]}).total,0);
  const preview=store.previewMessageCleanup('synthetic',selection);
  assert.equal(preview.reasonCounts.retainedMember,1);
  assert.deepEqual(fs.readFileSync(store._file('synthetic')),before);
});

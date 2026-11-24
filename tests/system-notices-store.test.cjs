'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store,normalizeMessage}=require('../app/core/store.cjs');
const message=(id,extra={})=>({id,groupId:'g',senderId:'s',senderName:'粉丝群',text:'合成系统通知原文',time:1000,...extra});
const notice={kind:'weibo-system',type:321,subType:101};
test('notice evidence survives restart, re-sync and bookmark enrichment without changing raw text',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-notice-store-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new Store(root);store.ensureAccount({id:'test-notice',name:'合成账号',kind:'import'});
  store.mergeMessages('test-notice',[{id:'g',name:'合成群'}],[message('9007199254741190001',{systemNotice:notice}),message('9007199254741190002')],{history:true});
  store.bookmark('test-notice',{groupId:'g',messageIds:['9007199254741190001'],note:'合成备注',tags:[]});
  store.mergeMessages('test-notice',[],[message('9007199254741190001')],{history:true});
  const reopened=new Store(root),records=reopened.get('test-notice').messages;
  assert.deepEqual(records[0].systemNotice,notice);assert.equal(records[0].text,'合成系统通知原文');assert.equal(records[1].systemNotice,undefined);
  assert.deepEqual(reopened.bookmarks('test-notice')[0].messages[0].systemNotice,notice);
});
test('member name and group label alone cannot make a stored message a system notice',()=>{
  for(const senderName of ['粉丝群','微博','微博系统'])assert.equal(normalizeMessage(message('1',{senderName})).systemNotice,undefined);
  assert.throws(()=>normalizeMessage(message('1',{systemNotice:{kind:'weibo-system',type:321,subType:0}})));
  assert.throws(()=>normalizeMessage(message('1',{systemNotice:true})));
});

test('verified quote context persists and refresh clears stale metadata without altering reading or raw text',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-context-store-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new Store(root),id='test-context';store.ensureAccount({id,name:'Synthetic',kind:'import'});
  const quotePreview={kind:'image',state:'unavailable',reasonCode:'WEB_REFERENCE_TARGET_UNAVAILABLE'};
  store.mergeMessages(id,[{id:'g',name:'Synthetic'}],[message('1',{contextVersion:1,quotePreview}),message('2')],{history:true});
  store.setReadPosition(id,'g','1',{offset:19,followTail:false,seenId:'1'});
  store.mergeMessages(id,[],[message('3')]);const before=store.getReadStats(id,'g');
  store.mergeMessages(id,[],[message('1')],{history:true});
  assert.deepEqual(new Store(root).get(id).messages[0].quotePreview,quotePreview);
  store.mergeMessages(id,[],[message('1',{contextVersion:1,systemNotice:notice})],{history:true});
  let current=new Store(root).get(id).messages[0];assert.equal(current.quotePreview,undefined);assert.deepEqual(current.systemNotice,notice);
  store.mergeMessages(id,[],[message('1',{contextVersion:1})],{history:true});
  current=new Store(root).get(id).messages[0];assert.equal(current.systemNotice,undefined);assert.equal(current.quotePreview,undefined);
  assert.equal(current.text,message('1').text);assert.deepEqual(store.getReadStats(id,'g'),before);
  assert.throws(()=>normalizeMessage(message('1',{contextVersion:2})));
  assert.throws(()=>normalizeMessage(message('1',{quotePreview:{kind:'image',state:'ready'}})));
});

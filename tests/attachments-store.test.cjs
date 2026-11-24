'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store,normalizeMessage}=require('../app/core/store.cjs');
const {normalizeMessages,parsePrecisionJson}=require('../app/core/weibo.cjs');
const {sourceUrl}=require('../app/core/attachments.cjs');
const fid='900719925474099399999';
const pending={kind:'file',fid,state:'needs-metadata',name:'文件消息'};
const ready={kind:'pdf',fid,state:'ready',name:'中文研究报告.pdf',mime:'application/pdf',url:sourceUrl(fid)};
const message=(extra={})=>({id:'10',groupId:'g',senderId:'u',senderName:'甲',text:'文件消息',time:1000,...extra});
test('official file and video types retain lexical FIDs without becoming images',()=>{
  const raw=parsePrecisionJson('{"messages":[{"id":10,"gid":2,"from_uid":3,"content":"文件消息","time":1000,"media_type":5,"fids":900719925474099399999}]}');
  // Actual official messages contain an array; preserve the parser's exact string.
  raw.messages[0].fids=[raw.messages[0].fids];
  const value=normalizeMessages(raw,'2')[0];
  assert.equal(value.attachments[0].fid,fid);assert.equal(value.attachments[0].kind,'file');
  assert.equal(value.attachmentVersion,1);assert.equal(value.images,undefined);
  raw.messages[0].media_type=10;
  assert.equal(normalizeMessages(raw,'2')[0].attachments[0].kind,'video');
});
test('invalid attachments fail before storage and old messages remain compatible',()=>{
  assert.equal(normalizeMessage(message()).attachments,undefined);
  assert.throws(()=>normalizeMessage(message({attachmentVersion:2})));
  for(const attachment of [{...ready,url:'file:///tmp/private.pdf'},{...ready,fid:Number.MAX_SAFE_INTEGER+1},{...ready,mime:'text/html',kind:'video'}])
    assert.throws(()=>normalizeMessage(message({attachments:[attachment]})));
});
test('metadata enrichment survives restart and does not move reading position or create unread rows',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-attachment-store-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new Store(root);store.ensureAccount({id:'a',name:'A',kind:'import'});store.ensureAccount({id:'b',name:'B',kind:'import'});
  store.mergeMessages('a',[{id:'g',name:'群'}],[message({attachmentVersion:1,attachments:[pending]}),message({id:'11',time:2000,text:'下一条'})]);
  store.mergeMessages('b',[{id:'g',name:'群'}],[message({attachments:[pending]})]);
  store.setReadPosition('a','g','10',{offset:14,seenId:'10',followTail:false});
  const before=store.get('a'),stats=store.getReadStats('a','g');
  store.mergeMessages('a',[],[message({attachmentVersion:1,attachments:[ready]})],{history:true});
  const after=new Store(root).get('a');
  assert.deepEqual(after.readPositions,before.readPositions);assert.deepEqual(store.getReadStats('a','g'),stats);
  assert.equal(after.messages[0].attachments[0].name,'中文研究报告.pdf');
  assert.equal(store.queryMessages('a',{groupId:'g',keyword:'研究报告'}).messages[0].id,'10');
  assert.equal(store.queryMessages('b',{groupId:'g',keyword:'研究报告'}).messages.length,0);
  store.mergeMessages('a',[],[message({attachments:[pending]})],{history:true});
  assert.equal(store.get('a').messages[0].attachments[0].state,'ready');
});

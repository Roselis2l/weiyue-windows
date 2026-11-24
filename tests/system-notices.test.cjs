'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classifySystemNotice,normalizeSystemNotice}=require('../app/core/system-notices.cjs');
const {normalizeMessages}=require('../app/core/weibo.cjs');

test('official group notice protocol types produce compact metadata independently of sender display name',()=>{
  for(const type of [323,324,327,331,332,333,335,341,342,344,345,407,421,425,429,499]){
    const result=classifySystemNotice({type,sub_type:0,from_user:{screen_name:'任意合成名称'}});
    assert.deepEqual(result,{kind:'weibo-system',type,subType:0});
    assert.deepEqual(normalizeSystemNotice(result),result);
  }
});
test('normal members in fan groups, same-name members and regular image messages remain ordinary',()=>{
  for(const name of ['粉丝群','微博','微博系统','合成成员'])for(const media_type of [0,1,2,3]){
    assert.equal(classifySystemNotice({type:321,sub_type:0,media_type,from_user:{screen_name:name},group_name:'合成粉丝群'}),undefined);
    assert.equal(classifySystemNotice({media_type,from_user:{screen_name:name},group_name:'合成粉丝群'}),undefined);
  }
});
test('official template, subtype and DM special cases follow the explicit notice predicate',()=>{
  assert.deepEqual(classifySystemNotice({sub_type:101}),{kind:'weibo-system',type:0,subType:101});
  assert.deepEqual(classifySystemNotice({type:321,sub_type:101}),{kind:'weibo-system',type:321,subType:101});
  assert.deepEqual(classifySystemNotice({type:'321',sub_type:'3'}),{kind:'weibo-system',type:321,subType:3});
  assert.deepEqual(classifySystemNotice({type:321,sub_type:0,dm_type:9}),{kind:'weibo-system',type:321,subType:0,dmType:9});
  assert.equal(classifySystemNotice({type:321,dm_type:9}),undefined);
  assert.equal(classifySystemNotice({type:321,sub_type:undefined,dm_type:9}),undefined);
  for(const dm_type of [0,1,2,12])assert.equal(classifySystemNotice({type:321,sub_type:0,dm_type}),undefined);
});
test('malformed, unsafe, fractional and out-of-range metadata cannot classify a notice',()=>{
  for(const type of [null,true,false,[],{},-1,0.5,Infinity,NaN,1000000,Number.MAX_SAFE_INTEGER+1,'0321','3e2','344.0','<script>'])assert.equal(classifySystemNotice({type,sub_type:0}),undefined);
  for(const bad of [null,true,[],{},-1,0.1,'1e2','000',1000000]){
    assert.equal(classifySystemNotice({type:344,sub_type:bad}),undefined);
    assert.equal(classifySystemNotice({type:344,sub_type:0,dm_type:bad}),undefined);
  }
  for(const bad of [null,[],{},'notice'])assert.equal(classifySystemNotice(bad),undefined);
});
test('persisted notification marker requires valid protocol evidence and strips unrelated fields',()=>{
  assert.deepEqual(normalizeSystemNotice({kind:'weibo-system',type:344,subType:0,label:'untrusted',url:'javascript:x',senderName:'合成'}),{kind:'weibo-system',type:344,subType:0});
  for(const bad of [null,true,[],{}, {kind:'weibo-system'}, {kind:'weibo-system',type:321,subType:0}, {kind:'weibo-system',type:0,subType:0}, {kind:'unknown',type:344,subType:0}, {kind:'weibo-system',type:344,subType:0,dmType:undefined}])assert.throws(()=>normalizeSystemNotice(bad),TypeError);
});
test('wire normalizer preserves system metadata without altering original text, time, IDs or sender identity',()=>{
  const raw={id:'9007199254740993555',gid:'91',from_uid:'72',from_user:{id:'72',screen_name:'粉丝群'},time:1792544400,content:'合成系统通知\n完整第二行',type:323,sub_type:101};
  const [message]=normalizeMessages({messages:[raw]},'91');
  assert.deepEqual(message.systemNotice,{kind:'weibo-system',type:323,subType:101});
  assert.equal(message.id,raw.id);assert.equal(message.senderId,raw.from_uid);assert.equal(message.text,raw.content);assert.equal(message.time,raw.time*1000);
  const [ordinary]=normalizeMessages({messages:[{...raw,type:321,sub_type:0}]},'91');
  assert.equal(ordinary.systemNotice,undefined);assert.equal(ordinary.text,raw.content);
});

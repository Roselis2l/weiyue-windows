'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {refreshGroupAvatars}=require('../app/core/avatar-refresh.cjs');
test('optional avatar transport failure leaves messages free to synchronize, with no avatar writes',async()=>{
  for(const code of ['NETWORK','TIMEOUT','SERVER_ERROR']){
    let writes=0,messages=0;
    const client={groups:async()=>{throw Object.assign(new Error('private detail'),{code});},syncGroup:async()=>{messages++;}};
    assert.deepEqual(await refreshGroupAvatars({client,store:{mergeMessages:()=>writes++},groups:[]}),{updated:0,deferred:true});
    await client.syncGroup();assert.equal(messages,1);assert.equal(writes,0);
  }
});
test('avatar metadata refusal, risk, malformed response and cancellation cannot be skipped',async()=>{
  for(const code of ['AUTH_REQUIRED','ACCESS_DENIED','RATE_LIMIT','RISK_CONTROL','PAGE_SOURCE_REJECTED','API_ERROR','INVALID_RESPONSE','ABORTED',undefined]){
    const failure=Object.assign(new Error('private detail'),{code});
    await assert.rejects(refreshGroupAvatars({client:{groups:async()=>{throw failure;}},groups:[]}),e=>e===failure);
  }
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(refreshGroupAvatars({client:{groups:async()=>{calls++;}},signal:controller.signal}),{code:'ABORTED'});
  assert.equal(calls,0);
});
test('manual avatar refresh persists only selected explicit IDs and notifies once without replacing other metadata',async()=>{
  const groups=[{id:'1',selected:true,name:'原群',nextCursor:'2'},{id:'2',selected:false,name:'其他群'}],writes=[];let changed=0;
  const result=await refreshGroupAvatars({client:{groups:async()=>groups.map(g=>({...g,avatarUrl:'https://wx1.sinaimg.cn/avatar.png'}))},
    groups,accountId:'one',store:{mergeMessages:(...args)=>writes.push(args)},onChange:()=>changed++});
  assert.deepEqual(result,{updated:1,deferred:false});assert.equal(changed,1);
  assert.deepEqual(writes[0],['one',[{...groups[0],avatarUrl:'https://wx1.sinaimg.cn/avatar.png'}],[],{history:true}]);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {AccountSessionRegistry}=require('../app/core/account-session.cjs');
const {AutoSync}=require('../app/core/auto-sync.cjs');
const {sessionStatus}=require('../app/renderer/sync-status.js');
const {officialUrl}=require('../app/core/security.cjs');
const cookie={domain:'.weibo.com',name:'sample',value:'SYNTHETIC_ONLY',path:'/'};
const expired=1, valid=4102444800;
function make(readCookies,set){
 const created=[];
 const registry=new AccountSessionRegistry({readCookies,officialUrl,createSession:()=>{
  const s={i:created.length,cookies:{set:item=>set(s,item)}};created.push(s);return s;
 }});
 return {created,registry};
}
test('empty, expired or non-official snapshots never construct or cache an empty session',async()=>{
 for(const list of [[],[{...cookie,expirationDate:expired}],[{...cookie,domain:'weibo.com.invalid'}]]){
  const {registry,created}=make(()=>list,()=>assert.fail('invalid cookie offered to Chromium'));
  assert.equal(registry.hasUsableSnapshot(list),false);
  await assert.rejects(registry.restore('test'),e=>e.code==='SESSION_SNAPSHOT_MISSING'&&!e.message.includes(cookie.value));
  assert.equal(registry.status('test'),'missing');assert.equal(registry.sessions.size,0);assert.equal(created.length,0);
 }
});
test('zero accepted keeps no failed cache, next caller retries exactly once, accounts stay independent',async()=>{
 const {registry,created}=make(()=>[{...cookie,expirationDate:valid}],async (s,item)=>{
  assert.equal(item.expirationDate,valid);
  if(s.i===0)throw Error(cookie.value);
 });
 await assert.rejects(registry.restore('a'),e=>e.code==='SESSION_RESTORE_TEMPORARY'&&!e.message.includes(cookie.value));
 assert.equal(registry.status('a'),'temporary');assert.equal(registry.sessions.size,0);assert.equal(created.length,1);
 const a=await registry.restore('a'),b=await registry.restore('b');
 assert.notEqual(a,b);assert.equal(created.length,3);
 assert.equal(registry.status('a'),'restored');
 registry.markVerified('a',b);assert.equal(registry.status('a'),'restored');
 registry.markVerified('a',a);assert.equal(registry.status('a'),'verified');assert.equal(registry.status('b'),'restored');
 assert.equal(await registry.restore('a'),a);
});
test('partial restore is not official identity verification; manual adoption and logout update status',async()=>{
 const {registry}=make(()=>[{...cookie,name:'fail'},cookie],async (_s,item)=>{if(item.name==='fail')throw Error('synthetic');});
 const session=await registry.restore('a');assert.ok(session);assert.equal(registry.status('a'),'restored');
 registry.adopt('a',{});assert.equal(registry.status('a'),'verified');registry.invalidate('a');assert.equal(registry.status('a'),'');
});
test('UI does not equate saved snapshots with authentication and platform errors dominate local status',()=>{
 assert.match(sessionStatus({},true).text,/尚未验证/);assert.match(sessionStatus({localSessionStatus:'restored'},true).text,/尚未验证/);
 assert.match(sessionStatus({localSessionStatus:'verified',errorCode:'AUTH_REQUIRED'},true).text,/微博已要求/);
 assert.match(sessionStatus({localSessionStatus:'verified',errorCode:'ACCESS_DENIED'},true).text,/官方页面/);
 assert.match(sessionStatus({localSessionStatus:'temporary'},true).text,/暂未恢复/);
 assert.match(sessionStatus({localSessionStatus:'missing'},false).text,/没有可用/);
});
test('existing sync policy retries temporary locally, stops missing separately and does not clear real risk block',()=>{
 const fake={now:()=>1,run:async()=>{},setTimer:()=>0,clearTimer:()=>{}};
 const s=new AutoSync(fake);
 s.recordFailure({code:'SESSION_RESTORE_TEMPORARY'});assert.equal(s.status().errorCode,'SESSION_RESTORE_TEMPORARY');assert.equal(!!s.status().blocked,false);
 s.recordFailure({code:'SESSION_SNAPSHOT_MISSING'});assert.equal(s.status().errorCode,'SESSION_SNAPSHOT_MISSING');assert.equal(!!s.status().blocked,true);
 s.authenticationRestored({enabled:false});assert.equal(!!s.status().blocked,false);assert.equal(s.status().enabled,false);
 s.recordFailure({code:'RISK_CONTROL'});s.authenticationRestored({enabled:false});assert.equal(s.status().errorCode,'RISK_CONTROL');assert.equal(!!s.status().blocked,true);
});

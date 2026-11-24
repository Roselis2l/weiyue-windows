'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AutoSync}=require('../app/core/auto-sync.cjs');
const {AccountAutoSync}=require('../app/core/account-auto-sync.cjs');
const {LoginFlow}=require('../app/core/login-flow.cjs');
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
class Clock {
  time=1700000000000;sequence=0;timers=new Map();
  now=()=>this.time;
  setTimer=(fn,delay)=>{const id=++this.sequence;this.timers.set(id,{fn,at:this.time+delay});return id;};
  clearTimer=id=>this.timers.delete(id);
  async advance(ms){const end=this.time+ms;for(let count=0;;count++){assert(count<1000,'runaway clock');const next=[...this.timers].filter(([,x])=>x.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;this.time=next[1].at;this.timers.delete(next[0]);next[1].fn();await flush();}this.time=end;await flush();}
}
function fixture({enabled=true,run=async()=>{}}={}){
 const clock=new Clock();const controller=new AutoSync({run,now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer});controller.configure({enabled});controller.start();return{clock,controller};
}
const auth=()=>Object.assign(new Error('private server detail must not escape'),{code:'AUTH_REQUIRED'});

test('verified authentication restores only the previously enabled automatic timer after an expired session',async()=>{
 let calls=0,expired=true;
 const f=fixture({run:async()=>{calls++;if(expired)throw auth();}});
 await f.clock.advance(5000);assert.equal(calls,1);assert.equal(f.controller.status().errorCode,'AUTH_REQUIRED');assert.equal(f.clock.timers.size,0);
 expired=false;const state=f.controller.authenticationRestored({enabled:true});
 assert.equal(state.enabled,true);assert.equal(state.blocked,false);assert.equal(state.errorCode,'');assert.equal(f.clock.timers.size,1);
 await f.clock.advance(4999);assert.equal(calls,1);await f.clock.advance(1);assert.equal(calls,2);assert.equal(f.clock.timers.size,1);
 assert.equal(f.controller.status().nextRunAt,f.clock.time+5000);assert.doesNotMatch(JSON.stringify(state),/private server/);
});

test('manual off remains off after verified login even when a manual request had authentication failure',async()=>{
 let calls=0;const f=fixture({enabled:false,run:async()=>calls++});f.controller.recordFailure(auth());
 assert.equal(f.controller.status().blocked,true);const result=f.controller.authenticationRestored({enabled:false});
 assert.equal(result.enabled,false);assert.equal(result.blocked,false);assert.equal(result.nextRunAt,null);assert.equal(f.controller.assertAllowed(),true);
 await f.clock.advance(3600000);assert.equal(calls,0);assert.equal(f.clock.timers.size,0);
});

test('verified login reuses the saved disabled preference without resetting unrelated safety blocks',()=>{
 for(const code of ['ACCESS_DENIED','API_REJECTED','RISK_CONTROL','RISK_REQUIRED','ACCOUNT_MISMATCH','PAGE_SOURCE_REJECTED','UNSAFE_ENDPOINT','UNSAFE_REDIRECT','INVALID_RESPONSE','CURSOR_IGNORED','HTTP_ERROR']){
  const f=fixture();f.controller.recordFailure({code});const before=f.controller.status();
  f.controller.authenticationRestored({enabled:true});assert.deepEqual(f.controller.status(),before);assert.equal(f.clock.timers.size,0);
  f.controller.authenticationRestored({enabled:false});assert.equal(f.controller.status().enabled,false);assert.equal(f.controller.status().blocked,true);assert.equal(f.controller.status().errorCode,code);
  assert.throws(()=>f.controller.assertAllowed(),e=>e.code===code);
 }
});

test('verified login cannot shorten a previous Retry-After cooldown or unblock an oversized cooldown',async()=>{
 let calls=0;const f=fixture({run:async()=>calls++});f.controller.recordFailure({status:429,retryAfter:'3600'});const until=f.controller.cooldownUntil;
 f.controller.recordFailure(auth());await f.clock.advance(1000);f.controller.authenticationRestored({enabled:true});
 assert.equal(f.controller.cooldownUntil,until);assert.equal(f.controller.status().nextRunAt,until);assert.equal(f.controller.status().errorCode,'RATE_LIMIT');
 assert.throws(()=>f.controller.assertAllowed(),e=>e.code==='RATE_LIMIT');
 await f.clock.advance(until-f.clock.time-1);assert.equal(calls,0);await f.clock.advance(1);assert.equal(calls,1);
 const blocked=fixture();blocked.controller.recordFailure({code:'RATE_LIMIT',retryAfter:'9'.repeat(100)});const status=blocked.controller.status();blocked.controller.authenticationRestored({enabled:true});assert.deepEqual(blocked.controller.status(),status);assert.equal(blocked.clock.timers.size,0);
});

test('repeated verified login does not postpone an existing timer, reset backoff, or duplicate work',async()=>{
 let calls=0;const f=fixture({run:async()=>{calls++;}});const firstDue=f.controller.status().nextRunAt;
 await f.clock.advance(1000);for(let i=0;i<10;i++)f.controller.authenticationRestored({enabled:true});
 assert.equal(f.controller.status().nextRunAt,firstDue);assert.equal(f.clock.timers.size,1);await f.clock.advance(4000);assert.equal(calls,1);
 f.controller.recordFailure({code:'NETWORK'});const backoff=f.controller.status();f.controller.authenticationRestored({enabled:true});assert.deepEqual(f.controller.status(),backoff);
});

test('saved enabled state is applied independently from clearing the authentication block',async()=>{
 let calls=0;const f=fixture({enabled:false,run:async()=>calls++});f.controller.recordFailure(auth());f.controller.authenticationRestored({enabled:true});
 assert.equal(f.controller.status().enabled,true);assert.equal(f.controller.status().blocked,false);assert.equal(f.clock.timers.size,1);
 await f.clock.advance(5000);assert.equal(calls,1);
 f.controller.authenticationRestored({enabled:false});await f.clock.advance(30000);assert.equal(calls,1);assert.equal(f.clock.timers.size,0);
});

test('recovery while occupied never runs in parallel and resumes from request completion',async()=>{
 let resolve,calls=0;const pending=new Promise(r=>resolve=r);const f=fixture({run:async()=>{calls++;if(calls===1)await pending;}});
 await f.clock.advance(5000);assert.equal(calls,1);assert.equal(f.controller.running,true);
 for(let i=0;i<3;i++)f.controller.authenticationRestored({enabled:true});await f.clock.advance(20000);assert.equal(calls,1);assert.equal(f.clock.timers.size,0);
 resolve();await flush();assert.equal(f.clock.timers.size,1);assert.equal(f.controller.status().nextRunAt,f.clock.time+5000);await f.clock.advance(5000);assert.equal(calls,2);
});

test('recovery does not restart a stopped controller or accept malformed preferences',()=>{
 const f=fixture();f.controller.recordFailure(auth());f.controller.stop();f.controller.authenticationRestored({enabled:true});assert.equal(f.controller.status().blocked,false);assert.equal(f.controller.started,false);assert.equal(f.clock.timers.size,0);
 f.controller.start();const status=f.controller.status();for(const enabled of ['true',1,0,null,[],{}]){assert.throws(()=>f.controller.authenticationRestored({enabled}));assert.deepEqual(f.controller.status(),status);assert.equal(f.clock.timers.size,1);}
});

function accountsFixture(){
 const clock=new Clock(),registry=new AccountAutoSync(),saved=new Map([['A',true],['B',false]]),calls=new Map();
 const create=id=>()=>{const c=new AutoSync({run:async()=>calls.set(id,(calls.get(id)||0)+1),now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer});c.configure({enabled:saved.get(id)});return c;};
 const activate=id=>registry.activate(id,create(id));return{clock,registry,saved,calls,activate};
}

test('account-bound recovery cannot mutate an inactive or unknown account and preserves other account cooldowns',async()=>{
 const f=accountsFixture(),a=f.activate('A');a.recordFailure(auth());const b=f.activate('B');b.recordFailure({code:'RATE_LIMIT',retryAfter:3600});const until=b.cooldownUntil;
 assert.throws(()=>f.registry.authenticationRestored('A',{enabled:true}),/当前/);assert.throws(()=>f.registry.authenticationRestored('missing',{enabled:true}),/当前/);assert.equal(a.status().blocked,true);
 f.activate('A');f.registry.authenticationRestored('A',{enabled:f.saved.get('A')});assert.equal(a.status().blocked,false);assert.equal(b.cooldownUntil,until);assert.equal(f.clock.timers.size,1);
 await f.clock.advance(5000);assert.equal(f.calls.get('A'),1);assert.equal(f.calls.has('B'),false);
 f.activate('B');f.registry.authenticationRestored('B',{enabled:f.saved.get('B')});assert.equal(b.enabled,false);assert.equal(b.cooldownUntil,until);assert.equal(f.clock.timers.size,0);
});

test('login failure, cancellation and identity change cannot trigger automatic recovery; verified login does',async()=>{
 const f=accountsFixture(),a=f.activate('A');a.recordFailure(auth());let recoveries=0;
 const saved=async({identity})=>{f.activate(identity.id);recoveries++;f.registry.authenticationRestored(identity.id,{enabled:f.saved.get(identity.id)});};
 const flow=new LoginFlow();
 await assert.rejects(flow.run({client:{identity:async()=>{throw auth();}},save:saved}));assert.equal(recoveries,0);assert.equal(a.status().blocked,true);
 let n=0;await assert.rejects(flow.run({client:{identity:async()=>({id:++n===1?'A':'B'}),groups:async()=>[]},save:saved}),e=>e.code==='LOGIN_CHANGED');assert.equal(recoveries,0);
 let release;const pending=flow.run({client:{identity:()=>new Promise(r=>release=r)},save:saved});flow.cancel();await assert.rejects(pending,e=>e.code==='LOGIN_CANCELED');release({id:'A'});await flush();assert.equal(recoveries,0);assert.equal(a.status().blocked,true);
 await flow.run({client:{identity:async()=>({id:'A'}),groups:async()=>[]},save:saved});assert.equal(recoveries,1);assert.equal(a.status().blocked,false);assert.equal(f.clock.timers.size,1);
 const due=a.status().nextRunAt;await flow.run({client:{identity:async()=>({id:'A'}),groups:async()=>[]},save:saved});assert.equal(recoveries,2);assert.equal(a.status().nextRunAt,due);assert.equal(f.clock.timers.size,1);
});

test('restart derives each account automatic state from persisted settings without changing the settings',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-auth-recovery-'));
 try{
  const file=path.join(directory,'saved.json');const settings={A:{autoSyncEnabled:true,interfaceTheme:'violet'},B:{autoSyncEnabled:false,appearance:{memberText:'#000000'}}};fs.writeFileSync(file,JSON.stringify(settings));const original=fs.readFileSync(file);
  for(const iteration of [1,2]){
   const f=accountsFixture();const persisted=JSON.parse(fs.readFileSync(file));for(const id of ['A','B'])f.saved.set(id,persisted[id].autoSyncEnabled!==false);
   const a=f.activate('A');a.recordFailure(auth());f.registry.authenticationRestored('A',{enabled:persisted.A.autoSyncEnabled!==false});await f.clock.advance(5000);assert.equal(f.calls.get('A'),1);
   const b=f.activate('B');b.recordFailure(auth());f.registry.authenticationRestored('B',{enabled:persisted.B.autoSyncEnabled!==false});await f.clock.advance(60000);assert.equal(f.calls.has('B'),false);assert.equal(b.status().enabled,false);assert.equal(f.clock.timers.size,0);assert(fs.readFileSync(file).equals(original),'saved settings changed on iteration '+iteration);
  }
 }finally{const resolved=fs.realpathSync.native(directory),tempRoot=fs.realpathSync.native(os.tmpdir());assert.equal(path.dirname(resolved).toLowerCase(),tempRoot.toLowerCase());assert(path.basename(resolved).startsWith('weiyue-auth-recovery-'));fs.rmSync(resolved,{recursive:true,force:true});}
});

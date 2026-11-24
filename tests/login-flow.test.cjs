const {test}=require('node:test');const assert=require('node:assert/strict');
const {LoginFlow}=require('../app/core/login-flow.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('login confirms identity twice, reports phases and saves one captured result',async()=>{
 const flow=new LoginFlow();const steps=[];let identities=0;
 const value=await flow.run({client:{identity:async({signal})=>{assert.equal(signal.aborted,false);steps.push(flow.status().stage);identities++;return{id:'1'};},groups:async()=>{steps.push(flow.status().stage);return[{id:'g'}];}},save:async({groups,check})=>{steps.push(flow.status().stage);check();return groups.length;}});
 assert.equal(value,1);assert.equal(identities,2);assert.deepEqual(steps,['identity','groups','verify','saving']);assert.equal(flow.status().stage,'completed');assert.equal(flow.status().running,false);
});
test('cancel retains retry ability and a late result cannot save data',async()=>{
 const flow=new LoginFlow();let saved=0;let finish;
 const request=flow.run({client:{identity:()=>new Promise(r=>finish=r),groups:async()=>[]},save:async()=>saved++});
 assert.equal(flow.cancel().canceled,true);await assert.rejects(request,e=>e.code==='LOGIN_CANCELED');finish({id:'1'});await delay(2);assert.equal(saved,0);assert.equal(flow.status().running,false);
 await flow.run({client:{identity:async()=>({id:'1'}),groups:async()=>[]},save:async()=>saved++});assert.equal(saved,1);
});
test('whole-flow deadline bounds transports that ignore abort, errors remain visible',async()=>{
 const flow=new LoginFlow({timeoutMs:15});let saved=false;
 await assert.rejects(flow.run({client:{identity:()=>new Promise(()=>{})},save:async()=>{saved=true;}}),e=>e.code==='LOGIN_TIMEOUT');assert.equal(saved,false);assert.equal(flow.status().stage,'error');assert.match(flow.status().error,/超时/);
});
test('restoring a session is covered by cancellation and deadline before network or saving',async()=>{
 const flow=new LoginFlow({timeoutMs:20});let release;let called=0;
 const connection={identity:async()=>{called++;return{id:'1'};},groups:async()=>[]};
 const pending=flow.run({client:()=>new Promise(r=>release=r),save:()=>{called++;}});
 assert.equal(flow.cancel().canceled,true);await assert.rejects(pending,e=>e.code==='LOGIN_CANCELED');
 release(connection);await delay(1);assert.equal(called,0);
 await assert.rejects(flow.run({client:()=>new Promise(()=>{}),save:()=>{called++;}}),e=>e.code==='LOGIN_TIMEOUT');
 assert.equal(called,0);
});
test('duplicate click, changed identity and protocol errors never commit',async()=>{
 const flow=new LoginFlow();let release;let saved=false;
 const pending=flow.run({client:{identity:()=>new Promise(r=>release=r)},save:()=>{saved=true;}});
 await assert.rejects(flow.run({client:{},save:()=>{}}),e=>e.code==='LOGIN_BUSY');flow.cancel();await assert.rejects(pending);release({id:'a'});await delay(1);assert.equal(saved,false);
 let n=0;await assert.rejects(flow.run({client:{identity:async()=>({id:String(n++)}),groups:async()=>[]},save:()=>{saved=true;}}),e=>e.code==='LOGIN_CHANGED');assert.equal(saved,false);
 await assert.rejects(flow.run({client:{identity:async()=>{throw Error('受控协议错误');}},save:()=>{saved=true;}}),/受控协议错误/);assert.equal(flow.status().error,'受控协议错误');
});

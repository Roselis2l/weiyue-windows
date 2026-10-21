'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AutoSync } = require('../app/core/auto-sync.cjs');
const { AccountAutoSync } = require('../app/core/account-auto-sync.cjs');
function setup() {
 const registry=new AccountAutoSync();let now=100000,sequence=0;
 const timers=new Map(),created=[];
 const make=()=>{const c=new AutoSync({run:async()=>{},now:()=>now,setTimer:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});c.configure({enabled:true});created.push(c);return c;};
 return {registry,make,timers,created,advance:ms=>now+=ms};
}
test('switching accounts preserves a long server cooldown and only one active timer',()=>{
 const f=setup(),a=f.registry.activate('A',f.make);
 a.failed({code:'RATE_LIMIT',retryAfter:3600});const due=a.status().nextRunAt;
 f.advance(1000);const b=f.registry.activate('B',f.make);assert.equal(a.started,false);assert.equal(b.started,true);
 f.advance(1000);assert.equal(f.registry.activate('A',f.make),a);
 assert.equal(a.status().nextRunAt,due);assert.equal(b.started,false);assert.equal(f.created.length,2);assert.equal(f.timers.size,1);
});
test('switching away and back cannot clear risk stop or user pause',()=>{
 const f=setup(),a=f.registry.activate('A',f.make);a.failed({code:'RISK_CONTROL'});
 const reason=a.status().pausedReason;f.registry.activate('B',f.make);f.registry.activate('A',f.make);
 assert.equal(a.status().pausedReason,reason);assert.equal(a.status().nextRunAt,null);assert.equal(f.timers.size,0);
 a.configure({enabled:false});f.registry.activate('B',f.make);f.registry.activate('A',f.make);
 assert.equal(a.status().enabled,false);assert.equal(a.status().nextRunAt,null);
});

test('account switches preserve independent safe error codes, security blocks and rate cooldowns',()=>{
 const f=setup(),a=f.registry.activate('A',f.make);
 a.failed({status:429,code:'private-server-value',retryAfter:3600});const due=a.status().nextRunAt;
 assert.equal(a.status().errorCode,'RATE_LIMIT');assert.equal(a.status().blocked,false);
 f.advance(1000);const b=f.registry.activate('B',f.make);
 b.failed({statusCode:403,code:'private-server-value'});
 assert.equal(b.status().errorCode,'ACCESS_DENIED');assert.equal(b.status().blocked,true);assert.equal(b.status().nextRunAt,null);
 f.advance(1000);assert.equal(f.registry.activate('A',f.make),a);
 assert.equal(a.status().errorCode,'RATE_LIMIT');assert.equal(a.status().blocked,false);assert.equal(a.status().nextRunAt,due);
 assert.equal(b.status().errorCode,'ACCESS_DENIED');assert.equal(b.status().blocked,true);
 assert.equal(f.timers.size,1);
 f.registry.activate('B',f.make);
 assert.equal(b.status().blocked,true);assert.equal(b.status().nextRunAt,null);assert.equal(f.timers.size,0);
 b.configure({enabled:true});
 assert.equal(b.status().blocked,false);assert.equal(b.status().errorCode,'');
 assert.equal(a.status().errorCode,'RATE_LIMIT');assert.equal(a.cooldownUntil,due);
 assert.doesNotMatch(JSON.stringify([a.status(),b.status()]),/private-server-value/);
});

test('manual restrictions belong to the captured account controller across an in-flight account switch',()=>{
 const f=setup(),a=f.registry.activate('A',f.make);
 assert.equal(a.assertAllowed(),true);
 const b=f.registry.activate('B',f.make);
 a.recordFailure({code:'RATE_LIMIT',retryAfter:1800});const until=a.cooldownUntil;
 assert.throws(()=>a.assertAllowed(),error=>error.code==='RATE_LIMIT');
 assert.equal(b.assertAllowed(),true);assert.equal(b.status().errorCode,'');
 f.registry.activate('A',f.make);
 assert.equal(a.cooldownUntil,until);assert.throws(()=>a.assertAllowed(),error=>error.code==='RATE_LIMIT');
 a.configure({enabled:false});a.configure({enabled:true});
 assert.equal(a.cooldownUntil,until);assert.throws(()=>a.assertAllowed(),error=>error.code==='RATE_LIMIT');
 b.recordFailure({statusCode:403});
 assert.throws(()=>b.assertAllowed(),error=>error.code==='ACCESS_DENIED');
 f.registry.activate('B',f.make);b.configure({enabled:false});
 f.registry.activate('A',f.make);f.registry.activate('B',f.make);
 assert.throws(()=>b.assertAllowed(),error=>error.code==='ACCESS_DENIED');
 b.configure({enabled:true});assert.equal(b.assertAllowed(),true);
 assert.equal(a.cooldownUntil,until);
});

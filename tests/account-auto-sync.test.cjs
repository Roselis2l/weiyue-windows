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

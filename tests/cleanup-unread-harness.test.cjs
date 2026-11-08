'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {readStableSynthetic,genericReadError}=require('../scripts/lib/synthetic-stable-read.cjs');
const sleep=async()=>{};
test('stable synthetic read returns validated snapshot once',async()=>{let calls=0;const value={ok:true};assert.equal(await readStableSynthetic({file:'synthetic',read:()=>{calls++;return value;},readStamp:()=> 'same',sleep}),value);assert.equal(calls,1);});
test('generic Store error retries only with observed stamp replacement and reports both stamps',async()=>{
 const stamps=['old','new','new','new'],reports=[];let calls=0;const value={valid:true};assert.equal(await readStableSynthetic({file:'synthetic',read:()=>{if(!calls++)throw Error(genericReadError);return value;},readStamp:()=>stamps.shift(),sleep,onRetry:r=>reports.push(r)}),value);assert.equal(calls,2);assert.equal(reports.length,1);assert.equal(reports[0].before,'old');assert.equal(reports[0].after,'new');
});
test('stable generic failure and changing validation failure are never swallowed',async()=>{
 for(const changing of [false,true]){let calls=0,n=0;const error=Error(changing?'invalid unread state':genericReadError);await assert.rejects(readStableSynthetic({file:'synthetic',read:()=>{calls++;throw error;},readStamp:()=>changing?String(n++):'same',sleep}),e=>e===error);assert.equal(calls,1);}
});
test('continuous replacements stop at exactly five attempts',async()=>{
 let calls=0,n=0,retries=0;await assert.rejects(readStableSynthetic({file:'synthetic',read:()=>{calls++;throw Error(genericReadError);},readStamp:()=>String(n++),sleep,onRetry:()=>retries++}),e=>e.message===genericReadError);assert.equal(calls,5);assert.equal(retries,4);
});
test('successful but concurrently replaced snapshot is not returned as a coherent view',async()=>{
 const stamps=['old','new','new','new'];let calls=0;const result=await readStableSynthetic({file:'synthetic',read:()=>++calls,readStamp:()=>stamps.shift(),sleep});assert.equal(result,2);
});
test('missing files and stat access errors are immediate failures',async()=>{
 let calls=0;await assert.rejects(readStableSynthetic({file:'synthetic',read:()=>calls++,readStamp:()=>{throw Error('EACCES');},sleep}),/EACCES/);assert.equal(calls,0);
});
test('real Store rejects a mid-read atomic replacement; helper proves the changed stamp and retries valid data',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {Store}=require('../app/core/store.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-unread-read-race-'));const store=new Store(root);store.ensureAccount({id:'synthetic',name:'Synthetic',kind:'import'});const file=store._file('synthetic'),bytes=fs.readFileSync(file),nativeRead=fs.readFileSync,reports=[];let changed=false;
 try{
  fs.readFileSync=function(target,...args){const result=nativeRead.call(this,target,...args);if(target===file&&!changed){changed=true;const next=file+'.synthetic-replace';fs.writeFileSync(next,bytes);fs.renameSync(next,file);}return result;};
  const state=await readStableSynthetic({file,read:()=>new Store(root).get('synthetic'),sleep,onRetry:r=>reports.push(r)});assert.equal(state.account.id,'synthetic');assert.equal(reports.length,1);assert.equal(reports[0].reason,'Store rejected concurrent replacement');assert.notEqual(reports[0].before,reports[0].after);
 }finally{fs.readFileSync=nativeRead;assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('weiyue-unread-read-race-'));fs.rmSync(root,{recursive:true,force:true});}
});

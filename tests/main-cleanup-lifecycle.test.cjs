'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

// Exercise the actual Electron close boundary without starting a user profile.
const main=fs.readFileSync(path.join(__dirname,'../app/main.cjs'),'utf8');
const functions=main.slice(main.indexOf('function closing(){'),main.indexOf('async function runSync('));
function fixture(whenIdle){
  const calls={close:0,error:0,cleared:0};
  const context=vm.createContext({closeReady:false,closeTimer:123,closeFinishing:false,
    clearTimeout:()=>calls.cleared++,messageCleanup:{whenIdle},
    win:{isDestroyed:()=>false,close:()=>calls.close++},
    dialog:{showErrorBox:()=>calls.error++}});
  vm.runInContext(functions,context);
  return{context,calls};
}
test('normal close waits for local transaction; duplicate acknowledgement cannot close early',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);let waits=0;
  const {context,calls}=fixture(()=>{waits++;return pending;});
  const first=context.finishClose();
  assert.equal(context.closing(),true);assert.equal(calls.close,0);
  await context.finishClose();assert.equal(waits,1);assert.equal(calls.close,0);
  resolve();await first;
  assert.equal(calls.close,1);assert.equal(context.closeReady,true);assert.equal(context.closeFinishing,false);
  await context.finishClose();assert.equal(calls.close,1);
});
test('unconfirmed idle failure keeps window open and permits a later deliberate close',async()=>{
  const {context,calls}=fixture(async()=>{throw Error('unconfirmed');});
  await context.finishClose();
  assert.equal(calls.close,0);assert.equal(calls.error,1);assert.equal(context.closeReady,false);
  context.messageCleanup.whenIdle=async()=>{};
  await context.finishClose();assert.equal(calls.close,1);
});
test('normal startup without cleanup controller can close',async()=>{
  const {context,calls}=fixture(async()=>{});context.messageCleanup=undefined;
  await context.finishClose();assert.equal(calls.close,1);assert.equal(calls.error,0);
});
test('settling cleanup after window disposal does not close a destroyed window',async()=>{
  let resolve;const {context,calls}=fixture(()=>new Promise(r=>resolve=r));
  const pending=context.finishClose();context.win.isDestroyed=()=>true;
  resolve();await pending;assert.equal(calls.close,0);assert.equal(context.closeReady,true);
});

const handleSource=main.slice(main.indexOf('async function handle(action,p){'),main.indexOf('\nasync function start(){'));
function handleFixture(){
  const writes=[],switches=[];let running=true;
  const context=vm.createContext({activeId:'synthetic-a',busy:false,buildIdentity:require('../app/core/build-identity.cjs').validateBuildIdentity(require('../app/edition.json'),require('../package.json').version),
    cleanupBusy:()=>running,store:{accounts:()=>[{id:'synthetic-b'}],bookmark:(id,p)=>{writes.push({id,p});return 'saved';}},
    setActive:id=>switches.push(id),snapshot:()=>({safe:true})});
  vm.runInContext(handleSource,context);
  return{context,writes,switches,finish:()=>{running=false;}};
}
test('cleanup locks concurrent write entry points before any unrelated side effects',async()=>{
  const {context,writes}=handleFixture();
  for(const action of ['demo','login.open','login.complete','logout','settings.save','settings.ai.save','settings.appearance.save','import','groups.select','read.set','important.set','bookmark.add','bookmark.remove','summary.local','summary.ai.prepare','summary.ai','summary.delete','sync.configure','notion.export']){
    await assert.rejects(context.handle(action,{}),/本地数据操作正在进行/);
  }
  assert.equal(writes.length,0);
});
test('cleanup permits account navigation and read-only snapshots without submitting writes',async()=>{
  const {context,writes,switches}=handleFixture();
  assert.equal((await context.handle('state',{})).safe,true);
  assert.equal((await context.handle('account.switch',{id:'synthetic-b'})).safe,true);
  assert.deepEqual(switches,['synthetic-b']);assert.equal(writes.length,0);
});
test('settled cleanup releases normal write behavior',async()=>{
  const {context,writes,finish}=handleFixture();
  finish();assert.equal(await context.handle('bookmark.add',{groupId:'g',messageIds:['1']}),'saved');
  assert.equal(writes.length,1);assert.equal(writes[0].id,'synthetic-a');
});

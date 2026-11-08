'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const progress=require('../app/renderer/cleanup-progress.js');
const renderer=fs.readFileSync(require.resolve('../app/renderer/app.js'),'utf8');
const start=renderer.indexOf('const cleanupAutoDismiss='),end=renderer.indexOf('\nasync function showMessageCleanup()',start);
assert(start>=0&&end>start);
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function setup(){
  const apply=deferred(),calls=[],intervals=new Set();let status={accountId:'a',groupId:'g',jobId:'job',kind:'permanent',phase:'processing',running:true,processed:1,total:2};
  const model={state:{account:{id:'a'},groups:[{id:'g',name:'Synthetic'}]},accountEpoch:3,groupId:'g',view:'bookmarks',queryVersion:0,closing:false,cleanupOperation:null};
  const context=vm.createContext({model,window:{WeiyueCleanupProgress:progress,api:{call:async(action,payload)=>{calls.push({action,payload});if(action==='messages.cleanup.status')return status;return apply.promise;}}},
    $:()=>null,flushReading:async()=>calls.push({action:'flush'}),invalidateReadingIntent:()=>{},autoPage:{reset(){}},renderSyncStatus:()=>{},scheduleReadingRefresh:()=>{},
    refreshState:async()=>calls.push({action:'refresh-state'}),renderSidebar:()=>calls.push({action:'sidebar'}),renderHeader:()=>calls.push({action:'header'}),
    setInterval:callback=>{intervals.add(callback);return callback;},clearInterval:callback=>intervals.delete(callback),setTimeout,
  });
  vm.runInContext(renderer.slice(start,end),context);
  const spec={action:'messages.cleanup.apply',accountId:'a',groupId:'g',kind:'permanent',total:2,payload:{accountId:'a',groupId:'g',confirmationToken:'synthetic',confirmed:true},success:'已永久删除 2 条本地消息。',onStarted:()=>calls.push({action:'close-modal'})};
  return{context,model,calls,apply,intervals,spec,run:()=>context.performCleanupOperation(spec),setStatus:value=>status=value};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const result={accountId:'a',groupId:'g',deleted:true,deletedCount:2,mode:'permanent'};

test('verified unread apply count drives completed feedback, with exactly one submission',async()=>{
 const h=setup();h.spec.expectedMarkedReadCount=1;h.spec.successResult=r=>'实际标记已读 '+r.markedReadCount+' 条';
 const pending=h.run();await tick();await assert.rejects(h.run(),/正在进行/);h.apply.resolve({...result,markedReadCount:1});await pending;
 assert.equal(h.model.cleanupOperation.status.detail,'实际标记已读 1 条');assert.equal(h.calls.filter(c=>c.action==='messages.cleanup.apply').length,1);
});
test('missing or mismatched unread apply count is uncertain, never fabricated as success',async()=>{
 for(const markedReadCount of [undefined,0,2,-1]){const h=setup();h.spec.expectedMarkedReadCount=1;let formatted=false;h.spec.successResult=()=>{formatted=true;return 'bad';};const pending=h.run();await tick();h.apply.resolve({...result,markedReadCount});await pending;assert.equal(h.model.cleanupOperation.uncertain,true);assert.equal(formatted,false);assert.equal(h.calls.some(c=>c.action==='refresh-state'),false);}
});
test('unread details report mutually exclusive outcomes and reject invalid counts',()=>{
 const p={deleteCount:3,retainedCount:2,unreadCount:4,markedReadCount:2,retainedUnreadCount:2};
 assert.match(progress.unreadDetail(p),/所选范围未读 4 条；将标记已读并处理 2 条；保留未读 2 条/);
 assert.match(progress.completionDetail(p,'permanent'),/已标记已读并处理 2 条.*高水位.*未前移/);
 for(const patch of [{markedReadCount:-1},{retainedUnreadCount:3},{unreadCount:NaN},{markedReadCount:undefined},{deleteCount:1},{retainedCount:1}])assert.throws(()=>progress.unreadDetail({...p,...patch}),/数量无效/);
});

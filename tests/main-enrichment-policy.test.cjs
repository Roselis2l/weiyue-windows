'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {Store}=require('../app/core/store.cjs');
const {AutoSync}=require('../app/core/auto-sync.cjs');
const source=fs.readFileSync(path.join(__dirname,'../app/main.cjs'),'utf8');
const start=source.indexOf('async function enrichMessages(id,p){'),end=source.indexOf('\nfunction hardenSession',start);
assert.ok(start>=0&&end>start,'extract the actual shipped enrichment entry point');
const extracted=source.slice(start,end);
const observerStart=source.indexOf('function observeContent(id=activeId){'),observerEnd=source.indexOf('\nfunction setActive',observerStart);
assert.ok(observerStart>=0&&observerEnd>observerStart,'extract the actual content invalidation observer');
const observer=source.slice(observerStart,observerEnd);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function policy(){
  let time=1700000000000;
  const controller=new AutoSync({run:async()=>{},now:()=>time,setTimer:()=>1,clearTimer:()=>{}});
  const records=[],record=controller.recordFailure.bind(controller);
  controller.recordFailure=error=>{records.push(error);return record(error);};
  return {controller,records,advance:ms=>{time+=ms;}};
}
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wy-enrichment-policy-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new Store(root);
  for(const id of ['weibo-1','weibo-2']){
    store.ensureAccount({id,name:'Synthetic',kind:'weibo'});
    store.mergeMessages(id,[{id:'2',name:'Synthetic',selected:true}],[20,21].map(n=>({id:String(n),groupId:'2',senderId:'7',senderName:'Synthetic',text:'分享图片',time:1000+n})));
    store.setReadPosition(id,'2','20',{offset:17,followTail:false,seenId:'20'});
    store.mergeMessages(id,[],[{id:'22',groupId:'2',senderId:'7',senderName:'Synthetic',text:'Synthetic new message',time:1022}]);
  }
  const oldPolicy=policy(),newPolicy=policy(),calls=[],restores=[];
  const invalidations={image:0,imageViewer:0,attachmentViewer:0,download:0,ai:0,aiPreview:0,summaryPreview:0};
  const context={activeId:'weibo-1',accountEpoch:1,busy:false,cleanupBusy:()=>false,revision:0,store,autoSync:oldPolicy.controller,
    observedContent:new Map(),mediaEpoch:0,contentRevision:0,
    imageCache:new Map([['synthetic','cached image']]),cachedImageBytes:12,attachmentCache:new Map([['synthetic','cached attachment']]),
    imageJobs:new Map([['synthetic-in-flight',{controller:{abort:()=>invalidations.image++}}]]),
    imageViewer:{closeAll:()=>invalidations.imageViewer++},attachmentViewer:{closeAll:()=>invalidations.attachmentViewer++},
    attachmentDownload:{cancelAll:()=>invalidations.download++},activeAi:{controller:{abort:()=>invalidations.ai++}},
    aiPreviews:{clear:()=>invalidations.aiPreview++},summaryDeletePreviews:{clear:()=>invalidations.summaryPreview++},
    isImageQuoteText:require('../app/core/message-references.cjs').isImageQuoteText,
    enrichmentJobs:new Map(),enrichmentAttempts:new Map(),closing:()=>false,
    account:()=>{context.observeContent();return store.getVisibleSnapshot(context.activeId);},
    accountSession:async(id,{check})=>{restores.push(id);check();if(options.restore)await options.restore(context);return {};},
    client:()=>({identity:async()=>{calls.push('identity');return options.identity?options.identity(context):{id:'1'};},
      messageDetail:async(groupId,id)=>{calls.push(`detail:${id}`);return options.detail?options.detail(id,context):{id,senderId:'7',images:[{id:`image-${id}`,originalUrl:'https://wx1.sinaimg.cn/large/synthetic.jpg'}]};}}),
    setTimeout:fn=>{fn();return 1;},
  };
  vm.createContext(context);vm.runInContext(observer+'\n'+extracted,context);
  return {context,store,oldPolicy,newPolicy,calls,restores,invalidations,
    run:(ids=['20','21'])=>context.enrichMessages('weibo-1',{groupId:'2',messageIds:ids,retry:true}),
    switchAccount:()=>{context.activeId='weibo-2';context.accountEpoch++;context.autoSync=newPolicy.controller;}};
}

test('existing 429 cooldown and access/security stops prevent all enrichment requests and session restoration',async t=>{
  for(const code of ['RATE_LIMIT','ACCESS_DENIED','AUTH_REQUIRED','RISK_CONTROL']){
    const f=fixture(t);f.oldPolicy.controller.recordFailure(Object.assign(new Error('synthetic'),{code,retryAfter:'1800'}));
    const before=f.oldPolicy.controller.cooldownUntil;
    await assert.rejects(f.run(),{code});assert.deepEqual(f.calls,[]);assert.deepEqual(f.restores,[]);
    assert.equal(f.oldPolicy.records.length,1);assert.equal(f.oldPolicy.controller.cooldownUntil,before);
  }
});

test('detail 429 immediately ends the remaining targets and establishes the same account cooldown once',async t=>{
  const failure=Object.assign(new Error('synthetic'),{code:'RATE_LIMIT',retryAfter:'1800'});
  const f=fixture(t,{detail:async()=>{throw failure;}}),before=f.store.getReadStats('weibo-1','2');
  await assert.rejects(f.run(),e=>e===failure);
  assert.deepEqual(f.calls,['identity','detail:20']);assert.equal(f.oldPolicy.records.length,1);
  assert.equal(f.oldPolicy.controller.cooldownUntil,1700001800000);
  await assert.rejects(f.run(),{code:'RATE_LIMIT'});assert.equal(f.oldPolicy.records.length,1);
  assert.deepEqual(f.store.getReadStats('weibo-1','2'),before);
});

test('a late rejected request after account switch records only the captured original account policy',async t=>{
  const wait=deferred(),failure=Object.assign(new Error('synthetic'),{code:'ACCESS_DENIED'});
  const f=fixture(t,{detail:()=>wait.promise}),work=f.run();await flush();
  assert.deepEqual(f.calls,['identity','detail:20']);f.switchAccount();wait.reject(failure);
  await assert.rejects(work,e=>e===failure);
  assert.equal(f.oldPolicy.records.length,1);assert.equal(f.oldPolicy.controller.status().blocked,true);
  assert.equal(f.newPolicy.records.length,0);assert.equal(f.newPolicy.controller.status().blocked,false);
});

test('late success after account switch is a normal ABORTED cancellation with no merge or policy failure',async t=>{
  const wait=deferred(),f=fixture(t,{detail:()=>wait.promise}),before=f.store.get('weibo-1');
  const work=f.run();await flush();f.switchAccount();wait.resolve({id:'20',senderId:'7'});
  await assert.rejects(work,{code:'ABORTED'});assert.equal(f.oldPolicy.records.length,0);assert.equal(f.newPolicy.records.length,0);
  assert.deepEqual(f.store.get('weibo-1'),before);
});

test('an identity mismatch pauses the original account with ACCOUNT_MISMATCH before any details',async t=>{
  const f=fixture(t,{identity:async()=>({id:'2'})});await assert.rejects(f.run(),{code:'ACCOUNT_MISMATCH'});
  assert.deepEqual(f.calls,['identity']);assert.equal(f.oldPolicy.records.length,1);
  assert.equal(f.oldPolicy.controller.status().errorCode,'ACCOUNT_MISMATCH');assert.equal(f.oldPolicy.controller.status().blocked,true);
});

test('same-group duplicate callers share one job and only its owner records a network rejection',async t=>{
  const wait=deferred(),failure=Object.assign(new Error('synthetic'),{code:'RATE_LIMIT',retryAfter:'30'});
  const f=fixture(t,{detail:()=>wait.promise}),one=f.run(),two=f.run();await flush();wait.reject(failure);
  const results=await Promise.allSettled([one,two]);assert.ok(results.every(r=>r.status==='rejected'&&r.reason===failure));
  assert.deepEqual(f.calls,['identity','detail:20']);assert.equal(f.oldPolicy.records.length,1);assert.equal(f.context.enrichmentJobs.size,0);
});

test('success preserves original text, every reading field and unread counts while storing rich metadata',async t=>{
  const f=fixture(t),before=f.store.getReadStats('weibo-1','2');
  const result=await f.run();assert.equal(result.count,2);assert.deepEqual(f.calls,['identity','detail:20','detail:21']);
  assert.equal(f.oldPolicy.records.length,0);assert.deepEqual(f.store.getReadStats('weibo-1','2'),before);
  for(const message of f.store.get('weibo-1').messages.filter(m=>['20','21'].includes(m.id))){
    assert.equal(message.text,'分享图片');assert.equal(message.mediaVersion,1);assert.equal(message.images.length,1);
  }
});

test('guards run again before identity and every detail, without counting local guard failures as new API failures',async t=>{
  const restore=fixture(t,{restore:async context=>context.autoSync.recordFailure(Object.assign(new Error('synthetic'),{code:'RATE_LIMIT',retryAfter:'1800'}))});
  await assert.rejects(restore.run(),{code:'RATE_LIMIT'});assert.deepEqual(restore.calls,[]);assert.equal(restore.oldPolicy.records.length,1);
  const f=fixture(t,{identity:async context=>{context.autoSync.recordFailure(Object.assign(new Error('synthetic'),{code:'ACCESS_DENIED'}));return {id:'1'};}});
  await assert.rejects(f.run(),{code:'ACCESS_DENIED'});assert.deepEqual(f.calls,['identity']);assert.equal(f.oldPolicy.records.length,1);
  assert.equal(f.context.enrichmentAttempts.size,0);
});

test('storage errors and ABORTED transport cancellation do not become account security/network policy failures',async t=>{
  const f=fixture(t);f.store.mergeMessages=()=>{throw new Error('synthetic disk failure');};
  await assert.rejects(f.run(),/synthetic disk failure/);assert.equal(f.oldPolicy.records.length,0);
  const cancelled=fixture(t,{identity:async()=>{throw Object.assign(new Error('synthetic cancellation'),{code:'ABORTED'});}});
  await assert.rejects(cancelled.run(),{code:'ABORTED'});assert.equal(cancelled.oldPolicy.records.length,0);
});

test('old completed media still verifies context once; same-name ordinary sender is never classified by label',async t=>{
  const quotePreview={kind:'image',state:'unavailable',reasonCode:'WEB_REFERENCE_TARGET_UNAVAILABLE'};
  const f=fixture(t,{detail:async id=>({id,senderId:'7',contextVersion:1,...(id==='20'?{quotePreview}:{})})});
  f.store.update('weibo-1',s=>{for(const m of s.messages){m.referenceVersion=1;m.mediaVersion=1;m.attachmentVersion=1;}
    s.messages[0].text='「图片」\n- - - - - - - - - - - - - - -\nSynthetic reply';s.messages[1].senderName='粉丝群';});
  const before=f.store.getReadStats('weibo-1','2');
  const request={groupId:'2',messageIds:['20','21','22']};
  assert.equal((await f.context.enrichMessages('weibo-1',request)).count,2);
  assert.deepEqual(f.calls,['identity','detail:20','detail:21']);
  const messages=f.store.get('weibo-1').messages;assert.deepEqual(messages[0].quotePreview,quotePreview);
  assert.equal(messages[1].contextVersion,1);assert.equal(messages[1].systemNotice,undefined);assert.equal(messages[2].contextVersion,undefined);
  assert.deepEqual(f.store.getReadStats('weibo-1','2'),before);
  f.context.enrichmentAttempts.clear();
  assert.equal((await f.context.enrichMessages('weibo-1',request)).count,0);
  assert.deepEqual(f.calls,['identity','detail:20','detail:21']);
});

test('legacy voice and Live Photo placeholders can enrich without changing reading state or resurrecting tombstones',async t=>{
  const f=fixture(t,{detail:async id=>({id,senderId:'7',attachments:id==='20'
    ?[{kind:'audio',fid:'126001',state:'needs-metadata',name:'分享语音'}]
    :[{kind:'video',fid:'126002',state:'needs-metadata',name:'实况照片',livePhoto:true}]})});
  f.store.update('weibo-1',s=>{for(const m of s.messages){m.referenceVersion=1;m.mediaVersion=1;m.attachmentVersion=1;}
    s.messages[0].text='分享语音';s.messages[1].text='实况照片';});
  const before=f.store.getReadStats('weibo-1','2');
  const request={groupId:'2',messageIds:['20','21','22']};
  assert.equal((await f.context.enrichMessages('weibo-1',request)).count,2);
  assert.deepEqual(f.calls,['identity','detail:20','detail:21']);
  assert.equal(f.store.get('weibo-1').messages[0].attachments[0].kind,'audio');
  assert.equal(f.store.get('weibo-1').messages[1].attachments[0].livePhoto,true);
  assert.deepEqual(f.store.getReadStats('weibo-1','2'),before);
  f.context.enrichmentAttempts.clear();
  assert.equal((await f.context.enrichMessages('weibo-1',request)).count,0);
  const calls=f.calls.length;
  // A permanent-deletion marker is never an eligible content lookup target.
  f.store.update('weibo-1',s=>{s.messages=s.messages.filter(m=>m.id!=='21');s.messageTombstones=[{id:'21',groupId:'2',time:1021}];s.schemaVersion=3;});
  const preserved=f.store.get('weibo-1');
  assert.equal((await f.context.enrichMessages('weibo-1',{groupId:'2',messageIds:['21'],retry:true})).count,0);
  assert.equal(f.calls.length,calls);assert.deepEqual(f.store.get('weibo-1'),preserved);
});

test('a withdrawn detail replaces old media, invalidates active previews and preserves read/unread identity',async t=>{
  const {normalizeMessages}=require('../app/core/weibo.cjs'),{NOTICE}=require('../app/core/message-recalls.cjs');
  const detail=normalizeMessages({messages:[{mid:'20',gid:'2',from_uid:'7',content:'SYNTHETIC_STALE_CONTENT',time:1.02,type:344,sub_type:101,from_user:{screen_name:'Synthetic'},pic_ids:['obsolete']}]},'2')[0];
  assert.equal(detail.recall.state,'withdrawn');
  const f=fixture(t,{detail:async()=>detail});
  f.store.update('weibo-1',s=>{const m=s.messages.find(m=>m.id==='20');m.text='SYNTHETIC_STALE_CONTENT';m.images=[{id:'obsolete',originalUrl:'https://wx1.sinaimg.cn/large/synthetic.jpg'}];});
  const before=f.store.getReadStats('weibo-1','2'),other=f.store.get('weibo-2');
  const result=await f.run(['20']);assert.equal(result.count,1);assert.deepEqual(f.calls,['identity','detail:20']);
  const saved=f.store.get('weibo-1').messages.find(m=>m.id==='20');
  assert.equal(saved.text,NOTICE);assert.equal(saved.recall.state,'withdrawn');assert.equal(saved.images,undefined);assert.equal(saved.attachments,undefined);assert.equal(saved.references,undefined);
  assert.equal(JSON.stringify(f.store.getVisibleSnapshot('weibo-1')).includes('SYNTHETIC_STALE_CONTENT'),false);
  assert.deepEqual(f.store.getReadStats('weibo-1','2'),before);assert.deepEqual(f.store.get('weibo-2'),other);
  assert.deepEqual(f.invalidations,{image:1,imageViewer:1,attachmentViewer:1,download:1,ai:1,aiPreview:1,summaryPreview:1});
  assert.equal(f.context.contentRevision,1);assert.equal(f.context.mediaEpoch,1);assert.equal(f.oldPolicy.records.length,0);
  assert.equal(f.context.imageCache.size,0);assert.equal(f.context.cachedImageBytes,0);assert.equal(f.context.attachmentCache.size,0);
  assert.equal((await f.run(['20'])).count,0);assert.deepEqual(f.calls,['identity','detail:20']);
});

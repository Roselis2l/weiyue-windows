'use strict';
const {app,BrowserWindow,ipcMain,session,dialog,safeStorage,shell,protocol,net,Menu,screen}=require('electron');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {Store,compareMessages,visibleMessages}=require('./core/store.cjs');
const {Vault,officialUrl,safeExternal,redact}=require('./core/security.cjs');
const {WeiboClient}=require('./core/weibo.cjs');
const {isImageQuoteText}=require('./core/message-references.cjs');
const {prepareSummary,localSummary,aiSummary,validateEndpoint,prepareAiRequest,prepareAiSummary,inspectAiVision}=require('./core/summary.cjs');
const {prepareSummaryContent}=require('./core/summary-content.cjs');
const {AiPreviewStore,waitForAiOperation}=require('./core/ai-preview.cjs');
const {SummaryDeletePreviewStore,fingerprint:summaryFingerprint}=require('./core/summary-delete-preview.cjs');
const {createMessageCleanupController}=require('./core/message-cleanup-controller.cjs');
const {createAttachmentDownload}=require('./core/attachment-download.cjs');
const {createImageViewer}=require('./core/image-viewer.cjs');
const {createHeifDecoder}=require('./core/heif-decoder.cjs');
const {createVideoDecoder}=require('./core/video-decoder.cjs');
const {createAudioDecoder}=require('./core/audio-decoder.cjs');
const {normalizeHttpUrl}=require('./renderer/linkify.js');
const {createEmoticonAssets}=require('./core/emoticon-assets.cjs');
const emoticonAssets=createEmoticonAssets({root:path.join(__dirname,'renderer'),manifest:require('./renderer/emoticon-manifest.js')});
const {createAttachmentViewer,normalizeSource:normalizeAttachmentSource}=require('./core/attachment-viewer.cjs');
const {resolveAttachment,fetchAttachment,mergeAttachments}=require('./core/attachments.cjs');
const pdfAssets=new Set(require('./pdfjs/assets.json').files.map(item=>'/pdfjs/'+item.path));
const {listAiProviders,prepareAiSettingsSave,prepareLegacyAiSettingsSave,assertAiKeyScope}=require('./core/ai-settings.cjs');
const {normalizeAppearance}=require('./renderer/appearance.js');
const {saveAppearanceSettings}=require('./core/appearance-settings.cjs');
const {NotionClient,buildPreview,buildEditablePreview,resolveNotionSource}=require('./core/notion.cjs');
const {syncAccount}=require('./core/sync-service.cjs');
const {LoginFlow}=require('./core/login-flow.cjs');
const {AccountSessionRegistry}=require('./core/account-session.cjs');
const {AutoSync}=require('./core/auto-sync.cjs');
const {AccountAutoSync}=require('./core/account-auto-sync.cjs');
const {RefreshPlan,AUTOMATIC_INTERVAL_MS,BACKGROUND_HEAD_INTERVAL_MS,AUTOMATIC_TIME_BUDGET_MS,AUTOMATIC_MAX_PAGES,AUTOMATIC_HEAD_EVERY_PAGES,AUTOMATIC_DEADLINE_MS}=require('./core/refresh-plan.cjs');
const {fetchImage,safeImageUrl}=require('./core/media.cjs');
const {AvatarService}=require('./core/avatar-service.cjs');
const {refreshGroupAvatars}=require('./core/avatar-refresh.cjs');
const {Readable}=require('node:stream');
const loginFlow=new LoginFlow();
const argData=process.argv.find(x=>x.startsWith('--data-dir='));
const dataRoot=argData?path.resolve(argData.slice(11)):app.isPackaged?path.join(path.dirname(process.execPath),'data'):path.resolve(__dirname,'../.local-data');
fs.mkdirSync(dataRoot,{recursive:true});
app.setPath('userData',path.join(dataRoot,'browser'));
app.setName('微阅 Windows');
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const lock=app.requestSingleInstanceLock(); if(!lock) app.quit();
let win,loginWindow,pendingLogin,store,vault,activeId,busy=false;
let autoSync,revision=0,activeSync,accountEpoch=0,closeReady=false,closeTimer,closeFinishing=false;
let imageViewer,activeAi,heifDecoder,videoDecoder,audioDecoder,attachmentViewer,attachmentDownload,messageCleanup;
const aiPreviews=new AiPreviewStore();
const summaryDeletePreviews=new SummaryDeletePreviewStore();
const automaticAccounts=new AccountAutoSync();
const refreshPlans=new Map();let preferredRefreshGroup=null;
function refreshPlan(id){if(!refreshPlans.has(id))refreshPlans.set(id,new RefreshPlan());return refreshPlans.get(id);}
const enrichmentJobs=new Map(),enrichmentAttempts=new Map(),imageCache=new Map(),imageJobs=new Map();
let cachedImageBytes=0,activeImages=0;const imageWaiters=[];
const sessions=new Map();
const sessionRegistry=new AccountSessionRegistry({sessions,createSession:()=>{const s=session.fromPartition('weiyue-account-'+crypto.randomUUID());hardenSession(s);return s;},readCookies:id=>secrets(id).cookies||[],officialUrl});
const avatars=new AvatarService({getContext:()=>({owner:activeId,epoch:accountEpoch,revision,closing:closing()}),getState:id=>store.getSnapshot(id),restoreSession:accountSession,defaultSession:()=>session.defaultSession,request:imageRequest});
function preferences(){try{return JSON.parse(fs.readFileSync(path.join(dataRoot,'preferences.json'),'utf8'));}catch{return {};}}
function clearMedia(){accountEpoch++;for(const job of imageJobs.values())job.controller.abort();imageCache.clear();cachedImageBytes=0;avatars.clear();imageViewer?.closeAll();attachmentViewer?.closeAll();attachmentDownload?.cancelAll();messageCleanup?.clear();heifDecoder?.dispose();heifDecoder=null;videoDecoder?.dispose();videoDecoder=null;audioDecoder?.dispose();audioDecoder=null;activeAi?.controller.abort();aiPreviews.clear();summaryDeletePreviews.clear();}
function setActive(id){const changed=activeId!==id;activeId=id;fs.writeFileSync(path.join(dataRoot,'preferences.json'),JSON.stringify({activeId:id}));if(changed){preferredRefreshGroup=null;clearMedia();revision++;configureAutomatic();}}
// Validated immutable snapshots are read-only. Mutations always go through Store.
function account(){return store.getSnapshot(activeId);}
function cleanupBusy(){return !!messageCleanup?.isBusy();}
function secrets(id=activeId){return vault.read(id);}
function publicReadStats(id=activeId,groupId){const all=store.getReadStats(id,groupId);const clean=s=>{const {unreadIds,...rest}=s;return rest;};return groupId===undefined?Object.fromEntries(Object.entries(all).map(([key,value])=>[key,clean(value)])):clean(all);}
function snapshot(){
  const s=account(); let sec={};let credentialError='';try{sec=secrets();}catch(e){credentialError=e.message;}
  const readStates=publicReadStats();
  return {accounts:store.accounts(),account:s.account,groups:s.groups.map(g=>{const {avatarUrl,...rest}=g;return {...rest,...readStates[g.id],avatarSrc:avatars.source('group',g.id)};}),readPositions:s.readPositions,readStates,importantMembers:s.importantMembers,settings:{...s.settings,appearance:normalizeAppearance(s.settings.appearance)},stats:{messages:visibleMessages(s.messages).length,recycledMessages:s.messages.filter(m=>m.localDeletion).length,bookmarks:s.bookmarks.length,summaries:s.summaries.length},sessionReady:!!sec.cookies?.length,credentials:{ai:!!sec.aiKey,notion:!!sec.notionToken},credentialError,dataRoot,revision};
}
function syncStatus(){return {...(autoSync?.status()||{enabled:false,intervalMs:AUTOMATIC_INTERVAL_MS,running:false}),backgroundIntervalMs:BACKGROUND_HEAD_INTERVAL_MS,running:!!activeSync||!!autoSync?.status().running,accountId:activeId,revision};}
function captureRefreshContext(p){
  // A delayed poll from a previous account cannot change the current priority.
  if(p.accountId!==activeId)return;
  preferredRefreshGroup=typeof p.groupId==='string'&&account().groups.some(g=>g.selected&&g.id===p.groupId)?p.groupId:null;
}
function configureAutomatic(){
  if(!store||!activeId)return;
  const owner=activeId;
  autoSync=automaticAccounts.activate(owner,()=>{
    const controller=new AutoSync({run:()=>runSync({},true),isBusy:()=>busy||cleanupBusy()||enrichmentJobs.size>0,
      isEligible:()=>{if(activeId!==owner||closing())return false;const s=store.getSnapshot(owner);return s.account.kind==='weibo'&&s.groups.some(g=>g.selected)&&!!secrets(owner).cookies?.length;}});
    controller.configure({enabled:account().account.kind==='weibo'&&account().settings.autoSyncEnabled!==false,intervalMs:AUTOMATIC_INTERVAL_MS});
    return controller;
  });
}
function closing(){return closeReady||!!closeTimer||closeFinishing;}
async function finishClose(){
  if(closeReady||closeFinishing)return;
  closeFinishing=true;clearTimeout(closeTimer);closeTimer=null;
  try{
    // A confirmed local transaction must settle before the process exits. The
    // renderer's close acknowledgement cannot bypass an in-flight atomic commit.
    await messageCleanup?.whenIdle();
    closeReady=true;closeFinishing=false;if(win&&!win.isDestroyed())win.close();
  }catch{
    closeFinishing=false;
    dialog.showErrorBox('本地操作尚未完成','暂时无法确认本地保存已结束。请保留窗口，待数据操作完成后再关闭。');
  }
}
async function runSync(p={},automatic=false){
  if(busy||cleanupBusy()||enrichmentJobs.size){const e=new Error('已有操作正在进行，请稍后再同步。');e.code='SYNC_BUSY';throw e;}
  const syncPolicy=autoSync;syncPolicy?.assertAllowed();
  const id=activeId,state=account();if(state.account.kind!=='weibo')throw new Error('演示与导入账号不连接微博。请先登录官方账号。');
  if(!state.groups.some(g=>g.selected&&(!p.groupId||g.id===p.groupId)))throw new Error('请先选择允许同步的群聊。');
  const preferred=automatic?preferredRefreshGroup:null;
  const plan=automatic?refreshPlan(id).plan(state.groups,preferred):null;
  if(automatic&&!plan.hasWork)return {count:0,pages:0,state:snapshot()};
  busy=true;const controller=new AbortController();activeSync={controller,automatic};const check=()=>{if(controller.signal.aborted){const e=new Error('同步已取消，已保存的页面仍保留。');e.code='ABORTED';throw e;}};
  const timer=setTimeout(()=>controller.abort(),automatic?AUTOMATIC_DEADLINE_MS:120000);
  try{
    const s=await accountSession(id,{check}),c=client(s,{timeoutMs:12000,maxAttempts:automatic?1:2}),identity=await c.identity({signal:controller.signal});check();
    if('weibo-'+identity.id!==id){const e=new Error('登录账号与本地账号不一致，请重新登录。');e.code='ACCOUNT_MISMATCH';throw e;}
    if(!automatic){
      await refreshGroupAvatars({client:c,store,accountId:id,groups:state.groups,groupId:p.groupId,signal:controller.signal,onChange:()=>revision++});check();
    }
    const result=await syncAccount({store,accountId:id,client:c,groupId:p.groupId,history:!!p.history,
      continuous:!p.history,maxPages:p.history?10:automatic?AUTOMATIC_MAX_PAGES:120,timeBudgetMs:automatic?AUTOMATIC_TIME_BUDGET_MS:90000,
      ...(automatic?{preferredGroupId:preferred,headGroupIds:plan.headGroupIds,retryUnresolvedGroupIds:plan.retryUnresolvedGroupIds}:{}),
      pageDelayMs:1000,headEveryPages:automatic?AUTOMATIC_HEAD_EVERY_PAGES:12,signal:controller.signal,onChange:progress=>{revision++;if(progress.kind==='head')refreshPlan(id).recordHead(progress.groupId);if(progress.retriedUnresolved===true)refreshPlan(id).recordUnresolvedAttempt(progress.groupId);}});check();
    await rememberCookies(id,s);return {...result,state:snapshot()};
  }catch(error){if(!automatic)syncPolicy?.recordFailure(error);throw error;}
  finally{clearTimeout(timer);busy=false;activeSync=null;}
}
const mediaToken=id=>crypto.createHash('sha256').update(String(id)).digest('hex').slice(0,32);
function decorateMessage(m,id=activeId){
  const images=(list,section)=>(list||[]).map((image,index)=>{const base='app://media/'+[mediaToken(id),m.groupId,m.id,section,index].map(encodeURIComponent).join('/');return {...image,src:base+'/preview',originalSrc:base+'/original'};});
  const {senderAvatarUrl,...rest}=m;
  const attachments=(m.attachments||[]).map((item,index)=>({...item,src:'app://attachment/'+[mediaToken(id),m.groupId,m.id,index].map(encodeURIComponent).join('/')}));
  return {...rest,senderAvatarSrc:id===activeId?avatars.source('member',m.senderId):undefined,...(m.images?{images:images(m.images,'message')}:{}),...(m.sharedPost?{sharedPost:{...m.sharedPost,images:images(m.sharedPost.images,'post')}}:{}),...(m.references?.length?{references:m.references.map((ref,index)=>({...ref,images:images(ref.images,'reference-'+index)}))}:{}),...(attachments.length?{attachments}:{})};
}
// net.request exposes manual redirects before following them; session.fetch does
// not surface that event reliably on every Electron runtime. No Cookie header is copied.
function imageRequest(s,url,options){return new Promise((resolve,reject)=>{
  const req=net.request({url,session:s,method:'GET',credentials:'include',redirect:'manual'});let settled=false;
  const abort=()=>req.abort();if(options.signal?.aborted){reject(new Error('Canceled'));return;}options.signal?.addEventListener('abort',abort,{once:true});
  const cleanup=()=>options.signal?.removeEventListener('abort',abort);
  for(const [k,v]of Object.entries(options.headers||{}))req.setHeader(k,v);
  req.on('redirect',(status,_method,target)=>{if(settled)return;settled=true;cleanup();resolve(new Response(null,{status,headers:{location:target}}));req.abort();});
  req.on('response',response=>{if(settled)return;settled=true;const headers=new Headers();for(const [k,v]of Object.entries(response.headers))for(const value of Array.isArray(v)?v:[v])if(typeof value==='string')headers.append(k,value);response.on('end',cleanup);response.on('error',cleanup);resolve(new Response(Readable.toWeb(response),{status:response.statusCode,headers}));});
  req.on('error',()=>{cleanup();if(!settled){settled=true;reject(new Error('Image network failure'));}});req.on('abort',()=>{cleanup();if(!settled){settled=true;reject(new Error('Canceled'));}});req.end();
});}
async function serveImage(request,u,returnImage=false){
  const imageWeight=value=>value.bytes.length+(value.original?.bytes.length||0);
  const id=activeId,epoch=accountEpoch;let parts;try{parts=u.pathname.slice(1).split('/').map(decodeURIComponent);}catch{return new Response('Invalid image',{status:400});}
  if(request.method!=='GET'||parts.length!==6||parts[0]!==mediaToken(id)||!/^(?:message|post|reference-(?:[0-9]|1[0-9]))$/.test(parts[3])||!/^\d{1,3}$/.test(parts[4])||!['preview','original'].includes(parts[5]))return new Response('Not found',{status:404});
  const state=store.getSnapshot(id),m=state.messages.find(m=>!m.localDeletion&&m.groupId===parts[1]&&m.id===parts[2]);const descriptor=(parts[3].startsWith('reference-')?m?.references?.[Number(parts[3].slice(10))]?.images:parts[3]==='post'?m?.sharedPost?.images:m?.images)?.[Number(parts[4])];
  const url=safeImageUrl(parts[5]==='original'?(descriptor?.originalUrl||descriptor?.url):(descriptor?.thumbnailUrl||descriptor?.url));if(!url)return new Response('Image unavailable',{status:404});
  const key=mediaToken(id)+'|'+url;let cached=imageCache.get(key);
  if(!cached){
    let job=imageJobs.get(key);
    if(!job){
      const controller=new AbortController();job={controller};
      job.promise=(async()=>{
        let acquired=false;try{
          if(activeImages>=4)await new Promise((resolve,reject)=>{if(imageWaiters.length>=100)return reject(new Error('Image queue full'));imageWaiters.push(resolve);});
          activeImages++;acquired=true;const check=()=>{if(controller.signal.aborted||epoch!==accountEpoch||closing())throw new Error('Canceled');};check();const s=state.account.kind==='weibo'?await accountSession(id,{check}):session.defaultSession;check();
          let value=await fetchImage({url,fetch:(target,options)=>imageRequest(s,target,options),signal:controller.signal,allowHeif:true,allowRasterMimeCorrection:true});check();
          if(value.mime==='image/heic'){
            const original=value;
            heifDecoder ||= createHeifDecoder({BrowserWindow,ipcMain,session,appRoot:__dirname});
            const display=await heifDecoder.decode(original.bytes,{signal:controller.signal});check();
            value={bytes:display.bytes,mime:display.mime,original};
          }
          const weight=imageWeight(value);
          if(weight<=64*1024*1024){
            while(cachedImageBytes+weight>64*1024*1024&&imageCache.size){const oldest=imageCache.keys().next().value;cachedImageBytes-=imageWeight(imageCache.get(oldest));imageCache.delete(oldest);}
            imageCache.set(key,value);cachedImageBytes+=weight;
          }
          return value;
        }finally{if(acquired){activeImages--;imageWaiters.shift()?.();}if(imageJobs.get(key)===job)imageJobs.delete(key);}
      })();imageJobs.set(key,job);
    }
    try{cached=await job.promise;}catch{return new Response('Image unavailable; retry or view in Weibo',{status:502,headers:{'Cache-Control':'no-store'}});}
  }else{imageCache.delete(key);imageCache.set(key,cached);}
  if(epoch!==accountEpoch||id!==activeId)return new Response('Account changed',{status:403});
  if(returnImage)return cached;
  return new Response(cached.bytes,{headers:{'Content-Type':cached.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'app://local'}});
}
function attachmentRecord(source){
  const safe=normalizeAttachmentSource(source);if(!safe)throw new Error('附件地址无效。');
  const parts=new URL(safe).pathname.slice(1).split('/').map(decodeURIComponent);
  if(parts[0]!==mediaToken(activeId))throw new Error('附件所属账号已变化。');
  const state=account(),message=state.messages.find(m=>!m.localDeletion&&m.groupId===parts[1]&&m.id===parts[2]);
  const index=Number(parts[3]),attachment=message?.attachments?.[index];
  if(!attachment)throw new Error('本地附件记录不存在，请补全消息。');
  return {state,message,index,attachment};
}
async function readStoredAttachment(source,{signal}={}){
  const id=activeId,epoch=accountEpoch;
  const {state,message,index,attachment}=attachmentRecord(source);
  const check=()=>{if(signal?.aborted||id!==activeId||epoch!==accountEpoch||closing())throw new Error('附件读取已取消。');};
  check();const s=state.account.kind==='weibo'?await accountSession(id,{check}):session.defaultSession;check();
  if(state.account.kind==='weibo'){
    const identity=await client(s,{timeoutMs:12000,maxAttempts:1}).identity({signal});check();
    if('weibo-'+identity.id!==id)throw new Error('微博账号不匹配，请重新登录。');
  }
  const transport=(url,options)=>imageRequest(s,url,options);
  const ready=await resolveAttachment(attachment,{fetch:transport,signal});check();
  if(attachment.state!=='ready'){
    const fresh=store.getSnapshot(id).messages.find(m=>m.id===message.id&&m.groupId===message.groupId);
    if(!fresh||fresh.attachments?.[index]?.fid!==attachment.fid)throw new Error('附件记录已变化。');
    store.mergeMessages(id,[],[{...fresh,attachments:mergeAttachments(fresh.attachments,[ready]),attachmentVersion:1}],{history:true});revision++;
  }
  const result=await fetchAttachment({attachment:ready,fetch:transport,signal});check();return result;
}
async function enrichMessages(id,p){
  if(account().account.kind!=='weibo')return {count:0};if(!Array.isArray(p.messageIds)||p.messageIds.length>10)throw new Error('每次最多补全 10 条已存消息。');
  const key=id+'|'+String(p.groupId);if(enrichmentJobs.has(key))return enrichmentJobs.get(key);if(busy||cleanupBusy())return {count:0,deferred:true};
  const epoch=accountEpoch,syncPolicy=autoSync;
  const check=()=>{if(id!==activeId||epoch!==accountEpoch||closing())throw Object.assign(new Error('账号已变化，补全已停止。'),{code:'ABORTED'});};
  // Only the owning job records an actual API failure. Its policy remains tied
  // to the original account even if a late response arrives after switching.
  const read=async operation=>{
    check();syncPolicy?.assertAllowed();
    try{return await operation();}
    catch(error){if(error?.code!=='ABORTED')syncPolicy?.recordFailure(error);throw error;}
  };
  const job=(async()=>{
    const needsContext=m=>m.contextVersion!==1&&(isImageQuoteText(m.text)||m.senderName==='粉丝群');
    const missingPlayable=m=>((m.text||'').trim()==='分享语音'&&!m.attachments?.some(a=>a.kind==='audio'))||((m.text||'').trim()==='实况照片'&&!m.attachments?.some(a=>a.kind==='video'&&a.livePhoto));
    const complete=m=>m.referenceVersion===1&&m.mediaVersion===1&&(m.attachmentVersion===1||!/^(?:文件消息|分享视频)$/.test((m.text||'').trim()))&&!needsContext(m)&&!missingPlayable(m);
    const state=store.getSnapshot(id),targets=[...new Set(p.messageIds)].map(mid=>state.messages.find(m=>!m.localDeletion&&m.groupId===p.groupId&&m.id===mid)).filter(m=>m&&(!complete(m)||p.retry));if(!targets.length)return {count:0};
    check();syncPolicy?.assertAllowed();
    const s=await accountSession(id,{check}),c=client(s,{timeoutMs:10000,maxAttempts:1});const identity=await read(()=>c.identity());check();
    if('weibo-'+identity.id!==id){const error=Object.assign(new Error('登录账号不一致，请重新登录。'),{code:'ACCOUNT_MISMATCH'});syncPolicy?.recordFailure(error);throw error;}let count=0;
    for(const old of targets){check();const attemptKey=key+'|'+old.id;if(Date.now()-(enrichmentAttempts.get(attemptKey)||0)<60000)continue;
      const detail=await read(()=>{enrichmentAttempts.set(attemptKey,Date.now());return c.messageDetail(old.groupId,old.id);});check();const patch={...old,mediaVersion:1,attachmentVersion:1,referenceVersion:1};if(detail.references)patch.references=detail.references;if(detail.attachments)patch.attachments=detail.attachments;if(detail.images)patch.images=detail.images;if(detail.sharedPost)patch.sharedPost=detail.sharedPost;if(detail.senderId===old.senderId&&detail.senderAvatarUrl)patch.senderAvatarUrl=detail.senderAvatarUrl;
      if(detail.contextVersion===1){patch.contextVersion=1;delete patch.systemNotice;delete patch.quotePreview;if(detail.systemNotice)patch.systemNotice=detail.systemNotice;if(detail.quotePreview)patch.quotePreview=detail.quotePreview;}
      store.mergeMessages(id,[],[patch],{history:true});revision++;count++;if(count<targets.length)await new Promise(r=>setTimeout(r,1000));
    }return {count};
  })();enrichmentJobs.set(key,job);try{return await job;}finally{enrichmentJobs.delete(key);}
}
function hardenSession(s){s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));s.setPermissionCheckHandler(()=>false);s.on('will-download',e=>e.preventDefault());}
async function accountSession(id,options){return sessionRegistry.restore(id,options);}
async function rememberCookies(id,s){
  const cookies=(await s.cookies.get({})).filter(c=>officialUrl('https://'+c.domain.replace(/^\./,'')));
  vault.write(id,{...secrets(id),cookies});
}
function client(s,options={}){return new WeiboClient({...options,fetch:(url,options)=>s.fetch(url,{...options,credentials:'include'})});}
function group(s,id){const g=s.groups.find(x=>x.id===id);if(!g)throw new Error('群聊不存在');return g;}
function summaryFor(p){const s=account();return prepareSummary({messages:visibleMessages(s.messages).filter(m=>m.groupId===p.groupId),group:group(s,p.groupId),start:Number(p.start),end:Number(p.end)});}
const aiOwner=()=>activeId+'|'+accountEpoch;
function checkAiOperation(operation){if(operation.controller.signal.aborted||operation.owner!==aiOwner()||closing())throw new Error('本次 AI 操作已取消。');}
async function prepareAiPreview(p){
  if(busy)throw new Error('已有操作正在进行，请稍后准备 AI 内容。');
  const id=activeId,state=account(),settings={...state.settings},profile=prepareAiRequest(settings);
  assertAiKeyScope(settings,secrets(id));
  const pre=summaryFor(p);if(!pre.messages.length)throw new Error('选定时段没有可发送的消息。');
  const rawMessages=structuredClone(visibleMessages(state.messages).filter(m=>m.groupId===p.groupId&&m.time>=pre.range.start&&m.time<pre.range.end));
  const operation={requestId:String(p.requestId||crypto.randomUUID()),owner:aiOwner(),controller:new AbortController(),stage:'prepare'};
  if(!/^[\w-]{1,100}$/.test(operation.requestId))throw new Error('请求标识无效。');
  busy=true;activeAi=operation;aiPreviews.clear();
  const timer=setTimeout(()=>operation.controller.abort(),120000),check=()=>checkAiOperation(operation);
  try{
    const vision=inspectAiVision(settings);
    let imageSession=session.defaultSession,contentClient;
    if(state.account.kind==='weibo'){
      imageSession=await waitForAiOperation(accountSession(id,{check}),operation.controller.signal);check();
      contentClient=client(imageSession,{timeoutMs:10000,maxAttempts:1});
      const identity=await contentClient.identity({signal:operation.controller.signal});check();
      if('weibo-'+identity.id!==id)throw new Error('微博登录账号与本地账号不一致，请重新登录后准备内容。');
    }
    const resolved=await prepareSummaryContent(pre,{messages:rawMessages,client:contentClient,includeImages:vision.supported,signal:operation.controller.signal,
      loadImage:(url,options)=>fetchImage({url,fetch:(target,opts)=>imageRequest(imageSession,target,opts),...options})});
    check();const prepared=prepareAiSummary(pre,{...settings,content:resolved.content});check();
    const previewId=aiPreviews.put({owner:operation.owner,settings,prepared,profile});
    return {previewId,requestId:operation.requestId,title:prepared.title,range:prepared.range,warning:prepared.warning,
      messageCount:prepared.messages.length,chunkCount:prepared.chunks.length,messages:prepared.messages.slice(0,20),
      contentScope:prepared.contentScope,coverage:resolved.coverage,service:{url:profile.url,model:profile.model,provider:profile.provider,vision}};
  }finally{clearTimeout(timer);if(activeAi===operation)activeAi=null;busy=false;}
}
async function confirmSend(message,detail){const r=await dialog.showMessageBox(win,{type:'question',title:'确认发送内容',message,detail,buttons:['取消','确认发送'],defaultId:0,cancelId:0,noLink:true});if(r.response!==1)throw new Error('已取消，未发送内容。');}
function summaryDeleteSelection(p){
  const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f]/.test(value);
  if(!p||!validId(p.accountId)||!validId(p.summaryId)||!validId(p.groupId))throw new Error('删除摘要的标识无效，请刷新后重试。');
  if(p.accountId!==activeId||closing())throw new Error('当前账号已变化或窗口正在关闭，未删除摘要。');
  return {accountId:p.accountId,summaryId:p.summaryId,groupId:p.groupId};
}
function readSummaryForDelete(selection){
  const state=store.getSnapshot(selection.accountId),matches=state.summaries.filter(item=>item&&item.id===selection.summaryId);
  if(matches.length>1)throw new Error('摘要 ID 重复，请保留数据后检查，未删除摘要。');
  const selected=matches[0];
  if(selected&&selected.groupId!==selection.groupId)throw new Error('摘要所属群已变化，请刷新后重试。');
  return {selected,summaryCount:state.summaries.length};
}
function previewSummaryDeletion(p){
  const selection=summaryDeleteSelection(p),current=readSummaryForDelete(selection);
  if(!current.selected)return {...selection,deleted:false,missing:true,summaryCount:current.summaryCount};
  const title=String(current.selected.title||'未命名摘要').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,160);
  return {...selection,title,confirmationToken:summaryDeletePreviews.create(selection,accountEpoch,current.selected)};
}
async function deleteSavedSummary(p){
  const selection=summaryDeleteSelection(p);
  if(busy)throw new Error('已有操作正在进行，请稍后再删除摘要。');
  busy=true;
  try{
    const fingerprint=summaryDeletePreviews.take(selection,accountEpoch,p.confirmationToken,p.confirmed);
    const fresh=readSummaryForDelete(selection);
    if(!fresh.selected)return {...selection,deleted:false,missing:true,summaryCount:fresh.summaryCount};
    if(summaryFingerprint(fresh.selected)!==fingerprint)throw new Error('摘要内容已变化，请重新确认删除。');
    const removed=store.removeSummary(selection.accountId,selection.summaryId,selection.groupId);
    if(!removed.deleted)return {...selection,deleted:false,missing:true,summaryCount:removed.summaryCount};
    revision++;
    return {...selection,deleted:true,summaryCount:removed.summaryCount};
  }finally{busy=false;}
}
function saveSummary(id,s){store.update(id,state=>{state.summaries.unshift(s);});return s;}
async function saveText(defaultPath,text,extensions){const r=await dialog.showSaveDialog(win,{defaultPath,filters:[{name:'导出文件',extensions}]});if(r.canceled)return {canceled:true};fs.writeFileSync(r.filePath,text,'utf8');return {path:r.filePath};}
async function handle(action,p){
  const id=activeId;
  if(busy&&['account.switch','demo','login.open','login.complete','logout','settings.save','settings.ai.save','settings.appearance.save','import','groups.select'].includes(action))throw new Error('操作正在进行，请完成后再切换账号或设置。');
  // Account switching and read-only queries may continue. Concurrent writers
  // cannot replace the state captured by a confirmed cleanup transaction.
  if(cleanupBusy()&&['demo','login.open','login.complete','logout','settings.save','settings.ai.save','settings.appearance.save','import','groups.select','read.set','important.set','bookmark.add','bookmark.remove','summary.local','summary.ai.prepare','summary.ai','summary.delete','sync.configure','notion.export'].includes(action))throw new Error('本地数据操作正在进行，完成后可继续保存或同步。');
  switch(action){
    case 'state':return snapshot();
    case 'ai.providers':return listAiProviders();
    case 'account.switch':if(!store.accounts().some(a=>a.id===p.id))throw new Error('账号不存在');setActive(p.id);return snapshot();
    case 'demo':{const a=store.seedDemo();setActive(a.id);return snapshot();}
    case 'groups.select':{if(!Array.isArray(p.ids))throw new Error('请选择群聊');store.update(id,s=>{s.groups.forEach(g=>g.selected=p.ids.includes(g.id));});revision++;return snapshot();}
    case 'messages.query':{const result=store.queryMessages(id,p);return {...result,revision,messages:result.messages.map(m=>decorateMessage(m,id))};}
    case 'messages.enrich':return enrichMessages(id,p);
    case 'image.open':attachmentViewer?.closeAll();return imageViewer.open({source:p.source,title:p.title,caption:p.caption});
    case 'attachment.open':{const {attachment}=attachmentRecord(p.source);imageViewer?.closeAll();return attachmentViewer.open({source:p.source,title:attachment.name,kind:attachment.kind});}
    case 'attachment.download':return attachmentDownload.download({source:p.source});
    case 'messages.cleanup.info':return messageCleanup.info(p);
    case 'messages.cleanup.preview':return messageCleanup.preview(p);
    case 'messages.cleanup.apply':return messageCleanup.apply(p);
    case 'messages.cleanup.status':return messageCleanup.status(p);
    case 'messages.trash.list':return messageCleanup.list(p);
    case 'messages.trash.restore':return messageCleanup.restore(p);
    case 'messages.trash.purge.preview':return messageCleanup.purgePreview(p);
    case 'messages.trash.purge.apply':return messageCleanup.purgeApply(p);
    case 'members.list':{const map=new Map();for(const m of visibleMessages(account().messages))if(m.groupId===p.groupId)map.set(m.senderId,m.senderName);return [...map].map(([id,name])=>({id,name}));}
    case 'messages.locate':{const s=account();const messages=visibleMessages(s.messages).filter(m=>m.groupId===p.groupId).sort(compareMessages);const offset=messages.findIndex(m=>m.id===p.messageId);if(offset<0)throw new Error('原文未在本机找到，请补充同步或重新导入。');return {message:decorateMessage(messages[offset],id),offset};}
    case 'read.set':{if(p.anchorId!==undefined){store.setReadPosition(id,p.groupId,p.anchorId,{offset:p.anchorOffset,followTail:p.atBottom,seenId:p.readThroughId});}else store.setReadPosition(id,p.groupId,p.messageId);return publicReadStats(id,p.groupId);}
    case 'important.set':store.setImportant(id,p.senderId,!!p.enabled);return true;
    case 'bookmark.add':return store.bookmark(id,p);
    case 'bookmark.list':return store.bookmarks(id,p.query??p).map(b=>({...b,messages:b.messages.map(m=>decorateMessage(m,id))}));
    case 'bookmark.remove':store.removeBookmark(id,p.id);return true;
    case 'import':{
      busy=true;try{
      const r=await dialog.showOpenDialog(win,{title:'导入本机群聊 JSON（独立导入账号）',properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});if(r.canceled)return {canceled:true};
      const file=r.filePaths[0];if(fs.statSync(file).size>30*1024*1024)throw new Error('单次导入最大 30 MB，请分批导入。');
      const data=JSON.parse(fs.readFileSync(file,'utf8'));const importedId='import-'+crypto.randomUUID();
      store.ensureAccount({id:importedId,name:'导入 · '+path.basename(file,'.json').slice(0,50),kind:'import'});
      const count=store.importData(importedId,data);setActive(importedId);return {count,state:snapshot()};
      }finally{busy=false;}
    }
    case 'export.bookmarks':{
      const items=store.bookmarks(id,p.query||'');
      const markdown='# 微阅收藏\n\n'+items.map(b=>'## '+b.tags.join(' · ')+'\n\n'+b.note+'\n\n'+b.messages.map(m=>`- ${new Date(m.time).toISOString()} ${m.senderName} · ${m.groupId}/${m.id}\n\n  ${m.text.replace(/\n/g,'\n  ')}`).join('\n\n')).join('\n\n---\n\n');
      return saveText('微阅收藏.'+(p.format==='json'?'json':'md'),p.format==='json'?JSON.stringify(items,null,2):markdown,[p.format==='json'?'json':'md']);
    }
    case 'summary.preview':{const pre=summaryFor(p);return {title:pre.title,range:pre.range,warning:pre.warning,messageCount:pre.messages.length,chunkCount:pre.chunks.length,messages:pre.messages.slice(0,20),chunks:pre.chunks.map(c=>({index:c.index,length:c.text.length,refs:c.refs}))};}
    case 'summary.local':return saveSummary(id,localSummary(summaryFor(p)));
    case 'summary.ai.prepare':return prepareAiPreview(p);
    case 'summary.ai.discard':aiPreviews.clear(p.previewId);return {discarded:true};
    case 'summary.ai.cancel':{
      if(activeAi&&activeAi.owner===aiOwner()&&activeAi.requestId===String(p.requestId))activeAi.controller.abort();
      if(p.previewId)aiPreviews.clear(p.previewId);
      return {canceled:true};
    }
    case 'summary.ai':{
      if(busy)throw new Error('已有操作正在进行。');
      const settings={...account().settings},key=assertAiKeyScope(settings,secrets(id));
      const {prepared:pre,profile:requestProfile}=aiPreviews.take({token:p.previewId,owner:aiOwner(),settings,confirmed:p.confirmed});
      const operation={requestId:String(p.requestId||crypto.randomUUID()),owner:aiOwner(),controller:new AbortController(),stage:'send'},scope=pre.contentScope||{};
      busy=true;activeAi=operation;
      try{
        await confirmSend('发送已预览的正文与图片至所选 AI 服务',`服务：${requestProfile.url}\n实际模型 ID：${requestProfile.model}\n聊天：${pre.messages.length} 条；分享微博正文：${scope.postCount||0} 条；图片：${scope.imageCount||0} 张\n请求分段：${pre.chunks.length}；每段生成上限：4096 token\n范围遗漏：${scope.omissions?.length||0} 项（详见发送预览）\n将发送成员名称、时间、聊天和可读微博正文，以及已预览的图片字节。图片会额外消耗 token，服务可能计费。只发送本次快照；失败不会自动重试或切换服务。`);
        checkAiOperation(operation);
        const result=await aiSummary(pre,{...settings,key,fetch:net.fetch,signal:operation.controller.signal});checkAiOperation(operation);
        return saveSummary(id,result);
      }finally{if(activeAi===operation)activeAi=null;busy=false;}
    }
    case 'summary.list':return account().summaries;
    case 'summary.delete.preview':return previewSummaryDeletion(p);
    case 'summary.delete':return deleteSavedSummary(p);
    case 'summary.export':{const s=account().summaries.find(s=>s.id===p.summaryId);if(!s)throw new Error('摘要不存在');return saveText('微阅摘要.md',s.body+'\n\n'+s.refs.map(r=>`[${r.label||r.id}] ${r.groupId}/${r.id} ${new Date(r.time).toISOString()}\n${r.text}`).join('\n\n'),['md']);}
    case 'settings.appearance.save':{
      saveAppearanceSettings({store,payload:p,getContext:()=>({accountId:activeId,epoch:accountEpoch,busy,closing:closing()})});return snapshot();
    }
    case 'settings.ai.save':{
      const next=prepareAiSettingsSave(account().settings,secrets(id),p);
      vault.write(id,next.credentials);store.update(id,s=>{s.settings=next.settings;});aiPreviews.clear();return snapshot();
    }
    case 'settings.save':{
      const settings=account().settings;busy=true;try{
        let sec,reset=false;try{sec=secrets(id);}catch(error){if(!p.resetUnreadable)throw error;const r=await dialog.showMessageBox(win,{type:'warning',title:'重新初始化本账号凭据',message:'清除无法解密的旧凭据并重新配置？',detail:'这会替换当前账号的旧 Cookie、AI Key 和 Notion Token。聊天、收藏和摘要保留，需要重新登录微博。',buttons:['取消','重新初始化'],defaultId:0,cancelId:0});if(r.response!==1)throw new Error('已取消凭据重置');sec={};reset=true;sessionRegistry.invalidate(id);}
        if(p.deleteSecrets){delete sec.aiKey;delete sec.aiKeyScope;delete sec.notionToken;}else if(p.notionToken)sec.notionToken=String(p.notionToken).trim();
        const legacyPayload=p.deleteSecrets&&Object.prototype.hasOwnProperty.call(p,'aiKey')?{...p,aiKey:''}:p;
        const next=prepareLegacyAiSettingsSave(settings,sec,legacyPayload,{allowMissingKey:!!p.deleteSecrets||reset});
        vault.write(id,next.credentials);store.update(id,s=>{s.settings=next.settings;});aiPreviews.clear();return snapshot();
      }finally{busy=false;}
    }
    case 'login.open':{
      if(loginWindow&&!loginWindow.isDestroyed()){loginWindow.focus();return true;}
      const s=pendingLogin||(account().account.kind==='weibo'?await accountSession(id):session.fromPartition('weiyue-login-'+crypto.randomUUID()));if(!pendingLogin)hardenSession(s);pendingLogin=s;
      loginWindow=new BrowserWindow({width:1050,height:780,title:'微博官方登录 · 微阅',parent:win,webPreferences:{session:s,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
      const wc=loginWindow.webContents;wc.on('will-navigate',(e,url)=>{if(!officialUrl(url))e.preventDefault();});wc.on('will-redirect',(e,url)=>{if(!officialUrl(url))e.preventDefault();});
      wc.setWindowOpenHandler(({url})=>{if(officialUrl(url))loginWindow.loadURL(url).catch(()=>{});return {action:'deny'};});
      loginWindow.on('closed',()=>{loginWindow=null;});try{await loginWindow.loadURL('https://api.weibo.com/chat');}catch{throw new Error('官方登录页暂时无法打开，请检查网络后重试。已有会话保留。');}return true;
    }
    case 'login.status':return loginFlow.status();
    case 'login.cancel':return loginFlow.cancel();
    case 'sync.status':captureRefreshContext(p);return syncStatus();
    case 'sync.configure':{if(typeof p.enabled!=='boolean')throw new Error('请指定自动更新开关。');store.update(id,s=>{s.settings.autoSyncEnabled=p.enabled;});if(!p.enabled&&activeSync?.automatic)activeSync.controller.abort();autoSync.configure({enabled:p.enabled,intervalMs:AUTOMATIC_INTERVAL_MS});return syncStatus();}
    case 'window.closeReady':if(closing())await finishClose();return true;
    case 'login.complete':{
      if(!pendingLogin&&account().account.kind!=='weibo')throw new Error('请先打开官方登录窗口并自行完成登录。');
      let loginSession=pendingLogin;busy=true;try{
      return await loginFlow.run({client:async({check})=>{
        if(!loginSession)loginSession=await accountSession(id,{check});check();pendingLogin=loginSession;
        return client(loginSession,{timeoutMs:12000,maxAttempts:2});
      },save:async({identity,groups,check})=>{
        const cookies=(await loginSession.cookies.get({})).filter(c=>officialUrl('https://'+c.domain.replace(/^\./,'')));check();const newId='weibo-'+identity.id;
        store.ensureAccount({id:newId,name:identity.name,kind:'weibo'});vault.write(newId,{...secrets(newId),cookies});sessionRegistry.adopt(newId,loginSession);
        store.mergeMessages(newId,groups,[]);revision++;setActive(newId);if(pendingLogin===loginSession)pendingLogin=null;if(loginWindow&&!loginWindow.isDestroyed())loginWindow.close();return snapshot();
      }});
      }finally{busy=false;}
    }
    case 'logout':{
      busy=true;try{clearMedia();const sec=secrets();delete sec.cookies;vault.write(id,sec);pendingLogin=null;if(loginWindow&&!loginWindow.isDestroyed())loginWindow.close();const s=sessionRegistry.invalidate(id);if(s)await s.clearStorageData();return snapshot();}finally{busy=false;}
    }
    case 'sync':return runSync(p,false);
    case 'notion.targets':{const token=secrets().notionToken;if(!token)throw new Error('请配置自己的 Notion 集成 Token，并在 Notion 授权目标页面。');return new NotionClient({token,fetch:net.fetch}).listTargets();}
    case 'notion.preview':case 'notion.export':{
      const source=resolveNotionSource(account(),p);
      if(action==='notion.preview')return buildEditablePreview(source,p.targetId,account().exports);
      const preview=buildPreview(source,p.targetId,{editable:true,draft:p.draft});
      if(p.confirmed!==true||!p.draft||typeof p.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(p.sourceHash))throw new Error('请在编辑预览中核对内容并确认导出目标。');
      if(p.sourceHash!==preview.sourceHash)throw new Error('导出来源已变化，请重新打开导出预览并核对内容。');
      if(busy)throw new Error('已有操作正在进行。');
      const draft={title:preview.title,body:preview.body,includeReferences:preview.includeReferences};
      const sourceHash=preview.sourceHash,targetId=preview.targetId,selection=preview.sourceType==='bookmarks'?{bookmarkIds:[...preview.sourceIds]}:{summaryId:preview.sourceIds[0]};
      busy=true;try{
        if(activeId!==id)throw new Error('当前账号已变化，请重新打开导出预览。');
        const state=store.get(id),freshSource=resolveNotionSource(state,selection);
        if(buildPreview(freshSource,targetId,{draft}).sourceHash!==sourceHash)throw new Error('导出来源已变化，请重新打开导出预览并核对内容。');
        const token=secrets(id).notionToken;if(!token)throw new Error('请先配置 Notion Token。');
        return await new NotionClient({token,fetch:net.fetch}).exportSummary(freshSource,targetId,{draft,sourceHash,journal:state.exports,saveJournal:journal=>store.update(id,s=>{s.exports=journal;})});
      }finally{busy=false;}
    }
    case 'external.open':{const url=normalizeHttpUrl(p.url);if(!url)throw new Error('仅允许 HTTP 或 HTTPS 网页地址。');await shell.openExternal(url);return true;}
    default:throw new Error('不支持的操作');
  }
}
async function start(){
  store=new Store(path.join(dataRoot,'accounts'));vault=new Vault(path.join(dataRoot,'credentials'),safeStorage);
  messageCleanup=createMessageCleanupController({store,asyncOperations:true,getContext:()=>({accountId:activeId,epoch:accountEpoch,busy:busy||enrichmentJobs.size>0,closing:closing()}),onChange:()=>{revision++;aiPreviews.clear();}});
  const all=store.accounts();if(!all.length)store.seedDemo();const saved=preferences().activeId;setActive(store.accounts().some(a=>a.id===saved)?saved:store.accounts()[0].id);
   protocol.handle('app',request=>{
    const u=new URL(request.url);
    if(u.host==='media')return serveImage(request,u);
    if(u.host==='avatar')return avatars.serve(request,u);
    if(request.method!=='GET'||u.host!=='local')return new Response('Not found',{status:404});
    if(u.pathname.startsWith('/emoticons/'))return emoticonAssets.serve(request,u);
    if(pdfAssets.has(u.pathname))return net.fetch(pathToFileURL(path.join(__dirname,'pdfjs',u.pathname.slice('/pdfjs/'.length))).href);
    if(!['/auto-page.js','/appearance.js','/appearance-settings.js','/interface-theme.js','/interface-theme.css','/drag-scroll.js','/message-references.js','/cleanup-progress.js','/message-cleanup.js','/message-cleanup.css','/index.html','/app.js','/style.css','/reading-state.js','/filter-controls.js','/sync-status.js','/linkify.js','/emoticons.js','/emoticon-manifest.js','/image-viewer.html','/image-viewer.js','/image-viewer.css','/attachment-viewer.html','/attachment-viewer.js','/attachment-viewer.css'].includes(u.pathname))return new Response('Not found',{status:404});
    return net.fetch(pathToFileURL(path.join(__dirname,'renderer',u.pathname.slice(1))).href);
  });
  hardenSession(session.defaultSession);Menu.setApplicationMenu(null);
  win=new BrowserWindow({width:1440,height:930,minWidth:1000,minHeight:680,title:'微阅',backgroundColor:'#f6f5f0',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:false}});
  imageViewer=createImageViewer({BrowserWindow,ipcMain,dialog,appRoot:__dirname,getParent:()=>win,getOwner:aiOwner,
    getWorkArea:()=>screen.getDisplayMatching(win.getBounds()).workAreaSize,
    readImage:async source=>{const image=await serveImage({method:'GET'},new URL(source),true);if(image instanceof Response)throw new Error('原图加载失败，请重试。');return image;}});
  attachmentViewer=createAttachmentViewer({BrowserWindow,ipcMain,dialog,appRoot:__dirname,getParent:()=>win,getOwner:aiOwner,readAttachment:readStoredAttachment,decodeVideo:(value,options)=>{videoDecoder ||= createVideoDecoder({BrowserWindow,ipcMain,session,appRoot:__dirname});return videoDecoder.decode(value,options);},decodeAudio:(value,options)=>{audioDecoder ||= createAudioDecoder({BrowserWindow,ipcMain,session,appRoot:__dirname});return audioDecoder.decode(value,options);}});
  attachmentDownload=createAttachmentDownload({dialog,getParent:()=>win,getOwner:aiOwner,readAttachment:readStoredAttachment});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.on('will-attach-webview',e=>e.preventDefault());
  win.on('close',event=>{if(closeReady)return;event.preventDefault();if(closing())return;autoSync?.stop();activeSync?.controller.abort();clearMedia();closeTimer=setTimeout(()=>void finishClose(),2000);win.webContents.send('weiyue:before-close');});
  ipcMain.handle('weiyue:call',async(e,action,payload)=>{
    if(e.sender!==win.webContents||e.senderFrame!==win.webContents.mainFrame||e.senderFrame.url!=='app://local/index.html')return {ok:false,error:'来源不受信任'};
    if(typeof action!=='string'||!payload||typeof payload!=='object'||Array.isArray(payload)||JSON.stringify(payload).length>(['notion.preview','notion.export'].includes(action)?1250000:100000))return {ok:false,error:'请求格式无效'};
    try{return {ok:true,value:await handle(action,payload)};}catch(error){let secretValues=[];try{const sec=secrets();secretValues=[sec.aiKey,sec.notionToken,...(sec.cookies||[]).map(c=>c.value)];}catch{}return {ok:false,error:redact(error.message,secretValues)};}
  });
  await win.loadURL('app://local/index.html');
}
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.on('window-all-closed',()=>{autoSync?.stop();app.quit();});
if(lock)app.whenReady().then(start).catch(()=>{dialog.showErrorBox('微阅启动失败','本地数据无法读取或目录不可写。请保留 data 目录备份并查阅中文使用说明，不要覆盖原文件。');app.quit();});

'use strict';
const {app,BrowserWindow,ipcMain,session,dialog,safeStorage,shell,protocol,net,Menu}=require('electron');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {Store}=require('./core/store.cjs');
const {Vault,officialUrl,safeExternal,redact}=require('./core/security.cjs');
const {WeiboClient}=require('./core/weibo.cjs');
const {prepareSummary,localSummary,aiSummary,validateEndpoint,prepareAiRequest}=require('./core/summary.cjs');
const {listAiProviders,prepareAiSettingsSave,prepareLegacyAiSettingsSave,assertAiKeyScope}=require('./core/ai-settings.cjs');
const {NotionClient,buildPreview,buildEditablePreview,resolveNotionSource}=require('./core/notion.cjs');
const {syncAccount}=require('./core/sync-service.cjs');
const {LoginFlow}=require('./core/login-flow.cjs');
const {AccountSessionRegistry}=require('./core/account-session.cjs');
const {AutoSync}=require('./core/auto-sync.cjs');
const {AccountAutoSync}=require('./core/account-auto-sync.cjs');
const {fetchImage,safeImageUrl}=require('./core/media.cjs');
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
let autoSync,revision=0,activeSync,accountEpoch=0,closeReady=false,closeTimer;
const automaticAccounts=new AccountAutoSync();
const enrichmentJobs=new Map(),enrichmentAttempts=new Map(),imageCache=new Map(),imageJobs=new Map();
let cachedImageBytes=0,activeImages=0;const imageWaiters=[];
const sessions=new Map();
const sessionRegistry=new AccountSessionRegistry({sessions,createSession:()=>{const s=session.fromPartition('weiyue-account-'+crypto.randomUUID());hardenSession(s);return s;},readCookies:id=>secrets(id).cookies||[],officialUrl});
function preferences(){try{return JSON.parse(fs.readFileSync(path.join(dataRoot,'preferences.json'),'utf8'));}catch{return {};}}
function clearMedia(){accountEpoch++;for(const job of imageJobs.values())job.controller.abort();imageCache.clear();cachedImageBytes=0;}
function setActive(id){const changed=activeId!==id;activeId=id;fs.writeFileSync(path.join(dataRoot,'preferences.json'),JSON.stringify({activeId:id}));if(changed){clearMedia();revision++;configureAutomatic();}}
function account(){return store.get(activeId);}
function secrets(id=activeId){return vault.read(id);}
function publicReadStats(id=activeId,groupId){const all=store.getReadStats(id,groupId);const clean=s=>{const {unreadIds,...rest}=s;return rest;};return groupId===undefined?Object.fromEntries(Object.entries(all).map(([key,value])=>[key,clean(value)])):clean(all);}
function snapshot(){
  const s=account(); let sec={};let credentialError='';try{sec=secrets();}catch(e){credentialError=e.message;}
  const readStates=publicReadStats();
  return {accounts:store.accounts(),account:s.account,groups:s.groups.map(g=>({...g,...readStates[g.id]})),readPositions:s.readPositions,readStates,importantMembers:s.importantMembers,settings:s.settings,stats:{messages:s.messages.length,bookmarks:s.bookmarks.length,summaries:s.summaries.length},sessionReady:!!sec.cookies?.length,credentials:{ai:!!sec.aiKey,notion:!!sec.notionToken},credentialError,dataRoot,revision};
}
function syncStatus(){return {...(autoSync?.status()||{enabled:false,intervalMs:60000,running:false}),running:!!activeSync||!!autoSync?.status().running,accountId:activeId,revision};}
function configureAutomatic(){
  if(!store||!activeId)return;
  const owner=activeId;
  autoSync=automaticAccounts.activate(owner,()=>{
    const controller=new AutoSync({run:()=>runSync({},true),isBusy:()=>busy||enrichmentJobs.size>0,
      isEligible:()=>{if(activeId!==owner||closing())return false;const s=store.get(owner);return s.account.kind==='weibo'&&s.groups.some(g=>g.selected)&&!!secrets(owner).cookies?.length;}});
    controller.configure({enabled:account().account.kind==='weibo'&&account().settings.autoSyncEnabled!==false,intervalMs:60000});
    return controller;
  });
}
function closing(){return closeReady||!!closeTimer;}
async function runSync(p={},automatic=false){
  if(busy||enrichmentJobs.size){const e=new Error('已有操作正在进行，请稍后再同步。');e.code='SYNC_BUSY';throw e;}
  const id=activeId,state=account();if(state.account.kind!=='weibo')throw new Error('演示与导入账号不连接微博。请先登录官方账号。');
  if(!state.groups.some(g=>g.selected&&(!p.groupId||g.id===p.groupId)))throw new Error('请先选择允许同步的群聊。');
  busy=true;const controller=new AbortController();activeSync={controller,automatic};const check=()=>{if(controller.signal.aborted){const e=new Error('同步已取消，已保存的页面仍保留。');e.code='ABORTED';throw e;}};
  const timer=setTimeout(()=>controller.abort(),automatic?45000:120000);
  try{
    const s=await accountSession(id,{check}),c=client(s,{timeoutMs:12000,maxAttempts:automatic?1:2}),identity=await c.identity({signal:controller.signal});check();
    if('weibo-'+identity.id!==id){const e=new Error('登录账号与本地账号不一致，请重新登录。');e.code='ACCOUNT_MISMATCH';throw e;}
    const result=await syncAccount({store,accountId:id,client:c,groupId:p.groupId,history:!!p.history,maxPages:automatic?3:10,signal:controller.signal,onChange:()=>revision++});check();
    await rememberCookies(id,s);return {...result,state:snapshot()};
  }finally{clearTimeout(timer);busy=false;activeSync=null;}
}
const mediaToken=id=>crypto.createHash('sha256').update(String(id)).digest('hex').slice(0,32);
function decorateMessage(m,id=activeId){
  const images=(list,section)=>(list||[]).map((image,index)=>{const base='app://media/'+[mediaToken(id),m.groupId,m.id,section,index].map(encodeURIComponent).join('/');return {...image,src:base+'/preview',originalSrc:base+'/original'};});
  return {...m,...(m.images?{images:images(m.images,'message')}:{}),...(m.sharedPost?{sharedPost:{...m.sharedPost,images:images(m.sharedPost.images,'post')}}:{})};
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
async function serveImage(request,u){
  const id=activeId,epoch=accountEpoch;let parts;try{parts=u.pathname.slice(1).split('/').map(decodeURIComponent);}catch{return new Response('Invalid image',{status:400});}
  if(request.method!=='GET'||parts.length!==6||parts[0]!==mediaToken(id)||!['message','post'].includes(parts[3])||!/^\d{1,3}$/.test(parts[4])||!['preview','original'].includes(parts[5]))return new Response('Not found',{status:404});
  const state=store.get(id),m=state.messages.find(m=>m.groupId===parts[1]&&m.id===parts[2]);const descriptor=(parts[3]==='post'?m?.sharedPost?.images:m?.images)?.[Number(parts[4])];
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
          const value=await fetchImage({url,fetch:(target,options)=>imageRequest(s,target,options),signal:controller.signal});if(epoch!==accountEpoch)throw new Error('Canceled');
          while(cachedImageBytes+value.bytes.length>64*1024*1024&&imageCache.size){const oldest=imageCache.keys().next().value;cachedImageBytes-=imageCache.get(oldest).bytes.length;imageCache.delete(oldest);}
          imageCache.set(key,value);cachedImageBytes+=value.bytes.length;return value;
        }finally{if(acquired){activeImages--;imageWaiters.shift()?.();}if(imageJobs.get(key)===job)imageJobs.delete(key);}
      })();imageJobs.set(key,job);
    }
    try{cached=await job.promise;}catch{return new Response('Image unavailable; retry or view in Weibo',{status:502,headers:{'Cache-Control':'no-store'}});}
  }else{imageCache.delete(key);imageCache.set(key,cached);}
  if(epoch!==accountEpoch||id!==activeId)return new Response('Account changed',{status:403});
  return new Response(cached.bytes,{headers:{'Content-Type':cached.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'app://local'}});
}
async function enrichMessages(id,p){
  if(account().account.kind!=='weibo')return {count:0};if(!Array.isArray(p.messageIds)||p.messageIds.length>10)throw new Error('每次最多补全 10 条已存消息。');
  const key=id+'|'+String(p.groupId);if(enrichmentJobs.has(key))return enrichmentJobs.get(key);if(busy)return {count:0,deferred:true};
  const epoch=accountEpoch;const check=()=>{if(id!==activeId||epoch!==accountEpoch||closing())throw new Error('账号已变化，补全已停止。');};
  const job=(async()=>{
    const state=store.get(id),targets=[...new Set(p.messageIds)].map(mid=>state.messages.find(m=>m.groupId===p.groupId&&m.id===mid)).filter(Boolean);if(!targets.length)return {count:0};
    const s=await accountSession(id,{check}),c=client(s,{timeoutMs:10000,maxAttempts:1});check();const identity=await c.identity();check();if('weibo-'+identity.id!==id)throw new Error('登录账号不一致，请重新登录。');let count=0;
    for(const old of targets){check();const attemptKey=key+'|'+old.id;if(old.mediaVersion===1&&!p.retry)continue;if(Date.now()-(enrichmentAttempts.get(attemptKey)||0)<60000)continue;enrichmentAttempts.set(attemptKey,Date.now());
      const detail=await c.messageDetail(old.groupId,old.id);check();const patch={...old,mediaVersion:1};if(detail.images)patch.images=detail.images;if(detail.sharedPost)patch.sharedPost=detail.sharedPost;
      store.mergeMessages(id,[],[patch],{history:true});revision++;count++;if(count<targets.length)await new Promise(r=>setTimeout(r,350));
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
function summaryFor(p){const s=account();return prepareSummary({messages:s.messages.filter(m=>m.groupId===p.groupId),group:group(s,p.groupId),start:Number(p.start),end:Number(p.end)});}
async function confirmSend(message,detail){const r=await dialog.showMessageBox(win,{type:'question',title:'确认发送内容',message,detail,buttons:['取消','确认发送'],defaultId:0,cancelId:0,noLink:true});if(r.response!==1)throw new Error('已取消，未发送内容。');}
function saveSummary(id,s){store.update(id,state=>{state.summaries.unshift(s);});return s;}
async function saveText(defaultPath,text,extensions){const r=await dialog.showSaveDialog(win,{defaultPath,filters:[{name:'导出文件',extensions}]});if(r.canceled)return {canceled:true};fs.writeFileSync(r.filePath,text,'utf8');return {path:r.filePath};}
async function handle(action,p){
  const id=activeId;
  if(busy&&['account.switch','demo','login.open','login.complete','logout','settings.save','settings.ai.save','import','groups.select'].includes(action))throw new Error('操作正在进行，请完成后再切换账号或设置。');
  switch(action){
    case 'state':return snapshot();
    case 'ai.providers':return listAiProviders();
    case 'account.switch':if(!store.accounts().some(a=>a.id===p.id))throw new Error('账号不存在');setActive(p.id);return snapshot();
    case 'demo':{const a=store.seedDemo();setActive(a.id);return snapshot();}
    case 'groups.select':{if(!Array.isArray(p.ids))throw new Error('请选择群聊');store.update(id,s=>{s.groups.forEach(g=>g.selected=p.ids.includes(g.id));});revision++;return snapshot();}
    case 'messages.query':{const result=store.queryMessages(id,p);return {...result,messages:result.messages.map(m=>decorateMessage(m,id))};}
    case 'messages.enrich':return enrichMessages(id,p);
    case 'members.list':{const map=new Map();for(const m of account().messages)if(m.groupId===p.groupId)map.set(m.senderId,m.senderName);return [...map].map(([id,name])=>({id,name}));}
    case 'messages.locate':{const s=account();const messages=s.messages.filter(m=>m.groupId===p.groupId).sort((a,b)=>a.time-b.time||(/^\d+$/.test(a.id)&&/^\d+$/.test(b.id)?(BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0):a.id.localeCompare(b.id)));const offset=messages.findIndex(m=>m.id===p.messageId);if(offset<0)throw new Error('原文未在本机找到，请补充同步或重新导入。');return {message:decorateMessage(messages[offset],id),offset};}
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
    case 'summary.ai':{
      if(busy)throw new Error('已有操作正在进行。');const pre=summaryFor(p),settings=account().settings,requestProfile=prepareAiRequest(settings),sec=secrets(id),key=assertAiKeyScope(settings,sec);
      busy=true;try{await confirmSend('将所选群聊时段发送至你的 AI 服务',`服务：${requestProfile.url}\n实际模型 ID：${requestProfile.model}${requestProfile.modelAliasResolved?'（由已配置的显示名称解析，原设置保留）':''}\n消息：${pre.messages.length} 条，${pre.chunks.length} 块\n每块生成上限：4096 token${requestProfile.provider==='openai'?'（含推理 token）':''}\n内容包含成员名称、时间和消息文本。服务可能计费。仅本次发送，无定时调用；失败不会自动重试或切换模型。`);return saveSummary(id,await aiSummary(pre,{endpoint:settings.endpoint,key,model:settings.model,fetch:net.fetch}));}finally{busy=false;}
    }
    case 'summary.list':return account().summaries;
    case 'summary.export':{const s=account().summaries.find(s=>s.id===p.summaryId);if(!s)throw new Error('摘要不存在');return saveText('微阅摘要.md',s.body+'\n\n'+s.refs.map(r=>`[${r.label||r.id}] ${r.groupId}/${r.id} ${new Date(r.time).toISOString()}\n${r.text}`).join('\n\n'),['md']);}
    case 'settings.ai.save':{
      const next=prepareAiSettingsSave(account().settings,secrets(id),p);
      vault.write(id,next.credentials);store.update(id,s=>{s.settings=next.settings;});return snapshot();
    }
    case 'settings.save':{
      const settings=account().settings;busy=true;try{
        let sec,reset=false;try{sec=secrets(id);}catch(error){if(!p.resetUnreadable)throw error;const r=await dialog.showMessageBox(win,{type:'warning',title:'重新初始化本账号凭据',message:'清除无法解密的旧凭据并重新配置？',detail:'这会替换当前账号的旧 Cookie、AI Key 和 Notion Token。聊天、收藏和摘要保留，需要重新登录微博。',buttons:['取消','重新初始化'],defaultId:0,cancelId:0});if(r.response!==1)throw new Error('已取消凭据重置');sec={};reset=true;sessionRegistry.invalidate(id);}
        if(p.deleteSecrets){delete sec.aiKey;delete sec.aiKeyScope;delete sec.notionToken;}else if(p.notionToken)sec.notionToken=String(p.notionToken).trim();
        const legacyPayload=p.deleteSecrets&&Object.prototype.hasOwnProperty.call(p,'aiKey')?{...p,aiKey:''}:p;
        const next=prepareLegacyAiSettingsSave(settings,sec,legacyPayload,{allowMissingKey:!!p.deleteSecrets||reset});
        vault.write(id,next.credentials);store.update(id,s=>{s.settings=next.settings;});return snapshot();
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
    case 'sync.status':return syncStatus();
    case 'sync.configure':{if(typeof p.enabled!=='boolean')throw new Error('请指定自动更新开关。');store.update(id,s=>{s.settings.autoSyncEnabled=p.enabled;});if(!p.enabled&&activeSync?.automatic)activeSync.controller.abort();autoSync.configure({enabled:p.enabled,intervalMs:60000});return syncStatus();}
    case 'window.closeReady':if(closeTimer){clearTimeout(closeTimer);closeTimer=null;closeReady=true;win.close();}return true;
    case 'login.complete':{
      if(!pendingLogin&&account().account.kind!=='weibo')throw new Error('请先打开官方登录窗口并自行完成登录。');
      let loginSession=pendingLogin;busy=true;try{
      return await loginFlow.run({client:async({check})=>{
        if(!loginSession)loginSession=await accountSession(id,{check});check();pendingLogin=loginSession;
        return client(loginSession,{timeoutMs:12000,maxAttempts:2});
      },save:async({identity,groups,check})=>{
        const cookies=(await loginSession.cookies.get({})).filter(c=>officialUrl('https://'+c.domain.replace(/^\./,'')));check();const newId='weibo-'+identity.id;
        store.ensureAccount({id:newId,name:identity.name,kind:'weibo'});vault.write(newId,{...secrets(newId),cookies});sessionRegistry.adopt(newId,loginSession);
        store.mergeMessages(newId,groups,[]);setActive(newId);if(pendingLogin===loginSession)pendingLogin=null;if(loginWindow&&!loginWindow.isDestroyed())loginWindow.close();return snapshot();
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
        await confirmSend('向所选 Notion 页面导出编辑内容',`目标页面 ID：${targetId}\n标题：${draft.title}\n来源：${preview.sourceType==='bookmarks'?`${preview.sourceIds.length} 项价值收藏`:'已保存摘要'}\n编辑正文：${draft.body.length} 字符\n引用原文与本地定位：${draft.includeReferences?`包含 ${preview.sourceCount} 条`:'不包含'}\n新稿会在目标下创建子页面；未完成的原稿只向原页面续传。完全相同的编辑稿复用已完成结果，修改内容会生成新导出版本；未完成或结果不确定的旧稿不能被绕过。`);
        if(activeId!==id)throw new Error('当前账号已变化，请重新打开导出预览。');
        const state=store.get(id),freshSource=resolveNotionSource(state,selection);
        if(buildPreview(freshSource,targetId,{draft}).sourceHash!==sourceHash)throw new Error('导出来源已变化，请重新打开导出预览并核对内容。');
        const token=secrets(id).notionToken;if(!token)throw new Error('请先配置 Notion Token。');
        return await new NotionClient({token,fetch:net.fetch}).exportSummary(freshSource,targetId,{draft,sourceHash,journal:state.exports,saveJournal:journal=>store.update(id,s=>{s.exports=journal;})});
      }finally{busy=false;}
    }
    case 'external.open':{if(!safeExternal(p.url))throw new Error('仅允许 HTTPS 网页链接');const r=await dialog.showMessageBox(win,{type:'question',message:'在系统浏览器打开链接？',detail:p.url,buttons:['取消','打开'],defaultId:0,cancelId:0});if(r.response===1)await shell.openExternal(p.url);return true;}
    default:throw new Error('不支持的操作');
  }
}
async function start(){
  store=new Store(path.join(dataRoot,'accounts'));vault=new Vault(path.join(dataRoot,'credentials'),safeStorage);
  const all=store.accounts();if(!all.length)store.seedDemo();const saved=preferences().activeId;setActive(store.accounts().some(a=>a.id===saved)?saved:store.accounts()[0].id);
  protocol.handle('app',request=>{const u=new URL(request.url);if(u.host==='media')return serveImage(request,u);if(u.host!=='local'||!['/index.html','/app.js','/style.css','/reading-state.js'].includes(u.pathname))return new Response('Not found',{status:404});return net.fetch(pathToFileURL(path.join(__dirname,'renderer',u.pathname.slice(1))).href);});
  hardenSession(session.defaultSession);Menu.setApplicationMenu(null);
  win=new BrowserWindow({width:1440,height:930,minWidth:1000,minHeight:680,title:'微阅',backgroundColor:'#f6f5f0',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.on('will-attach-webview',e=>e.preventDefault());
  win.on('close',event=>{if(closeReady)return;event.preventDefault();if(closeTimer)return;autoSync?.stop();activeSync?.controller.abort();clearMedia();closeTimer=setTimeout(()=>{closeTimer=null;closeReady=true;win.close();},2000);win.webContents.send('weiyue:before-close');});
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

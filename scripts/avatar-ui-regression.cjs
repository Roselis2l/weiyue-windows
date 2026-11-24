'use strict';
// Real copied renderer + synthetic IPC, generated PNGs and an isolated profile.
// No production main, vault, account store or external service is opened.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const root=path.resolve(__dirname,'..'),version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const evidence=fs.mkdtempSync(path.join(root,'artifacts','avatar-ui-'+version+'-'));
const harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-avatar-ui-'));
fs.cpSync(path.join(root,'vendor/runtime'),path.join(harness,'runtime'),{recursive:true});
fs.mkdirSync(path.join(harness,'renderer'));
const hashes={};
for(const name of ['index.html','style.css','app.js','reading-state.js','filter-controls.js','linkify.js','emoticons.js','emoticon-manifest.js']){
  const bytes=fs.readFileSync(path.join(root,'app/renderer',name));
  fs.writeFileSync(path.join(harness,'renderer',name),bytes);hashes[name]=crypto.createHash('sha256').update(bytes).digest('hex');
}
fs.writeFileSync(path.join(harness,'preload.cjs'),`
'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('api',Object.freeze({
  call:async(action,payload={})=>{const r=await ipcRenderer.invoke('avatar:call',action,payload);if(!r.ok)throw Error(r.error);return r.value;},
  onBeforeClose:()=>()=>{}
}));
`);
function boot(){
  const {app,BrowserWindow,ipcMain,protocol,session,nativeImage}=require('electron'),path=require('node:path');
  app.setPath('userData',path.join(__dirname,'isolated-profile'));
  protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
  const accounts=['a','b'].map(id=>({id:'avatar-owner-'+id,name:'合成头像帐号 '+id,kind:'weibo'}));
  const groupIds=['group/one','group-two'],memberIds=['member/one','member-two','member-three','member-four','member-five','member-six'];
  const source=(owner,kind,id,version='v1')=>'app://avatar/'+owner+'/'+kind+'/'+encodeURIComponent(id)+'/'+version;
  const profiles=accounts.map(account=>{
    const groups=groupIds.map(id=>({id,name:'同名测试群',selected:true,avatarSrc:source(account.id,'group',id)}));
    const data={};
    for(const groupId of groupIds)data[groupId]=Array.from({length:72},(_,index)=>({
      id:String(9007199254741500000n+BigInt(index)),groupId,senderId:memberIds[index%6],senderName:'同名成员',
      senderAvatarSrc:source(account.id,'member',memberIds[index%6]),senderAvatarUrl:'https://invalid.example/AVATAR-MUST-NOT-BE-SENT',
      time:Date.UTC(2026,9,20,9,index),text:'合成头像布局消息 '+index+'。这里只含离线测试数据。',mediaVersion:1
    }));
    const readStates=Object.fromEntries(groupIds.map(id=>[id,{anchorId:data[id][12].id,anchorOffset:0,atBottom:false,readThroughId:data[id][0].id,unreadCount:0}]));
    return {account,groups,data,readStates};
  });
  let active=0;
  const current=()=>profiles[active];
  const info=globalThis.__avatarMock={calls:[],requests:[],blocked:[],revision:0,held:[],recovered:new Set(),profiles,memberIds,groupIds,source,
    get current(){return current();},
    change(kind,id,version,override){
      const profile=current(),src=override===undefined?source(profile.account.id,kind,id,version):override;
      if(kind==='group')profile.groups.find(g=>g.id===id).avatarSrc=src;
      else for(const messages of Object.values(profile.data))for(const m of messages)if(m.senderId===id){m.senderAvatarSrc=src;m.senderAvatarUrl='https://invalid.example/AVATAR-MUST-NOT-BE-SENT-'+version;}
      this.revision++;return {revision:this.revision,source:src};
    },
    release(){for(const resolve of this.held.splice(0))resolve();}
  };
  const snapshot=()=>{const p=current();return{
    account:p.account,accounts,groups:p.groups.map(g=>({...g,unreadCount:0,coverage:{oldest:p.data[g.id][0].time,newest:p.data[g.id].at(-1).time,complete:false}})),
    stats:{messages:144,bookmarks:0,summaries:0},readPositions:Object.fromEntries(groupIds.map(id=>[id,p.readStates[id].anchorId])),
    readStates:p.readStates,importantMembers:[],settings:{},credentials:{},sessionReady:true,dataRoot:path.join(__dirname,'isolated-profile')
  };};
  ipcMain.handle('avatar:call',async(_event,action,payload={})=>{
    info.calls.push({action,payload,revision:info.revision});
    try{
      const p=current(),messages=p.data[payload.groupId]||[];
      let value;
      switch(action){
        case 'state':value=snapshot();break;
        case 'messages.query':value={messages:messages.slice(payload.offset||0,(payload.offset||0)+(payload.limit||160)),total:messages.length};break;
        case 'messages.locate':{const offset=messages.findIndex(m=>m.id===payload.messageId);value={offset,message:messages[offset]};break;}
        case 'members.list':value=memberIds.map(id=>({id,name:'同名成员'}));break;
        case 'read.set':Object.assign(p.readStates[payload.groupId],payload);value=p.readStates[payload.groupId];break;
        case 'sync.status':value={accountId:p.account.id,revision:info.revision,enabled:true,intervalMs:60000};break;
        case 'sync.configure':value={accountId:p.account.id,revision:info.revision,enabled:payload.enabled,intervalMs:60000};break;
        case 'account.switch':active=accounts.findIndex(a=>a.id===payload.id);if(active<0)throw Error('Unknown mock account');info.revision++;value=snapshot();break;
        case 'messages.enrich':value={count:0};break;
        case 'window.closeReady':value=true;break;
        default:throw Error('Unexpected mock action: '+action);
      }
      return{ok:true,value};
    }catch(error){return{ok:false,error:error.message};}
  });
  app.whenReady().then(()=>{
    const bitmap=Buffer.alloc(24*24*4);
    for(let y=0;y<24;y++)for(let x=0;x<24;x++){const i=(y*24+x)*4;bitmap[i]=70+x*6;bitmap[i+1]=110+y*4;bitmap[i+2]=190;bitmap[i+3]=255;}
    const png=nativeImage.createFromBitmap(bitmap,{width:24,height:24}).toPNG();
    protocol.handle('app',async request=>{
      const u=new URL(request.url);info.requests.push(u.href);
      if(u.hostname!=='avatar')return new Response('',{status:404});
      if(u.pathname.endsWith('/hold'))await new Promise(resolve=>info.held.push(resolve));
      return new Response(u.pathname.endsWith('/bad')&&!info.recovered.has(u.href)?Buffer.from('invalid synthetic image'):png,{headers:{'content-type':'image/png','cache-control':'no-store'}});
    });
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{info.blocked.push(details.url);callback({cancel:true});});
    session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    session.defaultSession.on('will-download',event=>event.preventDefault());
    const win=new BrowserWindow({width:1440,height:960,show:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.loadFile(path.join(__dirname,'renderer/index.html'));
  });
  app.on('window-all-closed',()=>app.quit());
}
fs.writeFileSync(path.join(harness,'main.cjs'),'('+boot.toString()+')();\n');
let application,page,failure,nativeRecord;
const checks=[],errors=[],observations=[];
const check=text=>{checks.push(text);console.log('PASS '+text);};
const snapshot=()=>page.evaluate(()=>{
  const scroll=document.getElementById('message-scroll'),top=scroll.getBoundingClientRect().top;
  const first=[...scroll.querySelectorAll('article')].find(el=>el.getBoundingClientRect().bottom>top+1);
  return{id:first?.dataset.messageId,offset:first?.getBoundingClientRect().top-top,scrollTop:scroll.scrollTop,height:scroll.scrollHeight};
});
async function change(kind,id,version,override){
  const result=await application.evaluate((_electron,args)=>globalThis.__avatarMock.change(...args),[kind,id,version,override]);
  await application.evaluate(async(_electron,revision)=>{
    for(let attempt=0;attempt<120;attempt++){
      if(globalThis.__avatarMock.calls.some(call=>call.action==='members.list'&&call.revision>=revision))return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Avatar refresh did not finish patching messages');
  },result.revision);
  return result;
}
async function waitSource(kind,id,source){
  await page.waitForFunction(({kind,id,source})=>{
    const matches=[...document.querySelectorAll('[data-avatar-kind]')].filter(el=>el.dataset.avatarKind===kind&&el.dataset.avatarId===id);
    return matches.length>0&&matches.every(el=>source?el.querySelector('img')?.getAttribute('src')===source:!el.querySelector('img'));
  },
  {kind,id,source},{timeout:10000});
}
async function stable(before,label){
  const after=await snapshot();assert.equal(after.id,before.id,label);assert.ok(Math.abs(after.offset-before.offset)<=2,label+': anchor drift');
  assert.ok(Math.abs(after.height-before.height)<=2,label+': layout height changed');observations.push({label,before,after});
}
(async()=>{
  try{
    const executablePath=path.join(harness,'runtime/electron.exe'),preflight=assertWindowsRuntimeReadable(executablePath),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    application=await _electron.launch({executablePath,args:[path.join(harness,'main.cjs')],cwd:harness,env,timeout:30000});
    const native=application.process();nativeRecord={pid:native.pid,preflight};native.once('exit',(exitCode,signal)=>Object.assign(nativeRecord,{exitCode,signal}));
    page=await application.firstWindow();page.on('pageerror',error=>errors.push(error.message));
    await page.waitForSelector('article[data-message-id] .avatar img.is-loaded');
    await page.waitForFunction(()=>document.querySelectorAll('.group-avatar img.is-loaded').length===2);
    assert.deepEqual(await page.evaluate(()=>({require:typeof require,process:typeof process})),{require:'undefined',process:'undefined'});
    const prefs=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
    check('Real renderer uses an isolated mock account with sandbox/context isolation and only app://avatar images');
    await page.locator('#message-scroll').evaluate(el=>{el.scrollTop+=70;});await page.waitForTimeout(800);
    const identity=await page.evaluate(()=>{
      const groups=[...document.querySelectorAll('#group-list .group-item')].map(el=>({id:el.dataset.groupId,src:el.querySelector('img')?.getAttribute('src'),name:el.querySelector('.group-name').textContent}));
      const avatars=[...document.querySelectorAll('article .avatar')].map(el=>({id:el.dataset.avatarId,src:el.querySelector('img')?.getAttribute('src')}));
      return{groups,avatars};
    });
    assert.equal(new Set(identity.groups.map(g=>g.name)).size,1);
    assert.equal(new Set(identity.groups.map(g=>g.src)).size,2);
    for(const a of identity.avatars)assert.equal(decodeURIComponent(new URL(a.src).pathname.split('/')[3]),a.id);
    assert.equal(new Set(identity.avatars.map(a=>a.id)).size,6);
    check('Identical display names remain associated with distinct stable group/member IDs, including encoded slash IDs');
    const dimensions=await page.evaluate(()=>[...document.querySelectorAll('.group-avatar,article .avatar')].map(el=>{
      const rect=el.getBoundingClientRect(),img=el.querySelector('img'),style=img&&getComputedStyle(img);
      return{kind:el.dataset.avatarKind,width:rect.width,height:rect.height,lazy:img?.loading,position:style?.position,fit:style?.objectFit};
    }));
    for(const d of dimensions){assert.equal(d.width,d.kind==='group'?31:33);assert.equal(d.height,d.width);assert.equal(d.lazy,'lazy');assert.equal(d.position,'absolute');assert.equal(d.fit,'cover');}
    check('Avatar containers retain fixed 31/33 px geometry; lazy images cover absolutely without affecting message layout');

    await page.evaluate(()=>{
      const article=document.querySelector('article');article.querySelector('.message-check').click();
      window.__avatarRefs={articles:[...document.querySelectorAll('article')],search:document.getElementById('message-search'),scroll:document.getElementById('message-scroll'),groups:[...document.querySelectorAll('#group-list .group-item')],note:document.getElementById('bookmark-note')};
    });
    await page.locator('#bookmark-note').fill('合成头像更新时保留的草稿');
    const before=await snapshot();
    const updated=await change('member','member/one','v2');await waitSource('member','member/one',updated.source);
    const groupUpdated=await change('group','group/one','v2');await waitSource('group','group/one',groupUpdated.source);
    await stable(before,'avatar-only update');
    assert.deepEqual(await page.evaluate(()=>({articles:window.__avatarRefs.articles.every((el,i)=>el===[...document.querySelectorAll('article')][i]),
      groups:window.__avatarRefs.groups.every((el,i)=>el===[...document.querySelectorAll('#group-list .group-item')][i]),
      search:window.__avatarRefs.search===document.getElementById('message-search'),scroll:window.__avatarRefs.scroll===document.getElementById('message-scroll'),
      note:window.__avatarRefs.note===document.getElementById('bookmark-note'),value:document.getElementById('bookmark-note').value,
      selected:document.querySelector('article .message-check').checked})),
    {articles:true,groups:true,search:true,scroll:true,note:true,value:'合成头像更新时保留的草稿',selected:true});
    check('Avatar-only updates preserve every article/group node, search/scroll/composer identity, selection, draft and reading anchor');

    const missing=await change('member','member-two','none','');await waitSource('member','member-two','');
    await change('member','member-three','bad');
    const failedCard=page.locator('article').filter({has:page.locator('.avatar[data-avatar-id="member-three"]')}).first();
    await failedCard.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>{const el=document.querySelector('.avatar[data-avatar-id="member-three"]');return el&&!el.querySelector('img')&&!el.classList.contains('has-image');});
    assert.ok(await page.locator('.avatar[data-avatar-id="member-three"] .avatar-letter').first().isVisible());
    assert.ok(await page.locator('.avatar[data-avatar-id="member-two"] .avatar-letter').first().isVisible());
    const failedCount=await application.evaluate(()=>globalThis.__avatarMock.requests.filter(url=>url.endsWith('/bad')).length);
    await change('group','group-two','v2');await page.waitForTimeout(2600);
    assert.equal(await application.evaluate(()=>globalThis.__avatarMock.requests.filter(url=>url.endsWith('/bad')).length),failedCount);
    check('Missing and broken avatars show the existing letter/color fallback and a routine refresh does not repeatedly retry failed bytes');

    // Freeze only the isolated renderer clock, then advance it to the precise
    // cooldown boundary. No wall-clock wait or production profile is involved.
    await page.evaluate(()=>{
      const original=Date.now;
      window.__avatarClock={base:original(),offset:0,restore:()=>{Date.now=original;}};
      Date.now=()=>window.__avatarClock.base+window.__avatarClock.offset;
      window.__failedGroup=document.querySelector('.group-avatar[data-avatar-id="group-two"]');
    });
    const recoveryBefore=await snapshot(),failedGroup=await change('group','group-two','bad');
    await page.waitForFunction(()=>{const host=window.__failedGroup;return host&&!host.querySelector('img')&&!host.classList.contains('has-image');});
    const requestsFor=source=>application.evaluate((_electron,source)=>globalThis.__avatarMock.requests.filter(url=>url===source).length,source);
    const beforeRecoveryCount=await requestsFor(failedGroup.source);
    assert.equal(beforeRecoveryCount,1);
    await application.evaluate((_electron,source)=>globalThis.__avatarMock.recovered.add(source),failedGroup.source);
    await page.evaluate(()=>{window.__avatarClock.offset=59999;});
    await change('group','group-two','bad');
    assert.equal(await requestsFor(failedGroup.source),beforeRecoveryCount,'Same-source failure must stay quiet before 60 seconds');
    assert.equal(await page.evaluate(()=>window.__failedGroup.querySelector('img')===null),true);
    await page.evaluate(()=>{window.__avatarClock.offset=60000;});
    await change('group','group-two','bad');
    await page.waitForFunction(source=>{
      const host=window.__failedGroup,img=host?.querySelector('img');
      return img?.getAttribute('src')===source&&img.classList.contains('is-loaded')&&host.classList.contains('has-image');
    },failedGroup.source);
    assert.equal(await requestsFor(failedGroup.source),beforeRecoveryCount+1,'Cooldown expiry permits one fresh attempt');
    await page.evaluate(()=>{window.__recoveredImage=window.__failedGroup.querySelector('img');});
    await change('group','group-two','bad');
    assert.equal(await requestsFor(failedGroup.source),beforeRecoveryCount+1);
    assert.equal(await page.evaluate(()=>window.__failedGroup===document.querySelector('.group-avatar[data-avatar-id="group-two"]')&&window.__recoveredImage===window.__failedGroup.querySelector('img')),true);
    await stable(recoveryBefore,'failed avatar recovery');
    await page.evaluate(()=>{window.__avatarClock.restore();delete window.__avatarClock;});
    check('A failed same-source group avatar retries exactly once after 60 seconds, recovers in place, and preserves its successful image on later refresh');

    const rejects=['https://invalid.example/AVATAR-MUST-NOT-BE-SENT','data:image/png;base64,AAAA','app://media/a/member/member-four/v1',
      'app://avatar/a/member/member-five/v1','app://user@avatar/a/member/member-four/v1','app://avatar:80/a/member/member-four/v1'];
    for(const [index,value] of rejects.entries()){
      const valid=await change('member','member-four','valid-before-reject-'+index);await waitSource('member','member-four',valid.source);
      await change('member','member-four','rejected',value);await waitSource('member','member-four','');
    }
    assert.deepEqual(await application.evaluate(()=>globalThis.__avatarMock.blocked),[]);
    const requested=await application.evaluate(()=>globalThis.__avatarMock.requests);
    assert.ok(rejects.every(value=>!requested.includes(value)),'Rejected avatar must not reach a local protocol handler');
    check('External/data/other-host/credential/port and mismatched-member avatar URLs are rejected before an image request');

    const slow=await change('member','member-five','hold');await waitSource('member','member-five',slow.source);
    const slowCard=page.locator('article').filter({has:page.locator('.avatar[data-avatar-id="member-five"]')}).first();
    await slowCard.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>{const img=document.querySelector('.avatar[data-avatar-id="member-five"] img');return img&&!img.complete;});
    const slowBefore=await snapshot();
    await page.evaluate(()=>{
      const host=document.querySelector('.avatar[data-avatar-id="member-five"]');
      window.__oldAvatar=host.querySelector('img');window.__oldAvatarHost=host;
    });
    await application.evaluate(async(_electron,source)=>{
      for(let attempt=0;attempt<100;attempt++){
        if(globalThis.__avatarMock.requests.includes(source))return;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw Error('Pending avatar request did not start');
    },slow.source);
    const pendingCount=await requestsFor(slow.source);
    await page.evaluate(()=>{
      const original=Date.now;
      window.__pendingAvatarClock=()=>{Date.now=original;};
      Date.now=()=>original()+120000;
    });
    await change('member','member-five','hold');
    assert.equal(await page.evaluate(()=>window.__oldAvatar===window.__oldAvatarHost.querySelector('img')),true);
    assert.equal(await requestsFor(slow.source),pendingCount,'A loading avatar must not restart after elapsed cooldown time');
    await page.evaluate(()=>{window.__pendingAvatarClock();delete window.__pendingAvatarClock;});
    check('An unchanged loading avatar retains its pending image and request across later refreshes');
    const replacement=await change('member','member-five','v3');await waitSource('member','member-five',replacement.source);
    await page.waitForFunction(()=>document.querySelector('.avatar[data-avatar-id="member-five"] img')?.classList.contains('is-loaded'));
    await page.evaluate(()=>{window.__oldAvatar.dispatchEvent(new Event('error'));window.__oldAvatar.dispatchEvent(new Event('load'));});
    await application.evaluate(()=>globalThis.__avatarMock.release());await page.waitForTimeout(300);
    assert.equal(await page.locator('.avatar[data-avatar-id="member-five"]').first().evaluate(el=>el.classList.contains('has-image')),true);
    assert.equal(await page.locator('.avatar[data-avatar-id="member-five"] img').first().getAttribute('src'),replacement.source);
    await stable(slowBefore,'late avatar completion');
    check('Replacing a delayed request ignores old load/error events; late bytes cannot overwrite or hide the new avatar and geometry stays stable');

    // A real explicit latest action relies on measuredMessages(), not a test stub.
    for(const id of ['member/one','member-two','member-three','member-four','member-five','member-six']){
      const held=await change('member',id,'hold');await waitSource('member',id,held.source);
    }
    const beforeRead=await application.evaluate(()=>({read:globalThis.__avatarMock.current.readStates['group/one'].readThroughId,last:globalThis.__avatarMock.current.data['group/one'].at(-1).id}));
    assert.notEqual(beforeRead.read,beforeRead.last);
    await page.locator('#jump-latest').click();
    await page.waitForFunction(id=>{const image=[...document.querySelectorAll('article')].find(el=>el.dataset.messageId===id)?.querySelector('.avatar img');return image&&!image.complete&&image.getAttribute('src').endsWith('/hold');},beforeRead.last);
    await application.evaluate(async()=>{
      for(let attempt=0;attempt<100;attempt++){
        const p=globalThis.__avatarMock.current;if(p.readStates['group/one'].readThroughId===p.data['group/one'].at(-1).id)return;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw Error('Pending avatar blocked read-through advancement');
    });
    const read=await application.evaluate(()=>({read:globalThis.__avatarMock.current.readStates['group/one'].readThroughId,last:globalThis.__avatarMock.current.data['group/one'].at(-1).id}));
    assert.equal(read.read,read.last);
    const pending=await page.evaluate(id=>![...document.querySelectorAll('article')].find(el=>el.dataset.messageId===id).querySelector('.avatar img').complete,read.last);
    assert.equal(pending,true);
    check('Pending lazy avatars do not block real explicit read-through advancement while chat content is ready');

    await page.selectOption('#account-select','avatar-owner-b');
    await page.waitForFunction(()=>document.querySelector('#group-list img')?.getAttribute('src').includes('/avatar-owner-b/'));
    await page.waitForSelector('article .avatar img.is-loaded');
    await application.evaluate(()=>globalThis.__avatarMock.release());await page.waitForTimeout(300);
    const switched=await page.evaluate(()=>[...document.querySelectorAll('.group-avatar img,article .avatar img')].map(img=>img.getAttribute('src')));
    assert.ok(switched.length>0&&switched.every(src=>src.startsWith('app://avatar/avatar-owner-b/')));
    await page.screenshot({path:path.join(evidence,'synthetic-avatars.png')});
    check('Account switching with reused group/member IDs creates correctly scoped avatars and ignores the previous account late completions');

    const {prepareSummary,prepareAiSummary,aiSummary}=require('../app/core/summary.cjs');
    const {prepareSummaryContent}=require('../app/core/summary-content.cjs');
    const rawMessages=[{
      id:'1',groupId:'g',senderId:'m',senderName:'Fixture member',time:1,text:'Synthetic chat only',
      senderAvatarSrc:'app://avatar/AVATAR-MUST-NOT-BE-SENT',senderAvatarUrl:'https://tvax1.sinaimg.cn/crop.0.0.64.64.180/AVATAR-MUST-NOT-BE-SENT.jpg'
    }];
    const prepared=prepareSummary({group:{id:'g',name:'Fixture',avatarSrc:'app://avatar/AVATAR-MUST-NOT-BE-SENT'},messages:rawMessages,start:0,end:2});
    let avatarLoads=0,detailCalls=0;
    const collected=await prepareSummaryContent(prepared,{messages:rawMessages,includeImages:true,
      loadImage:async()=>{avatarLoads++;throw Error('Avatar must not be collected');},
      client:{messageDetail:async()=>{detailCalls++;throw Error('Avatar must not trigger enrichment');}}});
    assert.equal(avatarLoads,0);assert.equal(detailCalls,0);assert.equal(collected.coverage.imageCount,0);assert.deepEqual(collected.coverage.omissions,[]);
    const ai=prepareAiSummary(prepared,{endpoint:'http://127.0.0.1:9999/v1',model:'mock-avatar',content:collected.content});
    let aiBody;
    await aiSummary(ai,{endpoint:'http://127.0.0.1:9999/v1',model:'mock-avatar',key:'synthetic',fetch:async(_url,options)=>{aiBody=options.body;return Response.json({choices:[{message:{content:'Synthetic summary [M1]'},finish_reason:'stop'}]});}});
    assert.ok(aiBody);assert.doesNotMatch(aiBody,/AVATAR-MUST-NOT-BE-SENT|senderAvatar|avatarSrc|image_url/);
    check('Actual content collector never loads avatars and the AI request builder sends no avatar URL/bytes/image content (in-memory mocks only)');
    assert.deepEqual(errors,[]);assert.deepEqual(await application.evaluate(()=>globalThis.__avatarMock.blocked),[]);
  }catch(error){
    failure=String(error);console.error(failure);
    if(page&&!page.isClosed())await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  }finally{
    const audit=application?await application.evaluate(()=>({calls:globalThis.__avatarMock.calls.map(x=>x.action),requests:globalThis.__avatarMock.requests,blocked:globalThis.__avatarMock.blocked})).catch(()=>null):null;
    if(application){await application.evaluate(()=>globalThis.__avatarMock.release()).catch(()=>{});await application.close().then(()=>nativeRecord.closeAwaited=true).catch(()=>{failure||='Native close failed';});}
    const sourceStillMatches=Object.entries(hashes).every(([name,hash])=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'app/renderer',name))).digest('hex')===hash);
    const passed=!failure&&!errors.length&&sourceStillMatches&&nativeRecord?.exitCode===0&&nativeRecord?.closeAwaited;
    fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed,checks,errors,failure,observations,audit,sourceHashes:hashes,sourceStillMatches,nativeRecord,harness,generatedAt:new Date().toISOString()},null,2));
    console.log(JSON.stringify({passed,checks:checks.length,evidence}));if(!passed)process.exitCode=1;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});

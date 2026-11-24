'use strict';
// Offline final-EXE checks. --long is an explicitly authorized local HEVC file;
// --short and --h264 are synthetic test clips. No screenshots or remote reads.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1],exe=path.resolve(arg('--exe')),output=path.resolve(arg('--output'));
const appRoot=path.join(path.dirname(exe),'resources/app/app'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-hevc147-'));
const fixture={long:path.resolve(arg('--long')),short:path.resolve(arg('--short')),h264:path.resolve(arg('--h264'))};
let application;const checks=[];function pass(name){checks.push(name);console.log('PASS '+name);}
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);}
(async()=>{try{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;require('./windows-runtime-check.cjs').assertWindowsRuntimeReadable(exe);
 application=await _electron.launch({executablePath:exe,args:['--data-dir='+profile],env,timeout:45000});const main=await application.firstWindow();await main.waitForFunction(()=>window.api?.call);
 const state=await main.evaluate(()=>window.api.call('state'));assert.equal(state.account.kind,'demo');assert.equal(state.dataRoot,profile);pass('Isolated demo profile, no real credentials');
 const runtime=await application.evaluate(({app,BrowserWindow})=>({version:app.getVersion(),preferences:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()}));assert.equal(runtime.version,'1.1.47');assert(runtime.preferences.sandbox&&runtime.preferences.contextIsolation&&runtime.preferences.webSecurity&&!runtime.preferences.nodeIntegration);pass('Final EXE version and sandbox');
 await application.evaluate(({app,BrowserWindow,ipcMain,session},f)=>{
  const require=process.getBuiltinModule('node:module').createRequire(f.appRoot+'/main.cjs');const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
  const state=globalThis.__hevc147={requests:[],converts:0,saves:[],fixture:f.fixture,role:'long',owner:'synthetic|1'};
  for(const w of BrowserWindow.getAllWindows())w.webContents.setAudioMuted(true);app.on('web-contents-created',(_,wc)=>wc.setAudioMuted(true));
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(d,cb)=>{state.requests.push('blocked');cb({cancel:true});});
  const core=require(path.join(f.appRoot,'core/attachment-viewer.cjs')),decoder=require(path.join(f.appRoot,'core/video-decoder.cjs')).createVideoDecoder({BrowserWindow,ipcMain,session,appRoot:f.appRoot});
  ipcMain.removeHandler(core.CHANNEL);
  state.manager=core.createAttachmentViewer({BrowserWindow,ipcMain,appRoot:f.appRoot,getOwner:()=>state.owner,readAttachment:()=>({bytes:fs.readFileSync(state.fixture[state.role]),kind:'video',mime:state.role==='long'?'video/quicktime':'video/mp4',name:'synthetic-or-authorized-video.'+(state.role==='long'?'mov':'mp4')}),
   decodeVideo:(v,o)=>{state.converts++;return decoder.decode(v,o);},dialog:{showSaveDialog:async()=>({canceled:false,filePath:path.join(f.profile,'saved.mov')})},writeFile:async(_,bytes)=>{state.saves.push({sameOriginal:hash(bytes)===hash(fs.readFileSync(state.fixture[state.role]))});}});
  state.open=async role=>{state.role=role;await state.manager.open({source:'app://attachment/'+'a'.repeat(32)+'/synthetic/'+role+'/0',kind:'video',title:'Offline HEVC verification'});};
 },{fixture,appRoot,profile});
 async function open(role){await application.evaluate(async(_,role)=>globalThis.__hevc147.open(role),role);await until(()=>application.windows().some(w=>w.url()==='app://local/attachment-viewer.html'),'VIEWER_NOT_OPEN');return application.windows().find(w=>w.url()==='app://local/attachment-viewer.html');}
 async function close(w){await w.evaluate(()=>document.getElementById('close').click());await until(()=>w.isClosed(),'VIEWER_NOT_CLOSED');}
 let w=await open('long');await w.waitForFunction(()=>document.getElementById('status').textContent.includes('100 MiB / 60 秒'),{},{timeout:45000});
 let ui=await w.evaluate(()=>Object.fromEntries(['status','save','convert','retry'].map(id=>{const e=document.getElementById(id);return[id,{text:e.textContent,hidden:e.hidden,disabled:e.disabled}];})));
 assert.match(ui.status.text,/HEVC/);assert.match(ui.status.text,/不代表文件已损坏/);assert.equal(ui.save.disabled,false);assert.equal(ui.convert.hidden,true);assert.equal(ui.retry.hidden,true);assert.equal(await application.evaluate(()=>globalThis.__hevc147.converts),0);pass('Long HEVC shows exact limits and retains Save Original without conversion or redundant retry');
 await w.evaluate(()=>document.getElementById('save').click());await until(async()=>await application.evaluate(()=>globalThis.__hevc147.saves.length===1),'SAVE_NOT_DONE');assert(await application.evaluate(()=>globalThis.__hevc147.saves[0].sameOriginal));pass('Save Original receives byte-identical complete file');
 await application.evaluate(async()=>globalThis.__hevc147.open('long'));assert.equal(application.windows().filter(w=>w.url()==='app://local/attachment-viewer.html').length,1);pass('Repeated open reuses current viewer');await close(w);
 w=await open('h264');await w.waitForFunction(()=>{const v=document.getElementById('video');return v.videoWidth>0&&v.currentTime>.1&&document.getElementById('notice').hidden;});assert.equal(await application.evaluate(()=>globalThis.__hevc147.converts),0);pass('H264 autoplays natively with no HEVC fallback');await close(w);
 w=await open('short');await w.waitForFunction(()=>{const v=document.getElementById('video');return document.getElementById('info').textContent.includes('本机兼容预览')&&v.videoWidth>0&&v.currentTime>.1;},{},{timeout:45000});assert.equal(await application.evaluate(()=>globalThis.__hevc147.converts),1);pass('Short HEVC still converts once offline and plays');await close(w);
 w=await open('h264');await application.evaluate(()=>{const s=globalThis.__hevc147;s.owner='synthetic|2';s.manager.closeInvalid();});await until(()=>w.isClosed(),'STALE_VIEWER_NOT_CLOSED');pass('Account invalidation closes the attachment viewer');
 assert.equal(await application.evaluate(()=>globalThis.__hevc147.requests.length),0);pass('No external network requests');
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({passed:true,checks,version:runtime.version,checkedAt:new Date().toISOString(),screenshots:0,externalRequests:0},null,2));
 }finally{if(application)await application.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
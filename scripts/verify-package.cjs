'use strict';
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
// Verify an extracted portable executable against this source tree, with a new
// local demo profile. No account login or external service is used.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),exe=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]||path.join(root,'artifacts','Final-package-verification.json'));
const appRoot=path.join(path.dirname(exe),'resources/app'),expectedVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function files(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(p,e.name)):[path.join(p,e.name)]);}
(async()=>{
 const source=files(path.join(root,'app'));
 for(const p of source)assert.equal(hash(p),hash(path.join(appRoot,path.relative(root,p))));
 assert.equal(hash(path.join(root,'package.json')),hash(path.join(appRoot,'package.json')));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'WeiYue-final-'+expectedVersion+'-data-'));
 let application;
 try{
  assertWindowsRuntimeReadable(exe);
  application=await _electron.launch({executablePath:exe,args:['--data-dir='+profile],timeout:30000});
  const page=await application.firstWindow();await page.waitForSelector('article[data-message-id]');
  const checks=await page.evaluate(async()=>{const s=await window.api.call('state'),auto=await window.api.call('sync.status');return {demo:s.account.kind==='demo',messageCount:s.stats.messages,nodeUnavailable:typeof require==='undefined'&&typeof process==='undefined',automaticNetworkDisabled:!auto.enabled};});
  assert.equal(checks.demo,true);assert.equal(checks.messageCount,592);assert.equal(checks.nodeUnavailable,true);assert.equal(checks.automaticNetworkDisabled,true);
  const runtime=await application.evaluate(({app,BrowserWindow})=>({version:app.getVersion(),sandbox:BrowserWindow.getAllWindows().every(w=>w.webContents.getLastWebPreferences().sandbox===true)}));
  assert.equal(runtime.version,expectedVersion);assert.equal(runtime.sandbox,true);
  const result={passed:true,executable:exe,...runtime,sourceFileHashesMatched:source.length,packageJsonHashMatched:true,...checks,services:'No network operations requested',checkedAt:new Date().toISOString()};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{if(application)await application.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});

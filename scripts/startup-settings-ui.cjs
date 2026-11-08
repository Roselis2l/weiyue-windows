'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-startup-ui-')),data=path.join(temp,'data');
const evidence=path.join(root,'artifacts','startup-ui');fs.mkdirSync(evidence,{recursive:true});
const main=path.join(root,'app/main.cjs'),core=path.join(root,'app/core/startup-settings.cjs');
fs.writeFileSync(path.join(temp,'boot.cjs'),`
const {app}=require('electron');
const startupModule=require(${JSON.stringify(core)});const original=startupModule.createStartupSettings;
globalThis.startupTest={enabled:false,blocked:false,writes:[],fail:false,delay:0};
startupModule.createStartupSettings=options=>{const state=globalThis.startupTest;const native=original({...options,platform:'win32',app:{isPackaged:true,getLoginItemSettings:()=>({openAtLogin:state.enabled,executableWillLaunchAtLogin:!state.blocked}),setLoginItemSettings:value=>{state.writes.push(value);if(state.fail)throw Error('Synthetic save failure');state.enabled=value.openAtLogin;}}});return {get:native.get,save:async value=>{if(state.delay)await new Promise(r=>setTimeout(r,state.delay));return native.save(value);}};};
require(${JSON.stringify(main)});
`);
(async()=>{let app;const checks=[];try{
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
app=await _electron.launch({executablePath:process.env.WEIYUE_TEST_RUNTIME,args:[path.join(temp,'boot.cjs'),'--data-dir='+data],env,timeout:30000});
const page=await app.firstWindow();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.click('#settings-button');await page.click('#configure-startup');await page.waitForSelector('#startup-enabled');assert.equal(await page.isChecked('#startup-enabled'),false);assert.equal(await app.evaluate(()=>startupTest.writes.length),0);checks.push('Open does not enable startup');
await page.check('#startup-enabled');await page.click('#modal-close');assert.equal(await app.evaluate(()=>startupTest.writes.length),0);checks.push('Cancel discards unsaved selection');
await page.click('#configure-startup');await page.check('#startup-enabled');await app.evaluate(()=>startupTest.delay=500);await page.click('#save-startup');assert.equal(await page.isDisabled('#save-startup'),true);assert.equal(await page.isDisabled('#modal-close'),true);await page.waitForFunction(()=>!document.querySelector('#save-startup').disabled);assert.equal(await app.evaluate(()=>startupTest.writes.length),1);checks.push('Save serializes repeated input and closing');
await page.click('#modal-close');await page.click('#configure-startup');assert.equal(await page.isChecked('#startup-enabled'),true);checks.push('Reopen reads current setting');
await app.evaluate(()=>{startupTest.fail=true;startupTest.delay=0;});await page.uncheck('#startup-enabled');await page.click('#save-startup');await page.waitForFunction(()=>document.querySelector('#startup-note').textContent.includes('Synthetic save failure'));assert.equal(await page.isDisabled('#save-startup'),false);assert.equal(await app.evaluate(()=>startupTest.enabled),true);checks.push('Failure restores usable controls with error');
await app.evaluate(()=>startupTest.fail=false);await page.click('#save-startup');await page.waitForFunction(()=>document.querySelector('#startup-note').textContent.includes('已关闭'));assert.equal(await app.evaluate(()=>startupTest.enabled),false);checks.push('Retry successfully disables');
await app.evaluate(()=>{startupTest.enabled=true;startupTest.blocked=true;});await page.click('#modal-close');await page.click('#configure-startup');assert.match(await page.textContent('#startup-note'),/Windows 已禁用/);checks.push('System-disabled state explained');
await page.screenshot({path:path.join(evidence,'startup-settings.png')});assert.deepEqual(errors,[]);checks.push('No renderer errors');
fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks,registry:'mocked; real startup settings untouched'},null,2));console.log(checks.join('\n'));
}finally{if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});


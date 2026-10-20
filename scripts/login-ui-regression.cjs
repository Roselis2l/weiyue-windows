'use strict';
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');

// Local renderer regression only: no real app main, profiles, credentials or network.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const executablePath = path.resolve(process.argv[2] || path.join(root, 'vendor/runtime/electron.exe'));
const evidence = path.join(root, 'artifacts', 'login-ui-regression');
const harness = path.join(evidence, `run-${Date.now()}`);
fs.mkdirSync(harness, { recursive: true });

fs.writeFileSync(path.join(harness, 'preload.cjs'), `
'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('api',Object.freeze({call:async(action,payload={})=>{
 const result=await ipcRenderer.invoke('mock:call',action,payload);
 if(!result.ok)throw new Error(result.error);
 return result.value;
}}));
`);

fs.writeFileSync(path.join(harness, 'main.cjs'), `
'use strict';
const {app,BrowserWindow,ipcMain,session}=require('electron');
const path=require('node:path');
app.setPath('userData',path.join(__dirname,'isolated-profile'));
const emptyState=()=>({accounts:[],account:null,groups:[],stats:{},readPositions:{},importantMembers:[],settings:{},credentials:{}});
let state=emptyState(),pending=null;
globalThis.__mock={
 calls:[],blockedRequests:[],groupsSelectError:null,
 status:{running:false,stage:'ready',message:'请先在官方窗口完成登录。',startedAt:null,timeoutMs:60000,error:null},
 setStatus(update){Object.assign(this.status,update);},
 fail(message){
  const job=pending;pending=null;
  this.setStatus({running:false,stage:'error',message,error:message});
  if(job)job.reject(new Error(message));
 },
 succeed(){
  state={...emptyState(),account:{id:'mock-weibo',name:'本地测试帐号',kind:'weibo'},accounts:[{id:'mock-weibo',name:'本地测试帐号',kind:'weibo'}],groups:[{id:'mock-group',name:'模拟群聊 · 不含真实记录',selected:true}],stats:{messages:0,bookmarks:0,summaries:0}};
  const job=pending;pending=null;
  this.setStatus({running:false,stage:'completed',message:'登录读取完成',error:null});
  if(job)job.resolve({account:state.account,groups:state.groups});
 },
 reset(){if(pending)throw new Error('Cannot reset while a request is pending');state=emptyState();this.calls=[];this.status={running:false,stage:'ready',message:'请先在官方窗口完成登录。',startedAt:null,timeoutMs:60000,error:null};}
};
async function mockCall(_event,action,payload){
 const mock=globalThis.__mock;mock.calls.push({action,payload});
 switch(action){
  case 'state':return state;
  case 'login.open':mock.setStatus({running:false,stage:'ready',message:'官方登录窗口已打开',error:null});return {opened:true};
  case 'login.status':return {...mock.status};
  case 'login.complete':
   if(pending)throw new Error('Duplicate login request');
   mock.setStatus({running:true,stage:'identity',message:'正在核验当前登录身份',startedAt:Date.now(),error:null});
   return new Promise((resolve,reject)=>{pending={resolve,reject};});
  case 'login.cancel':{
   const job=pending;pending=null;
   mock.setStatus({running:false,stage:'canceled',message:'已取消读取，官方登录会话保留',error:null});
   if(job)job.reject(new Error('已取消读取，官方登录会话保留'));
   return {canceled:true};
  }
  case 'messages.query':return {messages:[],total:0};
  case 'members.list':return [];
  case 'groups.select':if(mock.groupsSelectError)throw new Error(mock.groupsSelectError);return {};
  case 'read.set':return {};
  default:throw new Error('Unexpected mock action: '+action);
 }
}
ipcMain.handle('mock:call',async(...args)=>{
 try{return {ok:true,value:await mockCall(...args)};}
 catch(error){return {ok:false,error:error.message};}
});
app.whenReady().then(()=>{
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{globalThis.__mock.blockedRequests.push(details.url);callback({cancel:true});});
 session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 const win=new BrowserWindow({width:1440,height:960,show:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.loadFile(${JSON.stringify(path.join(root, 'app', 'renderer', 'index.html'))});
});
app.on('window-all-closed',()=>app.quit());
`);

let application, page;
const checks = [];
const errors = [];
const check = (description) => { checks.push(description); console.log(`PASS ${description}`); };
const readCalls = () => application.evaluate(() => globalThis.__mock.calls);
const count = async action => (await readCalls()).filter(call => call.action === action).length;
const status = update => application.evaluate((_electron, value) => globalThis.__mock.setStatus(value), update);
const fail = message => application.evaluate((_electron, value) => globalThis.__mock.fail(value), message);
const textOf = selector => page.locator(selector).innerText();
const waitText = (selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });

async function openLogin() {
  await page.locator('#login-button').click();
  await page.waitForSelector('#complete-login');
  assert.equal(await page.locator('#modal').evaluate(el => el.open), true);
  assert.equal(await page.locator('#login-status').getAttribute('aria-live'), 'polite');
}

async function beginRead() {
  const before = await count('login.complete');
  await page.locator('#complete-login').click();
  await page.waitForFunction(() => document.querySelector('#complete-login')?.disabled === true);
  assert.equal(await page.locator('#cancel-login-read').isVisible(), true);
  await page.locator('#login-status .busy-indicator').waitFor({ state: 'visible' });
  assert.equal(await count('login.complete'), before + 1);
}

async function reset() {
  await application.evaluate(() => globalThis.__mock.reset());
  await page.reload();
  await page.waitForSelector('#login-button');
  await openLogin();
}

(async () => {
  try {
    console.log('Launching isolated Electron mock host');
    assertWindowsRuntimeReadable(executablePath);
    application = await _electron.launch({ executablePath, args: [path.join(harness, 'main.cjs')], cwd: root, timeout: 30000 });
    console.log('Waiting for renderer window');
    page = await application.firstWindow({ timeout: 30000 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForSelector('#login-button');
    const isolation = await page.evaluate(() => ({ require: typeof require, process: typeof process }));
    assert.deepEqual(isolation, { require: 'undefined', process: 'undefined' });
    await openLogin();
    check('Real renderer opens a sandboxed login dialog with an aria-live status region');

    await page.locator('#open-official-login').click();
    await page.waitForFunction(() => !document.querySelector('#open-official-login')?.disabled);
    assert.equal(await count('login.open'), 1);
    check('Official-window button invokes the local login.open mock once');

    await beginRead();
    await page.locator('#complete-login').evaluate(button => { button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal(await count('login.complete'), 1);
    check('Reading shows an immediate spinner, enables cancellation and prevents duplicate submissions');

    const initialStage = await textOf('#login-stage');
    const pollingBefore = await count('login.status');
    await status({ stage: 'groups', message: 'MOCK 正在读取有权限的群列表', startedAt: Date.now() - 5000 });
    await waitText('#login-detail', 'MOCK 正在读取有权限的群列表');
    assert.notEqual(await textOf('#login-stage'), initialStage);
    assert.ok((await textOf('#login-elapsed')).length > 0);
    assert.ok(await count('login.status') > pollingBefore);
    await status({ stage: 'verify', message: 'MOCK 正在复核登录帐号' });
    await waitText('#login-detail', 'MOCK 正在复核登录帐号');
    await status({ stage: 'saving', message: 'MOCK 正在保存帐号与群列表' });
    await waitText('#login-detail', 'MOCK 正在保存帐号与群列表');
    await page.screenshot({ path: path.join(evidence, 'login-progress.png') });
    check('Polling updates identity/groups/verify/saving stages, detail text and elapsed time');

    const timeoutMessage = '读取超时：请确认官方页面已经完成登录，然后重试。';
    await fail(timeoutMessage);
    await waitText('#login-error', timeoutMessage);
    assert.equal(await page.locator('#login-error').isVisible(), true);
    assert.equal(await page.locator('#modal').evaluate(el => el.open), true);
    assert.equal(await page.locator('#complete-login').isEnabled(), true);
    assert.equal(await page.locator('#login-status .busy-indicator').isVisible(), false);
    await page.screenshot({ path: path.join(evidence, 'login-timeout.png') });
    check('Timeout stops the spinner and stays visible inside the open dialog with retry enabled');

    await beginRead();
    assert.equal(await page.locator('#login-error').isVisible(), false);
    await application.evaluate(() => globalThis.__mock.succeed());
    await page.waitForSelector('#save-groups');
    assert.ok((await textOf('#modal')).includes('模拟群聊'));
    assert.equal(await page.locator('#account-select').inputValue(), 'mock-weibo');
    assert.equal(await count('login.complete'), 2);
    await page.screenshot({ path: path.join(evidence, 'login-success-groups.png') });
    check('Retry clears the old error, activates the returned account and opens the group chooser');

    await application.evaluate(() => { globalThis.__mock.groupsSelectError = 'MOCK 保存失败，请重试'; });
    const groupCheckbox = page.locator('#modal .group-choice input[type="checkbox"]').first();
    const wasChecked = await groupCheckbox.isChecked();
    await page.locator('#save-groups').click();
    await waitText('#modal-error', 'MOCK 保存失败，请重试');
    assert.equal(await page.locator('#modal-error').isVisible(), true);
    assert.equal(await page.locator('#modal').evaluate(el => el.open), true);
    assert.equal(await groupCheckbox.isChecked(), wasChecked);
    await page.screenshot({ path: path.join(evidence, 'group-selection-error.png') });
    check('Group-selection failure is visible inside the modal and preserves selected checkboxes');

    await reset();
    await beginRead();
    await page.locator('#cancel-login-read').click();
    await page.waitForFunction(() => document.querySelector('#complete-login')?.disabled === false);
    assert.equal(await count('login.cancel'), 1);
    assert.equal(await count('logout'), 0);
    assert.equal(await page.locator('#modal').evaluate(el => el.open), true);
    assert.equal(await page.locator('#save-groups').count(), 0);
    assert.equal(await page.locator('#login-status .busy-indicator').isVisible(), false);
    await page.screenshot({ path: path.join(evidence, 'login-canceled.png') });
    check('Cancel aborts the pending read, preserves the login dialog/session and never opens group selection');

    await beginRead();
    const errorMessage = '登录失效：请回到官方窗口完成验证 <img src=x onerror=alert(1)>';
    await fail(errorMessage);
    await waitText('#login-error', errorMessage);
    assert.equal(await page.locator('#login-error img').count(), 0);
    assert.equal(await page.locator('#complete-login').isEnabled(), true);
    check('Canceled reads can retry; authentication errors stay inline and HTML remains plain text');

    await beginRead();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#modal')?.open === false);
    assert.equal(await count('login.cancel'), 2);
    assert.equal(await page.locator('#save-groups').count(), 0);
    check('Escape cancels an in-flight read before closing the modal');

    await openLogin();
    await beginRead();
    await page.locator('#modal-close').click();
    await page.waitForFunction(() => document.querySelector('#modal')?.open === false);
    assert.equal(await count('login.cancel'), 3);
    check('Close button cancels an in-flight read before closing the modal');

    assert.deepEqual(errors, []);
    const blockedRequests = await application.evaluate(() => globalThis.__mock.blockedRequests);
    assert.deepEqual(blockedRequests, []);
    const report = { passed: true, executablePath, renderer: path.join(root, 'app', 'renderer'), checks, errors, blockedRequests, externalServices: 'No real services: isolated local mock IPC; all HTTP(S) denied', generatedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, report: path.join(evidence, 'result.json') }));
  } catch (error) {
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, errors, failure: String(error), generatedAt: new Date().toISOString() }, null, 2));
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (application) await application.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

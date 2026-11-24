'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {createBrowserSettings}=require('../app/core/browser-settings.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-browser-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const chrome=path.join(root,'programs','Google','Chrome','Application','chrome.exe');fs.mkdirSync(path.dirname(chrome),{recursive:true});fs.writeFileSync(chrome,'fixture');
 const calls=[],shellCalls=[],children=[];const service=createBrowserSettings({dataRoot:root,env:{ProgramFiles:path.join(root,'programs')},platform:'win32',shell:{openExternal:async url=>shellCalls.push(url)},launch:(...args)=>{calls.push(args);const child=new EventEmitter();child.unref=()=>{child.unreferenced=true;};children.push(child);queueMicrotask(()=>child.emit('spawn'));return child;}});
 return {root,chrome,service,calls,shellCalls,children};
}
test('browser choices enumerate existing known executables, default is unchanged',async t=>{const f=fixture(t);assert.deepEqual(f.service.get(),{selected:'default',choices:[{id:'default',label:'系统默认浏览器'},{id:'chrome',label:'Google Chrome'}],available:true});await f.service.open('https://example.com/a?x=1&y=2');assert.equal(f.calls.length,0);assert.deepEqual(f.shellCalls,['https://example.com/a?x=1&y=2']);});
test('choice persists atomically and starts browser with one non-shell URL argument',async t=>{const f=fixture(t);f.service.save({browser:'chrome'});assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'browser-preferences.json'),'utf8')).browser,'chrome');await f.service.open('https://example.com/a?x=1&y=2');assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],f.chrome);assert.deepEqual(f.calls[0][1],['https://example.com/a?x=1&y=2']);assert.equal(f.calls[0][2].shell,false);assert.equal(f.children[0].unreferenced,true);assert.equal(f.shellCalls.length,0);assert.deepEqual(fs.readdirSync(f.root).filter(x=>x.endsWith('.tmp')),[]);});
test('rejects arbitrary executable selection, extra parameters and unavailable choices',t=>{const f=fixture(t);for(const payload of [null,[],{browser:'cmd'},{browser:f.chrome},{browser:'chrome',args:'--x'},{browser:'firefox'},{browser:1}])assert.throws(()=>f.service.save(payload));assert.equal(f.service.get().selected,'default');});
test('unsafe URL rejected before launching either default or chosen browser',async t=>{const f=fixture(t);for(const selection of ['default','chrome']){f.service.save({browser:selection});for(const url of ['file:///C:/cmd.exe','javascript:alert(1)','https://user:pass@example.com','https://example.com\n--flag','--version',null])await assert.rejects(f.service.open(url),/HTTP/);}assert.equal(f.calls.length+f.shellCalls.length,0);});
test('removed browser remains selected with explicit error, no silent default fallback',async t=>{const f=fixture(t);f.service.save({browser:'chrome'});fs.unlinkSync(f.chrome);assert.equal(f.service.get().available,false);await assert.rejects(f.service.open('https://example.com/'),/重新选择/);assert.equal(f.shellCalls.length,0);f.service.save({browser:'default'});assert.equal(f.service.get().available,true);});
test('launch error rejects, does not report success',async t=>{const f=fixture(t);f.service.save({browser:'chrome'});const service=createBrowserSettings({dataRoot:f.root,env:{ProgramFiles:path.join(f.root,'programs')},platform:'win32',launch:()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',Error('ENOENT')));return child;}});await assert.rejects(service.open('https://example.com/'),/启动失败/);});
const {bind}=require('../app/renderer/browser-settings.js');
function control(){const listeners={};return {listeners,disabled:false,value:'',options:[],ownerDocument:{createElement:()=>({})},replaceChildren(){this.options=[];},append(o){this.options.push(o);},addEventListener(k,v){listeners[k]=v;}};}
const state={selected:'default',choices:[{id:'default',label:'Default'},{id:'chrome',label:'Chrome'}],available:true};
test('settings control loads, saves immediately and restores selection on failure',async()=>{const select=control(),note={};let fail=false,calls=[];const binding=bind({select,note,api:async(action,p)=>{calls.push([action,p]);if(action==='browser.get')return state;if(fail)throw Error('failure');return {...state,selected:p.browser};}});await binding.ready;assert.equal(select.disabled,false);select.value='chrome';await select.listeners.change();assert.equal(select.value,'chrome');fail=true;select.value='default';await select.listeners.change();assert.equal(select.value,'chrome');assert.equal(note.textContent,'failure');});
test('closed or replaced dialog ignores late responses',async()=>{let finish,current=true;const select=control(),note={};const binding=bind({select,note,isCurrent:()=>current,api:()=>new Promise(resolve=>finish=resolve)});current=false;finish(state);await binding.ready;assert.equal(select.options.length,0);});
test('actual preload and settings UI expose browser actions',()=>{const root=path.join(__dirname,'..');assert.match(fs.readFileSync(path.join(root,'app/preload.cjs'),'utf8'),/'browser.get','browser.save'/);assert.match(fs.readFileSync(path.join(root,'app/renderer/app.js'),'utf8'),/WeiyueBrowserSettings.bind/);assert.match(fs.readFileSync(path.join(root,'app/renderer/index.html'),'utf8'),/browser-settings.js/);});

test('repeated changes are serialized and reopened dialog reads final saved choice',async()=>{
 let finish,selected='default',writes=0;
 const api=async(action,p)=>{if(action==='browser.get')return {...state,selected};writes++;return new Promise(resolve=>finish=()=>{selected=p.browser;resolve({...state,selected});});};
 const first=control();await bind({api,select:first,note:{}}).ready;
 first.value='chrome';const saving=first.listeners.change();await Promise.resolve();
 first.value='default';await first.listeners.change();assert.equal(writes,1);
 const second=control(),opened=bind({api,select:second,note:{}});
 assert.equal(second.disabled,true);finish();await saving;await opened.ready;assert.equal(second.value,'chrome');assert.equal(writes,1);
});
test('failed persistence keeps original setting and removes temporary file',t=>{
 const f=fixture(t);f.service.save({browser:'default'});
 const io={...fs,renameSync:()=>{throw Error('write denied');}};
 const service=createBrowserSettings({dataRoot:f.root,io,env:{ProgramFiles:path.join(f.root,'programs')},platform:'win32'});
 assert.throws(()=>service.save({browser:'chrome'}),/write denied/);assert.equal(f.service.get().selected,'default');assert.deepEqual(fs.readdirSync(f.root).filter(x=>x.endsWith('.tmp')),[]);
});

test('browser module is served by actual local protocol allowlist and creates browser global',()=>{const vm=require('node:vm');const main=fs.readFileSync(path.join(__dirname,'../app/main.cjs'),'utf8');const allowed=main.match(/if\(!\[(.*?)\]\.includes\(u\.pathname\)\)/);assert.ok(allowed);const urls=vm.runInNewContext('['+allowed[1]+']');assert.ok(urls.includes('/browser-settings.js'));const context={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/renderer/browser-settings.js'),'utf8'),context);assert.equal(typeof context.WeiyueBrowserSettings.bind,'function');});

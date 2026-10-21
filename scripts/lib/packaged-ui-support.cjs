'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function programHashes(root){
  const result={};
  function walk(folder){for(const item of fs.readdirSync(path.join(root,folder),{withFileTypes:true})){const relative=path.join(folder,item.name);if(!folder&&item.name.toLowerCase()==='data')continue;assert(!item.isSymbolicLink(),'Packaged acceptance does not follow links');if(item.isDirectory())walk(relative);else if(item.isFile())result[relative]=hash(path.join(root,relative));}}
  walk('');return result;
}
function packagedInput(argv=process.argv){
  const argument=argv.find(value=>value.startsWith('--exe='));if(!argument)return null;
  const executablePath=path.resolve(argument.slice(6)),installRoot=path.dirname(executablePath),packageRoot=path.join(installRoot,'resources','app');
  assert.equal(path.basename(executablePath).toLowerCase(),'weiyue.exe');assert(fs.statSync(executablePath).isFile());
  const packageVersion=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).version;
  return{executablePath,installRoot,packageRoot,appSource:path.join(packageRoot,'app'),packageVersion,installDataExisted:fs.existsSync(path.join(installRoot,'data')),beforeProgramHashes:programHashes(installRoot)};
}
async function validatePackaged(application,input,dataDir){
  const runtime=await application.evaluate(({app})=>({isPackaged:app.isPackaged,version:app.getVersion(),executable:app.getPath('exe'),appPath:app.getAppPath(),userData:app.getPath('userData')}));
  assert.equal(runtime.isPackaged,true);assert.equal(runtime.version,input.packageVersion);assert.equal(path.resolve(runtime.executable).toLowerCase(),input.executablePath.toLowerCase());assert.equal(path.resolve(runtime.appPath).toLowerCase(),input.packageRoot.toLowerCase());assert(path.resolve(runtime.userData).startsWith(dataDir+path.sep));return runtime;
}
async function closePackaged(application){
  const process=application.process(),exited=new Promise(resolve=>process.exitCode!==null?resolve():process.once('exit',resolve));
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html')?.close());
  let timer;try{await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Synthetic packaged window did not close normally')),15000))]);}finally{clearTimeout(timer);}
}
function networkSummary(file){
  assert(fs.existsSync(file),'Native network log missing');const log=JSON.parse(fs.readFileSync(file,'utf8')),external=[];
  function walk(value){if(!value||typeof value!=='object')return;for(const item of Object.values(value)){if(typeof item==='string'&&/^(?:https?|wss?):\/\//i.test(item)){const u=new URL(item);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))external.push(u.hostname);}else if(item&&typeof item==='object')walk(item);}}
  for(const event of log.events||[])walk(event.params);return{events:log.events?.length||0,externalUrlObservations:external.length,externalHosts:[...new Set(external)]};
}
function verifyPackaged(input){if(!input)return null;const afterProgramHashes=programHashes(input.installRoot);return{executablePath:input.executablePath,packageVersion:input.packageVersion,beforeProgramHashes:input.beforeProgramHashes,afterProgramHashes,programUnchanged:JSON.stringify(input.beforeProgramHashes)===JSON.stringify(afterProgramHashes),installDataUnchanged:fs.existsSync(path.join(input.installRoot,'data'))===input.installDataExisted};}
module.exports={packagedInput,validatePackaged,closePackaged,networkSummary,verifyPackaged};

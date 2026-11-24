'use strict';
// Offline sandboxed viewer regression. Images contain synthetic red/blue pixels
// only, all HTTP is blocked, and save dialogs are injected into a fresh profile.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const output=path.resolve(process.env.WEIYUE_ANIMATION_OUTPUT||path.join(root,'artifacts','animation-1.1.17-'+Date.now()));
if(!process.versions.electron){
  const executable=path.resolve(process.env.WEIYUE_ELECTRON||path.join(root,'vendor/runtime/electron.exe'));
  require('./windows-runtime-check.cjs').assertWindowsRuntimeReadable(executable);
  fs.mkdirSync(output,{recursive:true});
  const r=require('node:child_process').spawnSync(executable,[__filename],{windowsHide:true,stdio:'inherit',timeout:60000,
    env:{...process.env,WEIYUE_ANIMATION_OUTPUT:output}});
  if(r.error)throw r.error;process.exitCode=r.status??1;
}else{
  const{app,BrowserWindow,ipcMain,protocol,net,session}=require('electron');
  const{pathToFileURL}=require('node:url');
  const{fetchImage}=require('../app/core/media.cjs');
  const{createImageViewer}=require('../app/core/image-viewer.cjs');
  const{animatedPng,animatedGif,WIDTH,HEIGHT}=require('./lib/synthetic-animation.cjs');
  app.setPath('userData',path.join(output,'isolated-browser'));
  protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
  const checks=[];let manager,requests=0,saves=0,cancelSave=true,current;
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const record=(name,details={})=>{checks.push({name,...details});console.log('PASS '+name);};
  app.whenReady().then(async()=>{
    protocol.handle('app',request=>{
      const url=new URL(request.url);
      if(url.host!=='local'||!['/image-viewer.html','/image-viewer.js','/image-viewer.css'].includes(url.pathname))return new Response('',{status:404});
      return net.fetch(pathToFileURL(path.join(root,'app/renderer',url.pathname.slice(1))).href);
    });
    session.defaultSession.setPermissionRequestHandler((_,__,cb)=>cb(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>{requests++;cb({cancel:true});});
    manager=createImageViewer({BrowserWindow,ipcMain,appRoot:path.join(root,'app'),getOwner:()=> 'synthetic-animation',
      readImage:async()=>fetchImage({url:'https://wx1.sinaimg.cn/large/synthetic.'+current.extension,
        fetch:async()=>new Response(current.bytes,{headers:{'content-type':current.mime}})}),
      dialog:{showSaveDialog:async(_,options)=>{
        saves++;assert.deepEqual(options.filters[0].extensions,[current.extension]);
        assert.ok(options.properties.includes('showOverwriteConfirmation'));
        return cancelSave?{canceled:true}:{canceled:false,filePath:path.join(output,'saved.'+current.extension)};
      }}});
    for(const fixture of [{extension:'gif',mime:'image/gif',bytes:animatedGif()},{extension:'png',mime:'image/png',bytes:animatedPng()}]){
      current=fixture;cancelSave=true;
      await manager.open({source:'app://media/'+'b'.repeat(32)+'/synthetic/1/message/0/original',title:'合成动画 '+fixture.extension,caption:'示例数据 · 红蓝两帧'});
      const window=BrowserWindow.getAllWindows()[0],wc=window.webContents;
      let image;
      for(let i=0;i<100;i++){
        image=await wc.executeJavaScript('(()=>{const i=document.getElementById("image");return{hidden:i.hidden,width:i.naturalWidth,height:i.naturalHeight}})()');
        if(!image.hidden&&image.width>0)break;await delay(30);
      }
      assert.deepEqual(image,{hidden:false,width:WIDTH,height:HEIGHT});
      const prefs=wc.getLastWebPreferences();assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
      record(fixture.extension+' decodes in the actual sandboxed viewer',image);
      await delay(150);
      const bounds=await wc.executeJavaScript('(()=>{const b=document.getElementById("image").getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,viewportWidth:innerWidth}})()');
      assert.ok(bounds.width>0&&bounds.height>0,'rendered image must have positive bounds');
      const frames=new Set();
      for(let i=0;i<24;i++){
        const capture=await wc.capturePage(),scale=capture.getSize().width/bounds.viewportWidth;
        const pixels=capture.crop({x:Math.floor((bounds.x+bounds.width/2)*scale),y:Math.floor((bounds.y+bounds.height/2)*scale),width:2,height:2}).toBitmap();
        frames.add(hash(pixels));await delay(45);
      }
      assert.equal(frames.size,2,'red/blue animation must visibly alternate two frames');
      record(fixture.extension+' visible pixels alternate without re-encoding',{distinctFrames:frames.size});
      const canceled=await wc.executeJavaScript('window.imageViewer.call("save")');assert.deepEqual(canceled,{canceled:true});
      assert.equal(fs.existsSync(path.join(output,'saved.'+fixture.extension)),false);record(fixture.extension+' cancel writes no file');
      cancelSave=false;const saved=await wc.executeJavaScript('window.imageViewer.call("save")');assert.equal(saved.saved,true);
      assert.deepEqual(fs.readFileSync(path.join(output,'saved.'+fixture.extension)),fixture.bytes);record(fixture.extension+' saves exact animated original bytes',{sha256:hash(fixture.bytes)});
      fs.writeFileSync(path.join(output,'synthetic-'+fixture.extension+'-viewer.png'),(await wc.capturePage()).toPNG());
      manager.closeAll();
    }
    assert.equal(requests,0);assert.equal(saves,4);record('zero external requests',{requests});
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:checks.length,failed:0,checks},null,2));
    console.log(JSON.stringify({passed:checks.length,output}));manager.dispose();app.quit();
  }).catch(error=>{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:checks.length,failed:1,error:error.stack,checks},null,2));console.error(error);manager?.dispose();app.exit(1);});
  app.on('window-all-closed',()=>{});
}

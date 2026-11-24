'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const prefix='--weiyue-audio-channel=';
const channel=process.argv.find(value=>value.startsWith(prefix))?.slice(prefix.length);
if(/^weiyue:audio:[a-f0-9-]{36}$/.test(channel||''))contextBridge.exposeInMainWorld('audioDecoderBridge',Object.freeze({
 subscribe(callback){if(typeof callback!=='function')return;ipcRenderer.once(channel,(_,value)=>callback(value));ipcRenderer.send(channel,{type:'ready'});},
 complete(value){ipcRenderer.send(channel,value);},
}));

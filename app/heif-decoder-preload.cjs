'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const channel = process.argv.find(value => value.startsWith('--weiyue-heif-channel='))?.slice(22);
if (/^weiyue:heif:[a-f0-9-]{36}$/.test(channel || '')) {
  contextBridge.exposeInMainWorld('heifBridge', Object.freeze({
    subscribe(callback) {
      if (typeof callback !== 'function') return;
      ipcRenderer.once(channel, (_event, value) => callback(value));
      ipcRenderer.send(channel, { type: 'ready' });
    },
    complete(value) { ipcRenderer.send(channel, value); },
  }));
}

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['load', 'retry', 'save', 'close', 'maximize', 'minimize']);
contextBridge.exposeInMainWorld('imageViewer', Object.freeze({
  call: async action => {
    if (!allowed.has(action)) throw new Error('不支持的图片操作。');
    const result = await ipcRenderer.invoke('weiyue:image-viewer', action);
    if (!result?.ok) throw new Error(result?.error || '图片操作失败。');
    return result.value;
  },
}));

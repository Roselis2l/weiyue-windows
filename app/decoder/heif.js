'use strict';
// This document has no user content and no Node or network capability.
window.heifBridge.subscribe(value => {
  let worker;
  let done = false;
  const finish = result => {
    if (done) return;
    done = true; worker?.terminate();
    window.heifBridge.complete({ ...result, id: value?.id });
  };
  try {
    if (!value || typeof value.id !== 'string' || !(value.bytes instanceof Uint8Array) ||
        !value.bytes.length || value.bytes.length > 20 * 1024 * 1024) throw new Error();
    worker = new Worker('heif-worker.js');
    worker.onmessage = event => {
      const message = event.data;
      if (message?.type === 'result') finish({ type: 'result', mime: 'image/png',
        bytes: message.bytes, width: message.width, height: message.height });
      else finish({ type: 'error', code: message?.code === 'HEIF_TOO_LARGE' ? 'HEIF_TOO_LARGE' : 'HEIF_DECODE' });
    };
    worker.onerror = event => { event.preventDefault(); finish({ type: 'error', code: 'HEIF_DECODE' }); };
    const bytes = value.bytes.slice();
    worker.postMessage(bytes, [bytes.buffer]);
  } catch { finish({ type: 'error', code: 'HEIF_DECODE' }); }
});

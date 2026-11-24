'use strict';
// Upstream failures sometimes log parsed metadata. Suppress all decoder logs
// before importing the reviewed local bundle; report only fixed error codes.
for (const key of ['log', 'info', 'warn', 'error', 'debug', 'trace']) console[key] = () => {};
let used = false;
self.onmessage = async event => {
  if (used) return;
  used = true;
  let library, context, image;
  try {
    const bytes = event.data;
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('HEIF_TOO_LARGE');
    importScripts('libheif/libheif-bundle.js');
    library = await libheif({ print() {}, printErr() {} });
    context = library.heif_context_alloc();
    if (!context) throw new Error('HEIF_DECODE');
    const read = library.heif_context_read_from_memory(context, bytes);
    if (!read || read.code !== library.heif_error_code.heif_error_Ok) throw new Error('HEIF_DECODE');
    // Read only the primary image, not every thumbnail/auxiliary frame.
    const handle = library.heif_context_get_primary_image_handle(context);
    if (!handle || handle.code) throw new Error('HEIF_DECODE');
    image = new library.HeifImage(handle);
    const width = image.get_width(), height = image.get_height();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        width > 32768 || height > 32768 || width * height > 32000000) throw new Error('HEIF_TOO_LARGE');
    const rgba = new ImageData(width, height);
    await new Promise((resolve, reject) => image.display(rgba, result => result ? resolve() : reject(new Error('HEIF_DECODE'))));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('HEIF_DECODE');
    ctx.putImageData(rgba, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    if (!blob.size || blob.size > 64 * 1024 * 1024 || blob.type !== 'image/png') throw new Error('HEIF_TOO_LARGE');
    const result = new Uint8Array(await blob.arrayBuffer());
    self.postMessage({ type: 'result', mime: 'image/png', bytes: result, width, height }, [result.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', code: error?.message === 'HEIF_TOO_LARGE' ? 'HEIF_TOO_LARGE' : 'HEIF_DECODE' });
  } finally {
    try { image?.free(); } catch {}
    try { if (context) library.heif_context_free(context); } catch {}
    self.close();
  }
};

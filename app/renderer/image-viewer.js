'use strict';

// Geometry stays independent of DOM events so zoom anchoring, fit behavior and
// pan limits can be checked without a browser or a network image.
const ImageViewport = (() => {
  const MIN_SCALE = 0.01, MAX_SCALE = 16;
  function minimum(iw, ih, vw, vh) { return Math.min(MIN_SCALE, vw / iw, vh / ih); }
  function boundedScale(value, minScale = MIN_SCALE) { return Math.max(minScale, Math.min(MAX_SCALE, Number.isFinite(value) ? value : 1)); }
  function clamp(state) {
    const width = state.iw * state.scale, height = state.ih * state.scale;
    return { ...state,
      x: width <= state.vw ? (state.vw - width) / 2 : Math.min(0, Math.max(state.vw - width, state.x)),
      y: height <= state.vh ? (state.vh - height) / 2 : Math.min(0, Math.max(state.vh - height, state.y)),
    };
  }
  function fit(iw, ih, vw, vh) {
    const scale = Math.min(vw / iw, vh / ih, 1);
    return clamp({ iw, ih, vw, vh, scale, minScale: minimum(iw, ih, vw, vh), x: (vw - iw * scale) / 2, y: (vh - ih * scale) / 2 });
  }
  function zoom(state, value, ax = state.vw / 2, ay = state.vh / 2) {
    const scale = boundedScale(value, state.minScale), ratio = scale / state.scale;
    return clamp({ ...state, scale, x: ax - (ax - state.x) * ratio, y: ay - (ay - state.y) * ratio });
  }
  function pan(state, dx, dy) { return clamp({ ...state, x: state.x + dx, y: state.y + dy }); }
  function resize(state, vw, vh) {
    const centerX = (state.vw / 2 - state.x) / state.scale;
    const centerY = (state.vh / 2 - state.y) / state.scale;
    return clamp({ ...state, vw, vh, minScale: minimum(state.iw, state.ih, vw, vh), x: vw / 2 - centerX * state.scale, y: vh / 2 - centerY * state.scale });
  }
  return { MIN_SCALE, MAX_SCALE, fit, zoom, pan, resize };
})();

if (typeof module === 'object' && module.exports) module.exports = ImageViewport;
if (typeof window === 'object' && typeof document === 'object') {
  const $ = id => document.getElementById(id);
  const viewport = $('viewport'), image = $('image'), status = $('status'), panel = $('status-panel');
  const controls = ['zoom-in', 'zoom-out', 'fit', 'actual', 'save'].map($);
  let state = null, fitted = true, imageData = null, loadEpoch = 0, dragging = null, saving = false, toastTimer;
  function notify(message) {
    clearTimeout(toastTimer);
    $('save-status').textContent = message;
    $('save-status').hidden = false;
    toastTimer = setTimeout(() => { $('save-status').hidden = true; }, 6000);
  }
  function render() {
    if (!state) return;
    image.style.transform = `translate(${state.x}px,${state.y}px) scale(${state.scale})`;
    $('zoom-value').textContent = `${Math.round(state.scale * 100)}%`;
    $('zoom-in').disabled = state.scale >= ImageViewport.MAX_SCALE;
    $('zoom-out').disabled = state.scale <= state.minScale;
    viewport.classList.toggle('pannable', state.iw * state.scale > state.vw + 1 || state.ih * state.scale > state.vh + 1);
  }
  function fit() {
    if (!imageData || !image.naturalWidth || !image.naturalHeight || viewport.clientWidth < 1 || viewport.clientHeight < 1) return;
    state = ImageViewport.fit(image.naturalWidth, image.naturalHeight, viewport.clientWidth, viewport.clientHeight);
    fitted = true; render();
  }
  function zoom(scale, x, y) { if (!state) return; state = ImageViewport.zoom(state, scale, x, y); fitted = false; render(); }
  function error(message) {
    state = null; imageData = null; image.hidden = true; image.removeAttribute('src');
    controls.forEach(button => { button.disabled = true; });
    viewport.classList.remove('pannable', 'dragging'); dragging = null;
    panel.hidden = false; status.textContent = message; $('retry').hidden = false; $('zoom-value').textContent = '—';
  }
  async function load(retry = false) {
    const epoch = ++loadEpoch;
    image.hidden = true; imageData = null; state = null; dragging = null;
    viewport.classList.remove('pannable', 'dragging');
    controls.forEach(button => { button.disabled = true; });
    panel.hidden = false; status.textContent = '正在加载原图…'; $('retry').hidden = true;
    try {
      const data = await window.imageViewer.call(retry ? 'retry' : 'load');
      if (epoch !== loadEpoch) return;
      if (!/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(data.dataUrl || '')) throw new Error('图片内容或格式不受支持。');
      $('image-title').textContent = data.title; $('image-caption').textContent = data.caption;
      image.alt = data.title;
      image.onload = () => {
        if (epoch !== loadEpoch) return;
        if (!image.naturalWidth || !image.naturalHeight) { error('图片解码失败，请重新加载。'); return; }
        imageData = data; image.hidden = false; panel.hidden = true;
        controls.forEach(button => { button.disabled = false; });
        $('save').disabled = saving;
        $('image-info').textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${(data.byteLength / 1024 / 1024).toFixed(2)} MB · 滚轮缩放 / 拖动平移`;
        fit(); viewport.focus();
      };
      image.onerror = () => { if (epoch === loadEpoch) error('图片无法解码或格式不受支持，请重新加载或在微博官方页面查看。'); };
      image.src = data.dataUrl;
    } catch (err) { if (epoch === loadEpoch) error(err.message || '图片加载失败，请重试。'); }
  }
  function action(name) { window.imageViewer.call(name).catch(err => notify(err.message)); }
  $('close').addEventListener('click', () => action('close'));
  $('minimize').addEventListener('click', () => action('minimize'));
  $('maximize').addEventListener('click', () => action('maximize'));
  $('retry').addEventListener('click', () => load(true));
  $('fit').addEventListener('click', fit);
  $('actual').addEventListener('click', () => zoom(1));
  $('zoom-in').addEventListener('click', () => { if (state) zoom(state.scale * 1.25); });
  $('zoom-out').addEventListener('click', () => { if (state) zoom(state.scale / 1.25); });
  viewport.addEventListener('wheel', event => {
    if (!state || viewport.clientWidth < 1 || viewport.clientHeight < 1) return;
    event.preventDefault();
    const box = viewport.getBoundingClientRect();
    zoom(state.scale * Math.exp(-Math.max(-300, Math.min(300, event.deltaY)) * .002), event.clientX - box.left, event.clientY - box.top);
  }, { passive: false });
  viewport.addEventListener('pointerdown', event => {
    if (!state || event.button !== 0 || !viewport.classList.contains('pannable')) return;
    event.preventDefault(); dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
    viewport.setPointerCapture(event.pointerId); viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', event => {
    if (!state || !dragging || dragging.id !== event.pointerId) return;
    state = ImageViewport.pan(state, event.clientX - dragging.x, event.clientY - dragging.y);
    dragging.x = event.clientX; dragging.y = event.clientY; fitted = false; render();
  });
  function endDrag(event) {
    if (!dragging || dragging.id !== event.pointerId) return;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    dragging = null; viewport.classList.remove('dragging');
  }
  viewport.addEventListener('pointerup', endDrag); viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('lostpointercapture', () => { dragging = null; viewport.classList.remove('dragging'); });
  viewport.addEventListener('dblclick', () => { if (state) fitted ? zoom(1) : fit(); });
  new ResizeObserver(() => {
    if (!state || viewport.clientWidth < 1 || viewport.clientHeight < 1) return;
    if (fitted) fit(); else { state = ImageViewport.resize(state, viewport.clientWidth, viewport.clientHeight); render(); }
  }).observe(viewport);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); action('close'); return; }
    if (!state || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(state.scale * 1.25); }
    else if (event.key === '-') { event.preventDefault(); zoom(state.scale / 1.25); }
    else if (event.key === '0') { event.preventDefault(); fit(); }
    else if (event.key === '1') { event.preventDefault(); zoom(1); }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      state = ImageViewport.pan(state, event.key === 'ArrowLeft' ? 50 : event.key === 'ArrowRight' ? -50 : 0,
        event.key === 'ArrowUp' ? 50 : event.key === 'ArrowDown' ? -50 : 0); fitted = false; render();
    }
  });
  $('save').addEventListener('click', async () => {
    if (saving || !imageData) return;
    saving = true; $('save').disabled = true; $('save').textContent = '选择保存位置…';
    try {
      const result = await window.imageViewer.call('save');
      if (result.canceled) notify('已取消，未保存图片。');
      else if (result.saved) notify(`已保存原图：${result.name}`);
    } catch (err) { notify(err.message || '图片保存失败。'); }
    finally { saving = false; $('save').disabled = !imageData; $('save').textContent = '另存为…'; }
  });
  load();
}

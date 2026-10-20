'use strict';

(() => {

// All account content is rendered as text. Only the isolated preload can call the host.
const $ = (id) => document.getElementById(id);
const reading = window.WeiyueReading;
const model = {
  state: { accounts: [], groups: [], stats: {}, readPositions: {}, importantMembers: [], settings: {}, credentials: {} },
  view: 'read', groupId: null, messages: [], total: 0, offset: 0, limit: 160,
  members: [], selected: new Set(), inspected: null, bookmarks: [], summaries: [],
  summary: null, preview: null, targets: [], targetId: '', bookmarkQuery: '', bookmarkSelected: new Set(), aiRequest: null, aiRequestSequence: 0,
  filters: { keyword: '', senderId: '', start: '', end: '', importantOnly: false },
  searchEditor: null, filterReturn: null,
  advanced: false, range: todayRange(), busy: 0, readTimer: null, queryVersion: 0,
  pending: new Set(), toastTimer: null, saveNote: '', saveTags: '', accountEpoch: 0, switching: false,
  modalCloseHandler: null, viewport: null, restoring: false, restoreFrame: null,
  renderedReading: null, readBoundary: null, layoutVersion: 0, intentVersion: 0, scrollTop: 0, pointerScrolling: false, touchY: null,
  pointerReading: null, readingActivity: null, readingCommits: new Map(), pendingReadingRefresh: null, pendingReadingTimer: null,
  messageObserver: null, drafts: new Map(), readWrite: Promise.resolve(), lastReadPayload: '',
  syncStatus: null, syncRevision: null, polling: false, pollTimer: null, refreshRunning: false,
  messageSignatures: new Map(), closing: false, enrichmentAttempted: new Set(), enrichmentErrors: new Map(), enriching: false, enrichmentRetryTimer: null
};
const readIntent = reading.createReadIntentGate();
const loginFlow = {
  running: false, opening: false, canceling: false, closeWhenDone: false,
  stage: 'ready', message: '请在官方窗口完成登录，再读取群聊。', error: '',
  startedAt: 0, timeoutMs: 60000, generation: 0, pollTimer: null, tickTimer: null,
  watchdogFired: false
};

function node(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (['value', 'checked', 'disabled', 'hidden', 'selected'].includes(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
function button(text, fn, cls = '', props = {}) {
  return node('button', { type: 'button', class: `button ${cls}`, ...props, onclick: (event) => { event.stopPropagation(); void run(text, () => fn(event)); } }, text);
}
function field(label, input, help) {
  return node('label', { class: 'field' }, node('span', {}, label), input, help ? node('small', { class: 'inline-help' }, help) : null);
}
function check(label, checked, change, props = {}) {
  return node('label', { class: 'check-row' }, node('input', { type: 'checkbox', checked, onchange: (e) => change(e.target.checked), ...props }), node('span', {}, label));
}
function fmt(time, full = false) {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return '未知时间';
  return date.toLocaleString('zh-CN', full ? { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false } : { hour:'2-digit', minute:'2-digit', hour12:false });
}
function dateLabel(time) { return new Date(time).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }); }
function localInput(date,seconds=false) { const d = new Date(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}${seconds?':'+String(d.getSeconds()).padStart(2,'0'):''}`; }
function todayRange() { const a = new Date(); a.setHours(0,0,0,0); const b = new Date(a); b.setDate(b.getDate()+1); return { start: localInput(a), end: localInput(b) }; }
function currentGroup() { return model.state.groups.find(g => String(g.id) === String(model.groupId)); }
function groupName(id) { return model.state.groups.find(g => String(g.id) === String(id))?.name || '群聊'; }
function accountKind() { return model.state.account?.kind; }
function isImportant(id) { return (model.state.importantMembers || []).some(x => String(typeof x === 'object' ? x.id : x) === String(id)); }
function noteText(warning) { return Array.isArray(warning) ? warning.join('\n') : typeof warning === 'object' && warning ? JSON.stringify(warning) : String(warning || ''); }
function toast(message, error = false) {
  if(error && $('modal')?.open){reportError({message});return;}
  clearTimeout(model.toastTimer); $('toast').textContent = message; $('toast').className = `toast${error ? ' error' : ''}`; $('toast').hidden = false;
  model.toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9500 : 4300);
}
async function api(action, payload = {}) {
  if (!window.api?.call) throw new Error('桌面连接不可用，请通过微阅应用启动。');
  if (model.switching && !['state','account.switch','demo','import','login.complete','login.status','login.cancel','window.closeReady'].includes(action)) throw new Error('正在切换工作区，请稍候再操作。');
  const epoch = model.accountEpoch;
  const result = await window.api.call(action, payload);
  if (epoch !== model.accountEpoch) throw new Error('工作区已切换，已忽略上一个账号的界面结果。');
  return result;
}
async function run(key, fn) {
  if (model.pending.has(key)) return;
  model.pending.add(key); model.busy++; updateBusy();
  try { return await fn(); }
    catch (e) { reportError(e); }
  finally { model.pending.delete(key); model.busy--; updateBusy(); }
}
function updateBusy() { const status = $('header-status'); if (status) status.replaceChildren(node('span', { class: model.busy ? 'busy-indicator' : 'status-dot' }), model.busy ? '正在处理…' : '保存在本机'); }
function reportError(error) {
  const message=error?.message || '操作未完成，请重试。';
  const dialog=$('modal');
  if(dialog.open){
    let area=$('modal-error');
    if(!area){area=node('div',{id:'modal-error',class:'error-note modal-inline-error',role:'alert',tabindex:-1});dialog.querySelector('.modal-body')?.append(area);}
    area.textContent=message;area.hidden=false;area.scrollIntoView({block:'nearest'});
  }else toast(message,true);
}
async function requestModalClose() {
  if(model.modalCloseHandler)return model.modalCloseHandler();
  closeModal();
}
function modal(title, body, actions = [], options = {}) {
  invalidateReadingIntent();
  const dialog = $('modal');
  model.modalCloseHandler=options.onClose || null;
  dialog.removeAttribute('data-context');
  dialog.classList.remove('image-viewer','ai-config-dialog');
  dialog.replaceChildren(node('div', { class: 'modal-head' }, node('h2', { id:'modal-title' }, title), button('×', requestModalClose, 'text', { 'aria-label':'关闭对话框' })), node('div', { class: 'modal-body' }, body), node('div', { class:'modal-footer' }, button(options.closeLabel || '取消', requestModalClose, '', {id:'modal-close'}), actions));
  if (!dialog.open) dialog.showModal();
  return dialog;
}
function closeModal() { model.modalCloseHandler=null;$('modal').close(); }
function emptyState(title, description, actions = [], welcome = false) {
  return node('section', { class:`empty-state${welcome ? ' welcome' : ''}` }, welcome ? node('div', { class:'welcome-label' }, '少一点噪音，多一点收获') : node('div', { class:'empty-icon', 'aria-hidden':'true' }, '◌'), node('h2', {}, title), node('p', {}, description), welcome ? node('div', { class:'welcome-steps' }, node('span', {}, node('strong', {}, '01'), '专注阅读'), node('span', {}, node('strong', {}, '02'), '留下价值'), node('span', {}, node('strong', {}, '03'), '回顾时段')) : null, node('div', { class:'empty-actions' }, actions));
}

async function refreshState({background=false}={}) {
  const epoch=model.accountEpoch,state=await api('state');if(epoch!==model.accountEpoch)return;
  model.state = state;
  model.state.groups ||= []; model.state.accounts ||= []; model.state.settings ||= {}; model.state.stats ||= {}; model.state.readPositions ||= {}; model.state.readStates ||= {}; model.state.importantMembers ||= []; model.state.credentials ||= {};
  if (!model.state.groups.some(g => g.selected !== false && String(g.id) === String(model.groupId))) model.groupId = reading.recentGroupId(model.state.groups,model.state.readStates);
  if(background && readingBusy()){queueReadingRefresh();updateUnreadBadges();updateReadChrome();return;}
  renderSidebar(); renderHeader();
}
function renderSidebar() {
  const state = model.state;
  const selector = node('select', { id:'account-select', class:'account-select', 'aria-label':'当前账号', onchange: (e) => void run('switch-account', () => switchAccount(e.target.value)) });
  if (!state.accounts.length) selector.append(node('option', {value:''}, '选择一个工作区'));
  state.accounts.forEach(a => selector.append(node('option', {value:a.id, selected:a.id === state.account?.id}, a.name)));
  const kind = accountKind();
  $('account-area').replaceChildren(selector, node('div', { class:'account-meta' }, node('span', {class:`mode-label${kind === 'demo' ? ' demo' : ''}`}, kind === 'demo' ? '演示数据 · 仅本机' : kind === 'import' ? '导入数据 · 仅本机' : kind === 'weibo' ? '微博账号 · 本机隔离' : '尚未连接'), button('官方登录', showLogin, 'text small', {id:'login-button'})), node('div', { class:'account-actions' }, button('体验演示', loadDemo, 'text small', {id:'demo-button'}), button('导入记录', importData, 'text small', {id:'import-button'})));
  const navs = [ ['read','◫','专注阅读',state.stats.messages], ['bookmarks','☆','价值收藏',state.stats.bookmarks], ['summaries','◷','时段摘要',state.stats.summaries] ];
  $('navigation').replaceChildren(...navs.map(([view, icon, label, count]) => node('button', {class:`nav-button${model.view === view ? ' active' : ''}`, 'aria-current':model.view===view?'page':null, 'data-view':view, onclick:()=>void run(`view-${view}`,()=>setView(view))}, node('span',{class:'nav-symbol','aria-hidden':'true'},icon),node('span',{},label),node('span',{class:'nav-count'},count || '—'))));
  const groups = state.groups.filter(g => g.selected !== false);
  $('group-list').replaceChildren(...(groups.length ? groups.map(g => node('button', {class:`group-item${String(g.id)===String(model.groupId)?' active':''}`, 'data-group-id':g.id, onclick:()=>void run('choose-group',()=>selectGroup(g.id))},node('span',{class:'group-avatar','aria-hidden':'true'},String(g.name || '群').slice(0,1)),node('span',{class:'group-copy'},node('span',{class:'group-name'},g.name),node('span',{class:'group-meta'},g.coverage?.newest ? `${fmt(g.coverage.newest,true)} 更新` : '等待阅读')),node('span',{class:'unread-badge',hidden:!Number(g.unreadCount),'aria-label':`${Number(g.unreadCount)||0} 条未读`},reading.unreadLabel(g.unreadCount)),String(g.id)===String(model.groupId)?node('span',{class:'group-selected-dot'}):null)) : [node('p',{class:'empty-sidebar'},'选择你想读的群聊，\n让信息回到自己的节奏。')]));
  $('manage-groups').disabled = !state.account;
}
function renderHeader() {
  const isRead = model.view === 'read';
  const title = isRead ? currentGroup()?.name || '把对话，读成收获' : model.view === 'bookmarks' ? '价值收藏' : model.summary ? '时段回顾' : '时段摘要';
  const actions = [];
  if (isRead && model.groupId && accountKind() === 'weibo') {
    actions.push(button(model.syncStatus?.enabled===false?'恢复自动更新':'暂停自动更新',toggleAutoSync,'text small',{id:'auto-sync-toggle'}));
    actions.push(button('同步最新',()=>sync(false),'soft',{id:'sync-latest'}));
    actions.push(button('更早记录',()=>sync(true),'',{id:'sync-history'}));
  }
  actions.push(button('工具栏',()=>{$('app').classList.toggle('show-inspector');},'mobile-panel-toggle'));
  $('workspace-header').replaceChildren(node('div',{class:'header-title-row'},node('h1',{title},title),node('div',{class:'header-actions'},actions)),node('div',{class:'header-info-row'},node('span',{id:'header-status',class:'header-status'}),node('p',{id:'sync-status-line',class:'sync-status-line',hidden:accountKind()!=='weibo'})));
  updateBusy();
  renderSyncStatus();renderAiRequestStatus();
}
async function switchAccount(id) {
  await activateAccount('account.switch',{id});
}
function clearContext() { disposeSearchEditor();invalidateReadingIntent();model.accountEpoch++; model.queryVersion++;model.selected.clear(); model.inspected=null; model.preview=null; model.summary=null; model.summaries=[]; model.bookmarks=[];model.bookmarkSelected.clear();model.bookmarkQuery='';model.targets=[]; model.targetId=''; model.groupId=null; model.filters={keyword:'',senderId:'',start:'',end:'',importantOnly:false}; model.offset=0; model.saveNote='';model.saveTags='';model.viewport=null;model.lastReadPayload='';model.syncRevision=null;model.syncStatus=null;model.messageObserver?.disconnect();clearTimeout(model.readTimer); }
async function activateAccount(action,payload={}) {
  if(model.switching)throw new Error('另一个工作区切换正在进行，请稍候。');
  cancelSearchWork();await flushReading(false);stashReadingDraft();
  model.switching=true;
  try{
    const result=await api(action,payload);
    if(result?.canceled || result?.cancelled)return false;
    clearContext();model.view='read';await refreshState();
  }finally{model.switching=false;if(isSearchEditorCurrent(model.searchEditor))scheduleSearch(model.searchEditor);}
  restoreReadingDraft();await loadReading(true);return true;
}
async function loadDemo() { if(await activateAccount('demo'))toast('已打开演示工作区。这里的消息均为模拟数据。'); }
async function importData() { if(await activateAccount('import'))toast('导入完成，记录保存在当前本地工作区。'); }
async function setView(view) {
  disposeSearchEditor();
  await flushReading(false);stashReadingDraft();
  model.view=view; model.summary=null; model.selected.clear(); model.inspected=null; renderSidebar();renderHeader();
  if(view==='read') {restoreReadingDraft();await loadReading(true);}
  else if(view==='bookmarks') await loadBookmarks();
  else {model.summaries=await api('summary.list');renderSummaries();renderInspector();}
}
async function selectGroup(id) { disposeSearchEditor();await flushReading(false);stashReadingDraft();model.groupId=String(id);model.view='read';model.filters={keyword:'',senderId:'',start:'',end:'',importantOnly:false};model.selected.clear();model.inspected=null;model.summary=null;model.preview=null;model.offset=0;model.viewport=null;model.lastReadPayload='';restoreReadingDraft();renderSidebar();renderHeader();await loadReading(true); }
function queryPayload() {
  const f=model.filters; const payload={groupId:model.groupId,keyword:f.keyword,senderId:f.senderId,importantOnly:f.importantOnly,limit:model.limit,offset:model.offset};
  if(f.start) payload.start=new Date(`${f.start}T00:00:00`).getTime();
  if(f.end) { const d=new Date(`${f.end}T00:00:00`);d.setDate(d.getDate()+1);payload.end=d.getTime(); }
  if(payload.start && payload.end && payload.start>=payload.end)throw new Error('结束日期不能早于开始日期。');
  return payload;
}
async function loadReading(restore=false, targetId=null, request=null) {
  if(request && !request.active())return;
  invalidateReadingIntent();
  const version=++model.queryVersion,groupId=model.groupId,epoch=model.accountEpoch;
  const editor=isSearchEditorCurrent(model.searchEditor)?model.searchEditor:null,revision=editor?.revision;
  const active=()=>version===model.queryVersion && epoch===model.accountEpoch && groupId===model.groupId && model.view==='read' &&
    (!editor || isSearchEditorCurrent(editor) && editor.revision===revision && !editor.composing) && (!request || request.active());
  if(!groupId) { renderReading();renderInspector();return; }
  model.messageObserver?.disconnect();
  let offset=model.offset,scrollId=targetId,savedAnchor=null;
  if(restore && !hasFilters()) {
    offset=0;
    const state=model.state.readStates?.[groupId],legacy=model.state.readPositions[groupId];
    const saved=request?.anchor?.anchorId || state?.anchorId || (typeof legacy==='object'?legacy?.messageId || legacy?.id:legacy);
    if(saved) {
      try {
        const located=await api('messages.locate',{groupId,messageId:String(saved)});
        if(!active())return;
        if(located?.message){offset=reading.chooseWindow({anchorIndex:Number(located.offset),limit:model.limit}).offset;scrollId=String(saved);savedAnchor={anchorId:String(saved),anchorOffset:Number(request?.anchor?.anchorOffset)||0};}
      } catch { if(!active())return; /* A removed message must not prevent opening a group. */ }
    }
  }
  if(!active())return;
  const throughId=model.state.readStates?.[groupId]?.readThroughId;
  const [result,members,boundary]=await Promise.all([api('messages.query',{...queryPayload(),offset}),api('members.list',{groupId}),locateReadBoundary(groupId,throughId)]);
  if(!active())return;
  model.readBoundary=boundary;model.offset=offset;model.messages=result.messages || [];model.total=result.total || 0;model.members=members || [];
  renderReading();renderInspector();
  restoreViewport(targetId?{anchorId:String(targetId),anchorOffset:0}:savedAnchor);
  if(scrollId)findMessageElement(scrollId)?.classList.add('target');
  watchMessageSizes();scheduleRead();
  return version;
}

function draftKey() {return `${model.state.account?.id || ''}\u0000${model.groupId || ''}`;}
function stashReadingDraft() {if(model.groupId && model.view==='read')model.drafts.set(draftKey(),{ids:[...model.selected],note:model.saveNote,tags:model.saveTags});}
function restoreReadingDraft() {const draft=model.drafts.get(draftKey());model.selected=new Set(draft?.ids || []);model.saveNote=draft?.note || '';model.saveTags=draft?.tags || '';}
function findMessageElement(id) {return [...($('message-scroll')?.querySelectorAll('[data-message-id]') || [])].find(element=>element.dataset.messageId===String(id));}
async function locateReadBoundary(groupId,id) {
  if(!id)return null;
  try{const located=await api('messages.locate',{groupId,messageId:String(id)});return located?.message?{groupId,id:String(id),offset:Number(located.offset)}:null;}catch{return null;}
}
function measuredMessages() {
  const scroll=$('message-scroll');if(!scroll)return [];
  const elements=[...scroll.querySelectorAll('[data-message-id]')],state=model.state.readStates?.[model.groupId];
  const throughIndex=elements.findIndex(element=>element.dataset.messageId===state?.readThroughId);
  const boundary=model.readBoundary;
  const throughOffset=boundary?.groupId===model.groupId && boundary.id===state?.readThroughId?boundary.offset:-1;
  return elements.map((element,index)=>{
    const box=element.getBoundingClientRect(),id=element.dataset.messageId;
    const loaded=[...element.querySelectorAll('img')].every(img=>img.complete && (img.naturalWidth>0 || img.hidden));
    const ready=reading.mediaReadyForRead({loaded,alreadyRead:throughIndex>=index || throughOffset>=model.offset+index});
    return{id,top:box.top,bottom:box.bottom,ready};
  });
}
function isCurrentReadingRendered() {
  const rendered=model.renderedReading;
  return !!rendered && model.view==='read' && rendered.accountId===model.state.account?.id && rendered.epoch===model.accountEpoch && rendered.groupId===model.groupId && rendered.version===model.queryVersion;
}
function captureViewport() {
  const scroll=$('message-scroll');if(!scroll || !isCurrentReadingRendered())return null;
  const bounds=scroll.getBoundingClientRect();
  return reading.captureViewport({items:measuredMessages(),viewportTop:bounds.top,viewportHeight:scroll.clientHeight,scrollTop:scroll.scrollTop,scrollHeight:scroll.scrollHeight,loadedAtEnd:false});
}
function readingContext() {return JSON.stringify([model.accountEpoch,model.state.account?.id,model.groupId,model.queryVersion,model.layoutVersion,model.intentVersion]);}
function readingOwner() {return JSON.stringify([model.accountEpoch,model.state.account?.id,model.groupId,model.queryVersion,model.view]);}
function readingBusy() {
  const owner=readingOwner();
  return searchEditing() || model.readingActivity?.owner===owner || (model.readingCommits.get(owner)||0)>0 ||
    (model.pointerScrolling && model.pointerReading?.owner===owner && model.pointerReading.scroll===$('message-scroll'));
}
function queueReadingRefresh(force=true) {
  if(model.view!=='read' || !model.groupId || model.closing)return;
  const owner=readingOwner(),previous=model.pendingReadingRefresh;
  model.pendingReadingRefresh={owner,force:force || previous?.owner===owner && previous.force};
  scheduleReadingRefresh();
}
function scheduleReadingRefresh() {
  clearTimeout(model.pendingReadingTimer);
  if(!model.pendingReadingRefresh || readingBusy() || model.restoring || model.refreshRunning || model.closing)return;
  model.pendingReadingTimer=setTimeout(()=>void drainReadingRefresh().catch(()=>{}),0);
}
async function drainReadingRefresh() {
  const pending=model.pendingReadingRefresh;
  if(!pending)return;
  if(pending.owner!==readingOwner() || model.closing){model.pendingReadingRefresh=null;return;}
  if(readingBusy() || model.restoring || model.refreshRunning)return;
  model.pendingReadingRefresh=null;
  // Re-query after the read IPC settles; cached results may predate the gesture.
  await refreshState({background:true});
  if(pending.owner!==readingOwner())return;
  if(readingBusy()){queueReadingRefresh(pending.force);return;}
  await refreshReadingIncrementally(pending.force);
}
function resetReadCandidate() {model.intentVersion++;readIntent.reset();clearTimeout(model.readTimer);model.readingActivity=null;}
function invalidateReadingIntent() {
  resetReadCandidate();model.pointerScrolling=false;model.pointerReading=null;model.touchY=null;
  if(model.pendingReadingRefresh)model.syncRevision=null;
  clearTimeout(model.pendingReadingTimer);model.pendingReadingRefresh=null;
}
function updateReadingSpace() {
  const scroll=$('message-scroll'),space=$('reading-end-space');if(!scroll || !space)return;
  const last=[...scroll.querySelectorAll('[data-message-id]')].at(-1);
  const height=last?reading.trailingSpaceHeight(scroll.clientHeight,last.getBoundingClientRect().height,parseFloat(getComputedStyle(scroll).paddingBottom)||0):0;
  if(space.style.height!==height+'px')space.style.height=height+'px';
}
function restoreViewport(anchor) {
  const scroll=$('message-scroll');if(!scroll || !isCurrentReadingRendered())return;
  // A genuine image/viewport resize invalidates the old visible candidate, but
  // does not pretend that a physically held native thumb has been released.
  resetReadCandidate();model.layoutVersion++;
  model.restoring=true;cancelAnimationFrame(model.restoreFrame);updateReadingSpace();
  if(anchor?.anchorId){const element=findMessageElement(anchor.anchorId);if(element)scroll.scrollTop=reading.restoredScrollTop({scrollTop:scroll.scrollTop,itemTop:element.getBoundingClientRect().top,viewportTop:scroll.getBoundingClientRect().top,anchorOffset:Number(anchor.anchorOffset)||0});}
  model.scrollTop=scroll.scrollTop;model.viewport=captureViewport();
  model.restoreFrame=requestAnimationFrame(()=>{
    if(!isCurrentReadingRendered() || scroll!==$('message-scroll'))return;
    // Images may finish between the first measurement and this frame. Restore the
    // same desired anchor again before accepting a new measurement.
    updateReadingSpace();
    if(anchor?.anchorId){const element=findMessageElement(anchor.anchorId);if(element)scroll.scrollTop=reading.restoredScrollTop({scrollTop:scroll.scrollTop,itemTop:element.getBoundingClientRect().top,viewportTop:scroll.getBoundingClientRect().top,anchorOffset:Number(anchor.anchorOffset)||0});}
    model.restoring=false;model.scrollTop=scroll.scrollTop;model.viewport=captureViewport();updateReadChrome();scheduleReadingRefresh();
  });
}
function watchMessageSizes() {
  model.messageObserver?.disconnect();
  if(typeof ResizeObserver!=='function')return;
  model.messageObserver=new ResizeObserver(()=>{
    if(!isCurrentReadingRendered() || !model.viewport || model.restoring)return;
    restoreViewport({...model.viewport});
    scheduleRead();
  });
  const scroll=$('message-scroll');if(!scroll)return;
  model.messageObserver.observe(scroll);
  scroll.querySelectorAll('[data-message-id]').forEach(element=>model.messageObserver.observe(element));
}
function messageSignature(message) {return JSON.stringify([message,isImportant(message.senderId),model.enrichmentErrors.get(enrichmentKey(message))]);}
function reconcileChildren(parent,children) {
  const desired=new Set(children);let cursor=parent.firstChild;
  for(const child of children){if(child!==cursor)parent.insertBefore(child,cursor);cursor=child.nextSibling;}
  for(const child of [...parent.childNodes])if(!desired.has(child))child.remove();
}
function patchMessageList(messages,anchor) {
  if(readingBusy()){queueReadingRefresh();return;}
  const scroll=$('message-scroll');if(!scroll)return;
  model.messageObserver?.disconnect();
  const existing=new Map([...scroll.querySelectorAll('[data-message-id]')].map(element=>[element.dataset.messageId,element]));
  const days=new Map([...scroll.querySelectorAll('[data-day]')].map(element=>[element.dataset.day,element]));
  const children=[];let day='';
  for(const message of messages){
    const next=new Date(message.time).toDateString();
    if(next!==day){children.push(days.get(next)||node('div',{class:'day-divider','data-day':next},dateLabel(message.time)));day=next;}
    const id=String(message.id),signature=messageSignature(message),previous=existing.get(id);
    const element=previous && model.messageSignatures.get(id)===signature ? previous:messageCard(message);
    if(previous?.classList.contains('target'))element.classList.add('target');
    model.messageSignatures.set(id,signature);children.push(element);
  }
  if(!children.length)children.push(emptyState('这个范围暂时没有消息','可以调整筛选，或等待下次自动更新。'));
  children.push($('reading-end-space') || node('div',{id:'reading-end-space','aria-hidden':'true'}));
  reconcileChildren(scroll,children);restoreViewport(anchor);watchMessageSizes();updateReadChrome();scheduleRead();
}
async function refreshReadingIncrementally(force=false) {
  if(model.refreshRunning || !isCurrentReadingRendered() || !model.groupId || !$('message-scroll'))return;
  if(readingBusy()){queueReadingRefresh(force);return;}
  model.refreshRunning=true;
  const groupId=model.groupId,version=model.queryVersion,epoch=model.accountEpoch;
  const anchor=captureViewport() || model.viewport;
  try{
    let offset=model.offset;
    if(!hasFilters() && model.messages[0]){
      try{const located=await api('messages.locate',{groupId,messageId:String(model.messages[0].id)});offset=Math.max(0,located.offset);}catch{/* Fall back to the current page if an imported record was removed. */}
    }
    if(version!==model.queryVersion || epoch!==model.accountEpoch || groupId!==model.groupId || model.view!=='read')return;
    const throughId=model.state.readStates?.[groupId]?.readThroughId;
    const [result,boundary]=await Promise.all([api('messages.query',{...queryPayload(),offset}),locateReadBoundary(groupId,throughId)]);
    if(version!==model.queryVersion || epoch!==model.accountEpoch || groupId!==model.groupId || model.view!=='read')return;
    if(readingBusy()){queueReadingRefresh(force);return;}
    // Re-capture after awaiting IPC: a user may have scrolled while data was loading.
    const latestAnchor=captureViewport() || anchor;
    model.readBoundary=boundary;model.offset=offset;model.total=result.total || 0;model.messages=result.messages || [];
    patchMessageList(model.messages,latestAnchor);
    if(force){const members=await api('members.list',{groupId});if(version===model.queryVersion && groupId===model.groupId){
      if(readingBusy()){queueReadingRefresh(force);return;}
      const changed=JSON.stringify(model.members)!==JSON.stringify(members || []);model.members=members || [];
      const filter=$('member-filter');if(changed && filter){filter.replaceChildren(node('option',{value:''},'全部成员'),...model.members.map(member=>node('option',{value:member.id,selected:String(member.id)===String(model.filters.senderId)},member.name)));filter.value=model.filters.senderId;}
    }}
  }finally{model.refreshRunning=false;scheduleReadingRefresh();}
}
// The editor belongs to an account/group, not to a result page. Its connected DOM
// must survive queries: detaching even briefly cancels Chromium's native IME.
function searchOwner() {return JSON.stringify([model.accountEpoch,model.state.account?.id,model.groupId,model.view]);}
function isSearchEditorCurrent(editor) {
  return !!editor && editor===model.searchEditor && editor.owner===searchOwner() && model.view==='read' &&
    !model.switching && !model.closing && editor.input.isConnected && $('message-search')===editor.input;
}
function searchEditing() {
  const editor=model.searchEditor;
  return isSearchEditorCurrent(editor) && (editor.composing || editor.timer!==null || editor.applying ||
    editor.draft!==model.filters.keyword);
}
function cancelSearchWork(editor=model.searchEditor) {
  if(!editor)return;
  clearTimeout(editor.timer);editor.timer=null;editor.revision++;
}
function disposeSearchEditor() {
  cancelSearchWork();model.searchEditor=null;model.filterReturn=null;
}
function rememberUnfilteredViewport() {
  if(model.filterReturn?.owner===searchOwner() || !isCurrentReadingRendered() || model.renderedReading.filtered)return;
  const viewport=captureViewport() || model.viewport;
  if(viewport?.anchorId)model.filterReturn={owner:searchOwner(),anchor:{...viewport}};
}
function scheduleSearch(editor) {
  clearTimeout(editor.timer);editor.timer=null;
  if(!isSearchEditorCurrent(editor) || editor.composing)return;
  const revision=editor.revision;
  editor.timer=setTimeout(()=>{
    editor.timer=null;
    if(!isSearchEditorCurrent(editor) || editor.composing || revision!==editor.revision)return;
    void applyFilters(null,{editor,revision});
  },350);
}
function bindSearchEditor(input,filter) {
  const editor={owner:searchOwner(),input,filter,draft:model.filters.keyword,filters:{...model.filters},members:JSON.stringify(model.members),composing:false,timer:null,revision:0,applying:false};
  model.searchEditor=editor;
  input.addEventListener('compositionstart',()=>{
    if(!isSearchEditorCurrent(editor))return;
    rememberUnfilteredViewport();cancelSearchWork(editor);editor.composing=true;invalidateReadingIntent();
  });
  input.addEventListener('input',event=>{
    if(!isSearchEditorCurrent(editor))return;
    rememberUnfilteredViewport();cancelSearchWork(editor);editor.draft=input.value;invalidateReadingIntent();
    if(!editor.composing && !event.isComposing)scheduleSearch(editor);
  });
  input.addEventListener('compositionend',()=>{
    if(!isSearchEditorCurrent(editor))return;
    cancelSearchWork(editor);editor.composing=false;editor.draft=input.value;scheduleSearch(editor);
  });
  input.addEventListener('keydown',event=>{
    if(event.key!=='Enter' || !isSearchEditorCurrent(editor) || editor.composing || event.isComposing || event.keyCode===229)return;
    event.preventDefault();cancelSearchWork(editor);editor.draft=input.value;
    void applyFilters(null,{editor,revision:editor.revision});
  });
  return editor;
}
function updateSearchMembers(editor) {
  const signature=JSON.stringify(model.members),select=editor.filter.querySelector('#member-filter');
  if(signature===editor.members || !select)return;
  // Reuse the select and its first "all members" option as well as the IME input.
  select.replaceChildren(select.firstChild,...model.members.map(member=>node('option',{value:member.id},member.name)));
  select.value=editor.filters.senderId;editor.members=signature;
}
function resetFilterControls(editor) {
  editor.input.value='';editor.draft='';editor.composing=false;
  editor.filters={keyword:'',senderId:'',start:'',end:'',importantOnly:false};
  const member=editor.filter.querySelector('#member-filter');if(member)member.value='';
  editor.filter.querySelectorAll('input[type="date"]').forEach(input=>input.value='');
  const important=editor.filter.querySelector('#important-filter');if(important)important.checked=false;
}
async function clearReadingFilters() {
  const editor=model.searchEditor;if(!isSearchEditorCurrent(editor))return;
  cancelSearchWork(editor);resetFilterControls(editor);
  await applyFilters(null,{editor,revision:editor.revision});
}
function renderReading() {
  model.renderedReading=null;
  const host=$('workspace-content');
  if(!model.state.account || !model.groupId){disposeSearchEditor();host.replaceChildren(emptyState('有价值的对话，\n值得慢慢读。','登录微博选择群聊，或先用演示记录体验。收藏与本地摘录无需配置 AI，也不会发送任何消息。',[button('打开演示工作区',loadDemo,'primary',{id:'welcome-demo'}),button('导入我的记录',importData)],true));return;}
  let filter=model.searchEditor?.filter;
  if(!isSearchEditorCurrent(model.searchEditor) || filter.parentNode!==host){
  disposeSearchEditor();
  const search=node('input',{type:'search',id:'message-search',class:'search-input',placeholder:'搜索当前群的消息…',value:model.filters.keyword,'aria-label':'搜索消息'});
  const member=node('select',{class:'member-select',id:'member-filter','aria-label':'筛选成员',value:model.filters.senderId,onchange:e=>{void applyFilters({senderId:e.target.value});}},node('option',{value:''},'全部成员'),...model.members.map(m=>node('option',{value:m.id,selected:String(m.id)===String(model.filters.senderId)},m.name)));
  const advanced=node('div',{class:'filter-extra',hidden:!model.advanced},field('开始日期',node('input',{type:'date',value:model.filters.start,'aria-label':'阅读开始日期',onchange:e=>{void applyFilters({start:e.target.value});}})),field('结束日期（含当日）',node('input',{type:'date',value:model.filters.end,'aria-label':'阅读结束日期',onchange:e=>{void applyFilters({end:e.target.value});}})),node('div',{class:'filter-check'},check('只看重点成员',model.filters.importantOnly,v=>{void applyFilters({importantOnly:v});},{id:'important-filter'})));
  filter=node('div',{class:'filter-area',id:'reading-filters'},node('div',{class:'filter-row'},node('div',{class:'search-wrap'},node('span',{class:'search-symbol','aria-hidden':'true'},'⌕'),search),member,button(model.advanced?'收起筛选':'更多筛选',()=>{model.advanced=!model.advanced;advanced.hidden=!model.advanced;const btn=$('filter-toggle');btn.textContent=model.advanced?'收起筛选':'更多筛选';},'text small',{id:'filter-toggle'})),advanced);
  bindSearchEditor(search,filter);
  }
  updateSearchMembers(model.searchEditor);
  const meta=node('div',{class:'read-meta'},node('span',{id:'read-count'},`${model.total.toLocaleString()} 条消息${hasFilters()?' · 已筛选':''} · 时间正序`),node('span',{},hasFilters()?button('清除筛选',clearReadingFilters,'text small'):node('span',{},'阅读位置自动保存')));
  const scroll=node('div',{id:'message-scroll',class:'message-scroll',tabindex:0,'aria-label':'消息列表',onscroll:handleReadingScroll});
  bindReadingInput(scroll);
  model.messageSignatures.clear();let day='';model.messages.forEach(m=>{const next=new Date(m.time).toDateString();if(next!==day){scroll.append(node('div',{class:'day-divider','data-day':next},dateLabel(m.time)));day=next;}scroll.append(messageCard(m));model.messageSignatures.set(String(m.id),messageSignature(m));});
  if(!model.messages.length)scroll.append(emptyState('这个范围暂时没有消息','试试调整日期、成员或关键词；新登录的群聊需要手动同步记录。',[button('清除筛选',clearReadingFilters,'soft')]));
  scroll.append(node('div',{id:'reading-end-space','aria-hidden':'true'}));
  const pagination=node('div',{class:'pagination'},button('↑ 更早一页',async()=>{await flushReading(false);model.offset=Math.max(0,model.offset-model.limit);await loadReading();},'',{id:'previous-page',disabled:model.offset===0}),node('span',{id:'page-position'},model.total?`${model.offset+1}–${Math.min(model.offset+model.messages.length,model.total)} / ${model.total}`:'暂无记录'),button('更多消息 ↓',async()=>{await flushReading(false);model.offset+=model.limit;await loadReading();},'',{id:'next-page',disabled:model.offset+model.messages.length>=model.total}));
  const unread=node('div',{id:'new-messages-notice',class:'new-messages-notice','aria-live':'polite'},node('span',{id:'new-messages-count'}),button('加载到最新',jumpToLatest,'primary small',{id:'jump-latest'}));
  reconcileChildren(host,[filter,meta,scroll,selectionBar(),node('footer',{class:'reading-footer','aria-label':'翻页与未读消息'},pagination,unread)]);
  model.renderedReading={accountId:model.state.account.id,epoch:model.accountEpoch,groupId:model.groupId,version:model.queryVersion,filtered:hasFilters()};
  updateReadingSpace();updateReadChrome();
}
function hasFilters() { return Object.values(model.filters).some(Boolean); }
async function applyFilters(changes=null,request=null) {
  const editor=request?.editor || model.searchEditor;
  if(!isSearchEditorCurrent(editor) || request && request.revision!==editor.revision)return;
  rememberUnfilteredViewport();
  if(!request){cancelSearchWork(editor);editor.filters={...editor.filters,...changes};}
  if(editor.composing)return;
  const revision=editor.revision,nextFilters={...editor.filters,keyword:editor.draft};
  const active=()=>isSearchEditorCurrent(editor) && revision===editor.revision && !editor.composing;
  const filtered=Object.values(nextFilters).some(Boolean),token={revision};
  editor.applying=token;
  try{
    await run(`filter-messages-${editor.owner}-${revision}`,async()=>{
      if(!active())return;
      await flushReading(false);
      if(!active())return;
      const anchor=model.filterReturn?.owner===editor.owner?model.filterReturn.anchor:null;
      model.filters=nextFilters;model.offset=0;model.selected.clear();
      const version=await loadReading(!filtered,null,{active,anchor});
      if(version && active() && !filtered)model.filterReturn=null;
    });
  }finally{
    if(editor.applying===token)editor.applying=false;
    scheduleReadingRefresh();
  }
}
function messageCard(m) {
  const selected=model.selected.has(String(m.id));const important=isImportant(m.senderId);let tone=0;for(const char of String(m.senderId))tone=(tone+char.charCodeAt(0))%5;
  const card=node('article',{class:`message${selected?' chosen':''}`, 'data-message-id':m.id});
  const cb=node('input',{type:'checkbox',class:'message-check',checked:selected,'aria-label':`选择 ${m.senderName} ${fmt(m.time)} 的消息`,onchange:e=>{if(e.target.checked)model.selected.add(String(m.id));else model.selected.delete(String(m.id));card.classList.toggle('chosen',e.target.checked);model.inspected=m;updateSelection();}});
  const tools=node('div',{class:'message-tools'},button('☆ 收藏',()=>{model.selected=new Set([String(m.id)]);model.inspected=m;updateSelection();$('app').classList.add('show-inspector');$('bookmark-note')?.focus();},'text small',{'aria-label':`收藏 ${m.senderName} 的消息`}),button(important?'★ 取消重点':'☆ 设为重点',async()=>{await api('important.set',{senderId:m.senderId,enabled:!important});await refreshState({background:true});await refreshReadingIncrementally(true);},`text small${important?' active':''}`),node('span',{class:'message-id'},`#${String(m.id).slice(-6)}`));
  card.append(cb,node('div',{class:`avatar tone-${tone}`,'aria-hidden':'true'},String(m.senderName||'?').slice(0,1)),node('div',{class:'message-copy'},node('div',{class:'message-top'},node('span',{class:'sender-name'},m.senderName),node('span',{class:'message-time'},fmt(m.time)),important?node('span',{class:'important-marker'},'★ 重点'):null),renderMessageContent(m),tools));
  return card;
}
function safeMediaSource(value) {
  if(typeof value!=='string')return '';
  try{const url=new URL(value);return url.protocol==='app:' && url.hostname==='media' && !url.username && !url.password?url.href:'';}catch{return '';}
}
function officialChatButton() {return button('官方页面',()=>api('external.open',{url:'https://api.weibo.com/chat'}),'text small');}
function imageGallery(images,message,caption='群聊图片') {
  const pictures=Array.isArray(images)?images:[];
  return node('div',{class:`message-media${pictures.length===1?' single':''}`},pictures.map((picture,index)=>{
    const src=safeMediaSource(picture.src),original=safeMediaSource(picture.originalSrc || picture.src);
    const cell=node('figure',{class:'image-cell'});
    const loading=node('span',{class:'image-loading'},'正在加载图片…');
    const failure=node('div',{class:'image-failure',hidden:true},node('p',{},'图片加载失败，可重试或在官方页面查看。'));
    const image=node('img',{class:'message-image',alt:`${caption} ${index+1}，点击查看原图`,loading:'lazy',decoding:'async',width:Math.max(1,Math.min(16000,Number(picture.width)||640)),height:Math.max(1,Math.min(16000,Number(picture.height)||480)),referrerpolicy:'no-referrer'});
    image.addEventListener('load',()=>{loading.hidden=true;failure.hidden=true;image.hidden=false;if(!picture.width || !picture.height){image.width=image.naturalWidth || 640;image.height=image.naturalHeight || 480;}});
    image.addEventListener('error',()=>{loading.hidden=true;image.hidden=true;failure.hidden=false;});
    const retry=()=>{if(!src)return;image.hidden=false;failure.hidden=true;loading.hidden=false;const url=new URL(src);url.searchParams.set('retry',String(Date.now()));image.src=url.href;};
    failure.append(button('重试',retry,'small',{disabled:!src}),officialChatButton());
    const open=node('button',{type:'button',class:'image-button','aria-label':`查看${caption}${index+1}原图`,onclick:()=>{if(original)showOriginalImage(original,`${caption} ${index+1}`,message);else reportError(new Error('这张图片没有可用的本机代理地址，请在官方页面查看。'));}},image);
    cell.append(open,loading,failure,node('figcaption',{class:'image-caption'},'点击查看原图'));
    if(src)image.src=src;else{loading.hidden=true;image.hidden=true;failure.hidden=false;}
    return cell;
  }));
}
function showOriginalImage(source,title,message) {
  const src=safeMediaSource(source);if(!src)throw new Error('图片地址未通过本机代理检查。');
  const status=node('p',{class:'image-viewer-status',role:'status'},'正在加载原图…');
  const image=node('img',{class:'image-original',alt:title,decoding:'async',referrerpolicy:'no-referrer'});
  const retry=()=>{status.textContent='正在加载原图…';status.hidden=false;image.hidden=false;const url=new URL(src);url.searchParams.set('retry',String(Date.now()));image.src=url.href;};
  image.addEventListener('load',()=>{status.hidden=true;});
  image.addEventListener('error',()=>{image.hidden=true;status.hidden=false;status.textContent='原图加载失败，可重试或在官方页面查看。';});
  const body=node('div',{},node('div',{class:'image-viewer-frame'},image),status,node('p',{class:'caption'},`${message.senderName || '群聊分享'} · ${fmt(message.time,true)}`));
  const dialog=modal(title,body,[button('重新加载',retry),officialChatButton(),button('关闭原图',closeModal,'primary')]);dialog.classList.add('image-viewer');image.src=src;
}
function isNotificationOnly(message) {
  if(!/^我发布了新微博[，,]\s*快来围观吧[！!]?$/.test(String(message.text || '').trim()))return false;
  const post=message.sharedPost;
  if(!post)return true;
  return post.state==='unavailable' && post.reason==='通知未提供原微博地址，无法确定原帖' &&
    post.text==='' && Array.isArray(post.images) && post.images.length===0 &&
    [post.id,post.url,post.author].every(value=>value===undefined || value===null || value==='') && !post.truncated;
}
function isLegacyShare(message) {return !isNotificationOnly(message) && !message.mediaVersion && /分享.*图片|我发布了新微博|分享.*微博/.test(message.text || '');}
function enrichmentKey(message) {return `${model.state.account?.id || ''}\u0000${message.groupId}\u0000${message.id}`;}
function renderMessageContent(message) {
  const content=node('div',{class:'message-content'},node('div',{class:'message-text'},message.text || ''));
  if(message.images?.length)content.append(imageGallery(message.images,message));
  const post=message.sharedPost;
  if(post && !isNotificationOnly(message)){
    const cached=post.state!=='ready' && !!(post.text || post.images?.length);
    const card=node('section',{class:'shared-post'},node('div',{class:'shared-post-title'},node('strong',{},post.author || '分享的微博'),node('span',{},cached?'本地缓存':post.state==='ready'?'微博内容':'内容暂不可用')));
    if(post.text)card.append(node('div',{class:'shared-post-text'},post.text));
    if(post.images?.length)card.append(imageGallery(post.images,message,'微博配图'));
    if(post.state!=='ready')card.append(node('p',{class:'shared-post-warning'},`${cached?'这里保留的是本地缓存内容，当前原帖未确认可用。\n':''}${post.reason || '当前无法取得原微博内容，请通过原链接或官方页面核对。'}`));
    if(post.truncated)card.append(node('p',{class:'shared-post-warning'},'当前返回的微博正文可能不完整，请打开原微博查看全文。'));
    if(post.url)card.append(button('打开原微博 ↗',()=>api('external.open',{url:post.url}),'text small'));
    if(post.state!=='ready' && post.url && accountKind()==='weibo')card.append(button('重试读取原文',()=>enrichMessages([message],true),'text small'));
    content.append(card);
  }
  if(isLegacyShare(message)){
    const error=model.enrichmentErrors.get(enrichmentKey(message));
    const note=node('div',{class:'legacy-share-note'},error?`补全未完成：${error}`:'这条旧记录尚未保存图片或微博内容，待按需补全。');
    if(accountKind()==='weibo')note.append(button(error?'重试补全':'补全这条分享',()=>enrichMessages([message],true),'text small'));
    else note.textContent='这条导入记录未包含图片或原微博内容，可导入完整数据或在官方页面查看。';
    content.append(note);
  }
  if(message.mediaVersion && /分享.*图片/.test(message.text || '') && !message.images?.length && !post?.images?.length)content.append(node('p',{class:'legacy-share-note'},'这条消息未提供可用的图片地址，可在官方页面查看。'),officialChatButton());
  return content;
}
async function enrichMessages(messages,manual=false) {
  if(model.enriching || accountKind()!=='weibo' || model.switching)return;
  const groupId=messages[0]?.groupId;if(!groupId)return;
  const candidates=messages.filter(m=>m.groupId===groupId && (isLegacyShare(m) || manual && m.sharedPost?.state==='unavailable' && m.sharedPost?.url) && (manual || !model.enrichmentAttempted.has(enrichmentKey(m)))).slice(0,10);
  if(!candidates.length)return;
  model.enriching=true;const epoch=model.accountEpoch;
  candidates.forEach(message=>{model.enrichmentAttempted.add(enrichmentKey(message));model.enrichmentErrors.delete(enrichmentKey(message));});
  try{
    const result=await api('messages.enrich',{groupId,messageIds:candidates.map(m=>String(m.id)),retry:manual});
    if(epoch!==model.accountEpoch)return;
    if(result?.deferred){
      candidates.forEach(message=>model.enrichmentAttempted.delete(enrichmentKey(message)));
      clearTimeout(model.enrichmentRetryTimer);
      model.enrichmentRetryTimer=setTimeout(()=>{if(epoch===model.accountEpoch && groupId===model.groupId && !model.closing){if(manual)void enrichMessages(candidates,true);else void enrichVisibleMessages();}},2000);
      return;
    }
    if(groupId===model.groupId)await refreshReadingIncrementally(true);
  }
  catch(error){if(epoch===model.accountEpoch){candidates.forEach(message=>model.enrichmentErrors.set(enrichmentKey(message),error?.message || '暂时无法读取分享内容'));if(groupId===model.groupId)patchMessageList(model.messages,captureViewport());}}
  finally{model.enriching=false;}
}
async function enrichVisibleMessages() {
  if(model.view!=='read' || !model.state.sessionReady || !canAdvanceRead())return;
  const scroll=$('message-scroll');if(!scroll)return;const bounds=scroll.getBoundingClientRect();
  const visible=new Set([...scroll.querySelectorAll('[data-message-id]')].filter(element=>{const rect=element.getBoundingClientRect();return rect.bottom>bounds.top && rect.top<bounds.bottom;}).map(element=>element.dataset.messageId));
  await enrichMessages(model.messages.filter(message=>visible.has(String(message.id))));
}
function selectionBar() { return node('div',{id:'selection-bar',class:'selection-bar',hidden:!model.selected.size},node('span',{},`已选择 ${model.selected.size} 条消息`),button('整理收藏',()=>{renderInspector();$('app').classList.add('show-inspector');$('bookmark-note')?.focus();},'primary small'),button('取消',()=>{model.selected.clear();updateSelection();},'text small')); }
function updateSelection() { document.querySelectorAll('[data-message-id]').forEach(el=>{const yes=model.selected.has(el.dataset.messageId);el.classList.toggle('chosen',yes);el.querySelector('input[type=checkbox]').checked=yes;});const bar=$('selection-bar');if(bar)bar.replaceWith(selectionBar());renderInspector(); }
function bindReadingInput(scroll) {
  const arm=event=>{
    if(!event.isTrusted || !canAdvanceRead() || hasFilters())return false;
    clearTimeout(model.readTimer);
    // A new input supersedes a pending programmatic restore frame.
    cancelAnimationFrame(model.restoreFrame);model.restoring=false;
    // Chromium may apply a compositor scroll before the passive wheel listener.
    // The last accepted position is the baseline, not the already-moved DOM value.
    readIntent.arm(readingContext(),model.scrollTop,performance.now(),true);
    model.readingActivity={owner:readingOwner()};
    // Settle inputs that never move; an idle save does not release a held thumb.
    scheduleRead();
    return true;
  };
  scroll.addEventListener('wheel',event=>{if(event.deltaY>0)arm(event);else invalidateReadingIntent();},{passive:true});
  scroll.addEventListener('keydown',event=>{
    if(event.target!==scroll || event.ctrlKey || event.metaKey || event.altKey)return;
    if(['ArrowDown','PageDown','End',' '].includes(event.key) && !event.shiftKey)arm(event);
    else if(['ArrowUp','PageUp','Home'].includes(event.key) || event.key===' ' && event.shiftKey)invalidateReadingIntent();
  });
  scroll.addEventListener('pointerdown',event=>{
    // Only a native scrollbar drag grants scroll intent; clicking message tools does not.
    const bounds=scroll.getBoundingClientRect();
    if(event.button===0 && event.target===scroll && event.clientX>=bounds.right-(scroll.offsetWidth-scroll.clientWidth)-2){
      model.pointerScrolling=arm(event);model.pointerReading=model.pointerScrolling?{owner:readingOwner(),scroll}:null;
    }
    if(event.pointerType==='touch')model.touchY=event.clientY;
  });
  scroll.addEventListener('pointermove',event=>{
    if(event.pointerType==='touch' && model.touchY!==null){if(event.clientY<model.touchY)arm(event);model.touchY=event.clientY;}
    else if(model.pointerScrolling && event.buttons)arm(event);
  });
}
function handleReadingScroll() {
  const scroll=$('message-scroll');if(!scroll || model.restoring || !isCurrentReadingRendered())return;
  model.viewport=captureViewport();
  // Chromium handles an active native scrollbar drag without dispatching DOM
  // pointermove events. Its verified pointerdown stays valid until release or
  // context cancellation; renew from the last accepted position on each move.
  if(model.pointerScrolling && model.pointerReading?.owner===readingOwner() && model.pointerReading.scroll===scroll && scroll.scrollTop>model.scrollTop && canAdvanceRead() && !hasFilters()){
    readIntent.arm(readingContext(),model.scrollTop,performance.now(),true);model.readingActivity={owner:readingOwner()};
  }
  const candidate=canAdvanceRead() && !hasFilters()?readIntent.scroll(readingContext(),scroll.scrollTop,performance.now(),model.viewport?.readThroughId):null;
  model.scrollTop=scroll.scrollTop;updateReadChrome();scheduleRead(candidate);
}
function canAdvanceRead() {return isCurrentReadingRendered() && !searchEditing() && document.visibilityState==='visible' && document.hasFocus() && !$('modal').open && !model.switching;}
function scheduleRead(candidate=null) {
  clearTimeout(model.readTimer);
  model.readTimer=setTimeout(()=>{void flushReading(candidate).catch(()=>{});void enrichVisibleMessages();},500);
}
function validReadCandidate(candidate) {
  if(!candidate || candidate.context!==readingContext() || !canAdvanceRead() || hasFilters())return false;
  if(candidate.kind==='latest')return true;
  const scroll=$('message-scroll');if(!scroll)return false;
  const top=scroll.getBoundingClientRect().top,bottom=top+scroll.clientHeight,items=measuredMessages();
  const index=items.findIndex(item=>item.id===candidate.readThroughId),item=items[index];
  return !!item && item.bottom>top+1 && item.bottom<=bottom+1 && items.slice(0,index+1).every(item=>item.ready);
}
async function flushReading(candidate=null) {
  clearTimeout(model.readTimer);
  if(candidate===false)invalidateReadingIntent();else if(!candidate)resetReadCandidate();
  const owner=readingOwner(),activity=model.readingActivity;
  const settle=()=>{if(model.readingActivity===activity)model.readingActivity=null;scheduleReadingRefresh();};
  // Filter result positions are temporary. Persist only the ordinary reading pane;
  // clearing a search restores its captured anchor without spending read intent.
  if(!isCurrentReadingRendered() || model.renderedReading.filtered || !model.groupId || !model.state.account || model.switching){settle();return;}
  const viewport=captureViewport() || model.viewport;if(!viewport?.anchorId){settle();return;}
  model.viewport=viewport;
  const accountId=model.state.account.id,groupId=model.groupId,epoch=model.accountEpoch;
  const payload={groupId,anchorId:viewport.anchorId,anchorOffset:viewport.anchorOffset,atBottom:false};
  if(validReadCandidate(candidate))payload.readThroughId=candidate.readThroughId;
  const key=JSON.stringify([accountId,payload]);if(key===model.lastReadPayload){try{return await model.readWrite;}finally{settle();}}
  const local={...(model.state.readStates?.[groupId] || {}),anchorId:viewport.anchorId,anchorOffset:viewport.anchorOffset,atBottom:false};
  model.state.readStates ||= {};model.state.readStates[groupId]=local;model.state.readPositions[groupId]=viewport.anchorId;
  model.lastReadPayload=key;
  model.readingCommits.set(owner,(model.readingCommits.get(owner)||0)+1);
  const operation=model.readWrite.catch(()=>{}).then(async()=>{
    if(epoch!==model.accountEpoch || accountId!==model.state.account?.id)return;
    // Queued anchor writes are bound to their old group. Queued read permission is
    // narrower: any navigation, layout change or focus loss cancels it before IPC.
    if(payload.readThroughId && !validReadCandidate(candidate))delete payload.readThroughId;
    try{
      const result=await api('read.set',payload);
      if(epoch!==model.accountEpoch)return;
      if(result && typeof result==='object'){
        const stats=result.readState || result;
        model.state.readStates[groupId]={...local,...stats};
        const g=model.state.groups.find(item=>item.id===groupId);if(g && Number.isFinite(stats.unreadCount)){g.unreadCount=stats.unreadCount;g.firstUnreadId=stats.firstUnreadId;}
        updateUnreadBadges();updateReadChrome();
      }
    }catch(error){if(model.lastReadPayload===key)model.lastReadPayload='';throw error;}
  });
  model.readWrite=operation;
  try{return await operation;}finally{
    const remaining=(model.readingCommits.get(owner)||1)-1;
    if(remaining)model.readingCommits.set(owner,remaining);else model.readingCommits.delete(owner);
    settle();
  }
}
function updateUnreadBadges() {
  for(const element of document.querySelectorAll('#group-list [data-group-id]')){
    const group=model.state.groups.find(g=>g.id===element.dataset.groupId),badge=element.querySelector('.unread-badge');if(!badge)continue;
    const count=Number(group?.unreadCount)||0;badge.hidden=count===0;badge.textContent=reading.unreadLabel(count);badge.setAttribute('aria-label',`${count} 条未读`);
  }
}
function updateReadChrome() {
  const count=$('read-count');if(count)count.textContent=`${model.total.toLocaleString()} 条消息${hasFilters()?' · 已筛选':''} · 时间正序`;
  const position=$('page-position');if(position)position.textContent=model.total?`${model.offset+1}–${Math.min(model.offset+model.messages.length,model.total)} / ${model.total}`:'暂无记录';
  if($('previous-page'))$('previous-page').disabled=model.offset===0;
  if($('next-page'))$('next-page').disabled=model.offset+model.messages.length>=model.total;
  const unread=Number(currentGroup()?.unreadCount)||0;
  const notice=$('new-messages-notice');if(notice){notice.hidden=false;$('new-messages-count').textContent=`${unread} 条未读消息`;}
}
async function jumpToLatest(event) {
  if(!event?.isTrusted)return;
  const groupId=model.groupId,epoch=model.accountEpoch,version=model.queryVersion;
  const active=()=>groupId===model.groupId && epoch===model.accountEpoch && version===model.queryVersion && model.view==='read';
  await flushReading(false);if(!active())return;
  // The count is a snapshot. Messages arriving after it are outside this action.
  const first=await api('messages.query',{groupId,limit:1,offset:0});if(!active())return;
  const total=Number(first.total)||0;
  disposeSearchEditor();model.filters={keyword:'',senderId:'',start:'',end:'',importantOnly:false};
  const offset=reading.chooseWindow({total,limit:model.limit,latestRequested:true}).offset;
  invalidateReadingIntent();const jumpVersion=++model.queryVersion;
  const current=()=>groupId===model.groupId && epoch===model.accountEpoch && jumpVersion===model.queryVersion && model.view==='read';
  const [result,members]=await Promise.all([api('messages.query',{groupId,offset,limit:Math.max(1,total-offset)}),api('members.list',{groupId})]);
  if(!current())return;
  model.messageObserver?.disconnect();
  model.offset=offset;model.total=result.total || 0;model.messages=(result.messages || []).slice(0,Math.max(0,total-offset));model.members=members || [];
  renderReading();renderInspector();restoreViewport(null);
  const scroll=$('message-scroll'),last=model.messages.at(-1),element=last && findMessageElement(last.id);
  if(element){scroll.scrollTop=Math.max(0,scroll.scrollTop+element.getBoundingClientRect().bottom-scroll.getBoundingClientRect().bottom);model.scrollTop=scroll.scrollTop;model.viewport=captureViewport();}
  // Explicit jump grants only this captured last message, never a subsequent arrival.
  const candidate=last?Object.freeze({context:readingContext(),kind:'latest',readThroughId:String(last.id)}):null;
  await flushReading(candidate);if(!current())return;
  watchMessageSizes();scheduleRead();
}
async function jumpToMessage(ref) {
  await flushReading(false);stashReadingDraft();
  const groupId=String(ref.groupId || model.summary?.groupId || model.groupId);const messageId=String(ref.messageId || ref.id);
  const result=await api('messages.locate',{groupId,messageId});if(!result?.message)throw new Error('原文暂未保存在本机，请同步该时段后重试。');
  disposeSearchEditor();model.groupId=groupId;model.view='read';model.filters={keyword:'',senderId:'',start:'',end:'',importantOnly:false};model.offset=Math.max(0,Number(result.offset)-25);model.selected.clear();model.inspected=null;model.summary=null;renderSidebar();renderHeader();await loadReading(false,messageId);toast('已定位到本机保存的原始消息。');
}
async function sync(history) { const result=await api('sync',{groupId:model.groupId,history});await refreshState({background:true});await refreshReadingIncrementally(true);model.preview=null;toast(`同步完成${result?.messages?.length!==undefined?`，本次读取 ${result.messages.length} 条记录`:result?.count!==undefined?`，新增 ${result.count} 条记录`:''}。`); }
function renderSyncStatus() {
  const line=$('sync-status-line');if(!line || accountKind()!=='weibo')return;
  const status=model.syncStatus;
  line.textContent=!status?'自动更新默认每 60 秒运行，阅读位置保持不变。':status.running?'正在后台更新群聊，阅读位置保持不变。':status.error?`更新暂缓：${status.error}`:status.pausedReason?`自动更新已暂停：${status.pausedReason}`:status.enabled===false?'自动更新已暂停，仍可手动同步。':`每 ${Math.round((status.intervalMs || 60000)/1000)} 秒自动更新${status.lastSuccessAt?` · 上次 ${fmt(status.lastSuccessAt)}`:''}`;
  line.classList.toggle('has-error',!!status?.error);
  const toggle=$('auto-sync-toggle');if(toggle)toggle.textContent=status?.enabled===false?'恢复自动更新':'暂停自动更新';
}
async function toggleAutoSync() {model.syncStatus=await api('sync.configure',{enabled:model.syncStatus?.enabled===false});renderSyncStatus();}
async function pollUpdates() {
  if(model.polling || model.switching || model.closing)return;
  model.polling=true;
  try{
    const epoch=model.accountEpoch;
    const status=await api('sync.status');
    if(epoch!==model.accountEpoch || status?.accountId && status.accountId!==model.state.account?.id)return;
    const changed=model.syncRevision!==status.revision;
    model.syncStatus=status;if(readingBusy())queueReadingRefresh();else renderSyncStatus();
    if(changed){
      await refreshState({background:true});
      if(epoch!==model.accountEpoch)return;
      await refreshReadingIncrementally(true);updateReadChrome();model.syncRevision=status.revision;
    }
  }catch(error){
    // Background errors are visible beside the sync controls, never blocking reading.
    if(accountKind()==='weibo' && !model.switching){model.syncStatus={...(model.syncStatus||{}),error:error?.message || '暂时无法读取更新状态'};if(readingBusy())queueReadingRefresh();else renderSyncStatus();}
  }finally{model.polling=false;}
}
function startUpdatePolling() {clearInterval(model.pollTimer);model.pollTimer=setInterval(()=>void pollUpdates(),2000);void pollUpdates();}

function renderInspector() {
  const host=$('inspector');const children=[];
  if(!model.state.account){children.push(node('p',{class:'muted-copy'},'从一段对话开始。\n连接群聊后，便可以保存片段，整理自己的时段回顾。'),node('div',{class:'tool-card'},node('div',{class:'tool-card-heading'},'由你掌控数据'),node('p',{},'默认在本机处理。AI 与 Notion 都需要你的配置和主动确认。')));host.replaceChildren(...children);return;}
  if(model.selected.size)children.push(bookmarkComposer());
  if(model.summary){children.push(notionPanel(),node('div',{class:'inspector-divider'}));}
  children.push(summaryComposer());
  children.push(node('div',{class:'source-note'},accountKind()==='demo'?'当前是演示工作区，所有群聊与人物均为模拟数据。':'本地消息只覆盖已导入或同步的记录。时段摘要会提示可见的覆盖缺口。'));
  host.replaceChildren(...children);
}
function bookmarkComposer() {
  const selected=model.messages.filter(m=>model.selected.has(String(m.id)));
  const note=node('textarea',{id:'bookmark-note',placeholder:'为什么值得留下？写一点想法…',value:model.saveNote,oninput:e=>model.saveNote=e.target.value, maxlength:10000});
  const tags=node('input',{id:'bookmark-tags',placeholder:'例如：产品, 灵感, 待读',value:model.saveTags,oninput:e=>model.saveTags=e.target.value,maxlength:600});
  return node('section',{class:'tool-card'},node('div',{class:'tool-card-heading'},node('span',{class:'tool-card-symbol'},'☆'),`收藏 ${model.selected.size} 条消息`),node('div',{class:'quote-preview'},selected.slice(0,3).map(m=>`${m.senderName}：${m.text.slice(0,130)}`).join('\n\n')),field('我的备注',note),field('标签 · 用逗号分隔',tags),button('保存到价值收藏',saveBookmark,'primary full',{id:'save-bookmark'}));
}
async function saveBookmark() { if(!model.selected.size)return;await api('bookmark.add',{messageIds:[...model.selected],groupId:model.groupId,note:model.saveNote.trim(),tags:model.saveTags.split(/[,，]/).map(s=>s.trim()).filter(Boolean)});model.selected.clear();model.saveNote='';model.saveTags='';await refreshState();updateSelection();toast('已保存收藏。备注和标签可以在收藏页重新整理。'); }
function getRange() { const start=new Date(model.range.start).getTime(),end=new Date(model.range.end).getTime();if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)throw new Error('请选择有效的起止时间，结束时间应晚于开始时间。');return{groupId:model.groupId,start,end}; }
function setSummaryEndNow() {
  model.range.end=localInput(new Date(),true);model.preview=null;
  if($('summary-end'))$('summary-end').value=model.range.end;
  // Keep the exact local value visible even when the chosen start needs correcting.
  try{getRange();renderInspector();}catch(error){renderInspector();throw error;}
}
function summaryComposer() {
  const endField=node('div',{class:'field range-end-field'},
    node('div',{class:'range-end-heading'},node('label',{for:'summary-end'},'结束时间 · 不含'),button('此刻',setSummaryEndNow,'small',{id:'summary-now',title:'使用本机当前时间，精确到秒'})),
    node('input',{type:'datetime-local',id:'summary-end',step:1,value:model.range.end,onchange:e=>{model.range.end=e.target.value;model.preview=null;renderInspector();}}));
  const range=node('div',{class:'range-stack'},field('开始时间',node('input',{type:'datetime-local',id:'summary-start',value:model.range.start,onchange:e=>{model.range.start=e.target.value;model.preview=null;renderInspector();}})),endField);
  const card=node('section',{class:'tool-card'},node('div',{class:'tool-card-heading'},node('span',{class:'tool-card-symbol'},'◷'),'按时段回顾'),node('p',{},model.groupId?`当前群聊 · ${groupName(model.groupId)}`:'先在左侧选择一个群聊'),range,node('div',{class:'range-presets'},...['今天','昨天','近 7 天'].map((text,i)=>node('button',{type:'button',class:'chip',onclick:()=>{const now=new Date();now.setHours(0,0,0,0);let a=new Date(now),b=new Date(now);b.setDate(b.getDate()+1);if(i===1){a.setDate(a.getDate()-1);b=new Date(now);}if(i===2)a.setDate(a.getDate()-6);model.range={start:localInput(a),end:localInput(b)};model.preview=null;renderInspector();}},text))),button('检查时段与内容',previewSummary,'full',{id:'preview-summary',disabled:!model.groupId}));
  if(model.preview){const p=model.preview;card.append(node('div',{class:'preview-stats'},node('div',{class:'preview-stat'},node('strong',{},p.messageCount ?? p.messages?.length ?? 0),node('span',{},'条消息')),node('div',{class:'preview-stat'},node('strong',{},p.chunkCount ?? p.chunks?.length ?? 0),node('span',{},'个分段')),node('div',{class:'preview-stat'},node('strong',{},new Set((p.messages||[]).map(m=>m.senderId)).size+(p.messageCount>(p.messages?.length||0)?'+':'')),node('span',{},'位参与者'))),p.warning?node('div',{class:'warning'},noteText(p.warning)):null,button('查看待处理内容',showSummaryPreview,'text small'));}
  card.append(button('生成本地摘录',()=>generateSummary(false),'primary full',{id:'generate-local',disabled:!model.groupId}),button('使用 AI 总结…',confirmAI,'full',{id:'generate-ai',disabled:!model.groupId || model.aiRequest?.status==='running'}),node('p',{class:'caption'},'本地摘录不联网。AI 总结仅在你确认后，将选定时段的文本发送至所配置服务。'));
  return card;
}
async function previewSummary() { model.preview=await api('summary.preview',getRange());renderInspector();if(!model.preview.messageCount)toast('这个时段没有本地消息，可调整时段或先同步记录。'); }
function showSummaryPreview() {const p=model.preview;if(!p)return;modal('待处理内容预览',node('div',{},node('p',{class:'form-description'},`${p.messageCount} 条消息，${p.chunkCount} 个分段。下方展示前 ${(p.messages||[]).length} 条。时间范围采用开始含、结束不含的边界。`),p.warning?node('div',{class:'warning'},noteText(p.warning)):null,node('div',{class:'preview-blocks'},(p.messages||[]).map(m=>`${fmt(m.time,true)}  ${m.senderName}\n${m.text}`).join('\n\n'))),[button('知道了',closeModal,'primary')]);}
async function generateSummary(ai,rangeSnapshot=null) {await flushReading(false);stashReadingDraft();const range=rangeSnapshot || getRange();const summary=await api(ai?'summary.ai':'summary.local',{...range,confirmed:true});model.summary=summary;model.view='summaries';model.summaries=await api('summary.list');await refreshState();renderSidebar();renderHeader();renderSummary();renderInspector();toast(ai?'AI 摘要已保存，请结合引用核对内容。':'本地摘录已生成并保存。');}
function aiRequestBelongsHere(request) {return request && request.accountId===model.state.account?.id;}
function renderAiRequestStatus() {
  const request=model.aiRequest,header=$('workspace-header');if(!header)return;
  const running=request?.status==='running';
  const generate=$('generate-ai');if(generate){generate.disabled=!model.groupId || running;generate.textContent=running?'AI 请求处理中…':'使用 AI 总结…';}
  $('ai-request-status')?.remove();
  if(!request || !aiRequestBelongsHere(request) && !running)return;
  const here=aiRequestBelongsHere(request);
  const message=!here?'另一工作区的 AI 请求正在处理中，请等待完成。':running?'AI 请求处理中：等待发送确认或服务返回，可以继续阅读。':request.status==='complete'?'AI 摘要已保存。':request.status==='detached'?'请求期间工作区已切换，请回原账号查看结果；不会自动重试。':request.error || '本次 AI 请求未完成，不会自动重试。';
  const actions=[];
  if(here && request.status==='complete')actions.push(button('查看摘要',async()=>{
    const epoch=model.accountEpoch;await flushReading(false);stashReadingDraft();if(epoch!==model.accountEpoch)return;
    model.summary=request.summary;model.groupId=request.summary.groupId;model.view='summaries';renderSidebar();renderHeader();renderSummary();renderInspector();
  },'text small',{id:'view-ai-summary'}));
  if(!running)actions.push(button('关闭',()=>{if(model.aiRequest===request)model.aiRequest=null;renderAiRequestStatus();},'text small',{id:'dismiss-ai-status','aria-label':'关闭 AI 请求状态'}));
  header.append(node('div',{id:'ai-request-status',class:'ai-request-status '+request.status,role:'status','aria-live':'polite','aria-busy':String(running)},running?node('span',{class:'busy-indicator','aria-hidden':'true'}):null,node('span',{id:'ai-request-message'},message),...actions));
}
function startAiSummary(range) {
  if(model.aiRequest?.status==='running')return;
  const request={sequence:++model.aiRequestSequence,status:'running',accountId:model.state.account?.id,epoch:model.accountEpoch,range:Object.freeze({...range}),error:'',summary:null};
  // Lock before closing the dialog or yielding: a second click cannot create a second request.
  model.aiRequest=request;closeModal();renderAiRequestStatus();
  void run('active-ai-request-'+request.sequence,async()=>{
    try{
      await flushReading(false);stashReadingDraft();
      if(request.epoch!==model.accountEpoch || request.accountId!==model.state.account?.id)throw new Error('工作区已切换');
      const summary=await api('summary.ai',{...request.range,confirmed:true});
      request.summary=summary;request.status='complete';
      // Updating navigation never replaces the reading DOM or opens the result by itself.
      try{await refreshState();model.summaries=await api('summary.list');}catch{/* The returned summary is already saved; listing can be refreshed later. */}
    }catch(error){
      request.status=request.epoch!==model.accountEpoch?'detached':'error';
      request.error=String(error?.message || 'AI 请求未完成').replace(/[。.!！\s]+$/u,'')+'。不会自动重试，请检查后重新确认发送。';
    }finally{renderAiRequestStatus();}
  });
}
async function confirmAI() {
  if(model.aiRequest?.status==='running'){renderAiRequestStatus();return;}
  const range=getRange();const p=await api('summary.preview',range);model.preview=p;renderInspector();
  if(!model.state.credentials.ai || !model.state.settings.endpoint || !model.state.settings.model){showSettings();toast('请先配置 AI 服务地址、模型和 Key。',true);return;}
  if(!p.messageCount)throw new Error('选定时段没有可发送的消息。');
  let agreed=false;const send=button('确认发送并生成',()=>{if(!agreed)throw new Error('请先确认发送范围。');if(model.aiRequest?.status==='running')return;send.disabled=true;startAiSummary(range);},'primary',{id:'confirm-ai-send',disabled:true});
  modal('确认发送至 AI 服务',node('div',{},node('p',{class:'form-description'},'这次操作会把选定消息的文本、成员显示名、时间与引用标记发送到你配置的服务。服务可能收费，且适用该服务的数据处理政策。'),node('div',{class:'preview-blocks'},`服务：${model.state.settings.endpoint}\n模型：${model.state.settings.model}\n群聊：${groupName(range.groupId)}\n时段：${fmt(range.start,true)} — ${fmt(range.end,true)}\n消息：${p.messageCount} 条；分段：${p.chunkCount} 个`),p.warning?node('div',{class:'warning'},noteText(p.warning)):null,node('details',{},node('summary',{},`展开前 ${(p.messages||[]).length} 条消息预览`),node('div',{class:'preview-blocks'},(p.messages||[]).map(m=>`${fmt(m.time,true)} ${m.senderName}\n${m.text}`).join('\n\n'))),node('div',{class:'form-section'},check('我确认发送以上时段的消息，并主动调用此 AI 服务',false,v=>{agreed=v;send.disabled=!v || model.aiRequest?.status==='running';},{id:'ai-consent'}))),[send]);
}

async function loadBookmarks() {model.bookmarks=await api('bookmark.list',{query:model.bookmarkQuery});renderBookmarks();renderInspector();}
function changeBookmarkSelection(ids,enabled) {
  const next=new Set(model.bookmarkSelected);
  ids.forEach(id=>{if(enabled)next.add(String(id));else next.delete(String(id));});
  if(next.size>100){toast('一次最多导出 100 条收藏，请缩小选择范围。',true);updateBookmarkSelection();return;}
  model.bookmarkSelected=next;updateBookmarkSelection();
}
function updateBookmarkSelection() {
  for(const box of document.querySelectorAll('.bookmark-select')){box.checked=model.bookmarkSelected.has(box.dataset.bookmarkId);box.closest('.bookmark-card')?.classList.toggle('chosen',box.checked);}
  const total=model.bookmarkSelected.size,visible=model.bookmarks.map(bookmark=>String(bookmark.id));
  const all=$('bookmark-select-all');if(all){const count=visible.filter(id=>model.bookmarkSelected.has(id)).length;all.checked=visible.length>0 && count===visible.length;all.indeterminate=count>0 && count<visible.length;all.disabled=!visible.length;}
  if($('bookmark-selected-count'))$('bookmark-selected-count').textContent=`已选择 ${total} 条收藏`;
  if($('export-bookmarks-notion'))$('export-bookmarks-notion').disabled=total===0;
  if($('clear-bookmark-selection'))$('clear-bookmark-selection').disabled=total===0;
}
function renderBookmarks() {
  let searchTimer;
  const search=node('input',{type:'search',id:'bookmark-search',placeholder:'搜索收藏文本、备注或标签…','aria-label':'搜索收藏',value:model.bookmarkQuery,oninput:e=>{model.bookmarkQuery=e.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(()=>void run('search-bookmarks',async()=>{model.bookmarks=await api('bookmark.list',{query:model.bookmarkQuery});renderBookmarkList();}),300);}});
  const selection=node('div',{class:'bookmark-selection-toolbar'},check('选择当前结果',false,enabled=>changeBookmarkSelection(model.bookmarks.map(bookmark=>bookmark.id),enabled),{id:'bookmark-select-all'}),node('span',{id:'bookmark-selected-count',class:'caption'}),button('清空选择',()=>{model.bookmarkSelected.clear();updateBookmarkSelection();},'text small',{id:'clear-bookmark-selection'}),button('导出所选到 Notion',()=>chooseBookmarkNotionTarget([...model.bookmarkSelected]),'primary small',{id:'export-bookmarks-notion',disabled:!model.bookmarkSelected.size}));
  $('workspace-content').replaceChildren(node('div',{class:'view-toolbar bookmark-toolbar'},search,button('导出 Markdown',()=>exportBookmarks('md'),'small',{id:'export-bookmarks-md'}),button('JSON',()=>exportBookmarks('json'),'small')),selection,node('div',{id:'bookmark-list',class:'content-scroll'}));renderBookmarkList();
}
function renderBookmarkList() {
  const host=$('bookmark-list');if(!host)return;
  if(!model.bookmarks.length){host.replaceChildren(emptyState('让好内容，有处可寻',model.bookmarkQuery?'没有匹配的收藏，试试另一个关键词。':'在阅读中勾选消息，添加备注和标签，即可把有价值的片段留在这里。',[button('去阅读',()=>setView('read'),'soft')]));updateBookmarkSelection();return;}
  host.replaceChildren(...model.bookmarks.map(b=>node('article',{class:'bookmark-card','data-bookmark-id':b.id},node('div',{class:'card-meta'},node('input',{type:'checkbox',class:'bookmark-select','data-bookmark-id':b.id,'aria-label':`选择收藏：${(b.note || b.messages?.[0]?.text || groupName(b.groupId)).slice(0,40)}`,checked:model.bookmarkSelected.has(String(b.id)),onchange:event=>changeBookmarkSelection([b.id],event.target.checked)}),node('span',{class:'card-group'},groupName(b.groupId)),node('span',{},`${b.messageIds?.length || b.messages?.length || 0} 条消息`),node('span',{},fmt(b.createdAt,true))),...(b.messages||[]).map(m=>node('div',{class:'bookmark-message'},node('div',{class:'message-top'},node('span',{class:'sender-name'},m.senderName),node('span',{class:'message-time'},fmt(m.time,true))),renderMessageContent(m),button('回到原文 ↗',()=>jumpToMessage(m),'text small'))),b.note?node('div',{class:'bookmark-note'},b.note):null,node('div',{class:'tag-row'},(b.tags||[]).map(t=>node('span',{class:'tag'},`# ${t}`))),node('div',{class:'card-actions'},button('导出到 Notion',()=>chooseBookmarkNotionTarget([b.id]),'text small',{'data-action':'notion-export'}),button('编辑备注',()=>editBookmark(b),'text small'),button('移除收藏',()=>confirmRemoveBookmark(b),'text small')))));
  updateBookmarkSelection();
}
function editBookmark(b) {
  const note=node('textarea',{id:'edit-bookmark-note',value:b.note||'',maxlength:10000});const tags=node('input',{id:'edit-bookmark-tags',value:(b.tags||[]).join(', '),maxlength:600});
  modal('整理这条收藏',node('div',{},field('我的备注',note),field('标签 · 用逗号分隔',tags)),[button('保存修改',async()=>{await api('bookmark.add',{groupId:b.groupId,messageIds:b.messageIds,note:note.value.trim(),tags:tags.value.split(/[,，]/).map(t=>t.trim()).filter(Boolean)});closeModal();await refreshState();await loadBookmarks();toast('收藏已更新。');},'primary')]);
}
function confirmRemoveBookmark(b) {modal('移除这条收藏？',node('p',{class:'form-description'},'这会删除本机收藏及其备注。原始聊天记录仍然保留。'),[button('移除收藏',async()=>{await api('bookmark.remove',{id:b.id});model.bookmarkSelected.delete(String(b.id));closeModal();await refreshState();await loadBookmarks();toast('已移除收藏。');},'danger')]);}
async function exportBookmarks(format) {const result=await api('export.bookmarks',{query:model.bookmarkQuery,format});if(!result?.canceled&&!result?.cancelled)toast('收藏导出完成。文件包含原文、备注和标签，请妥善保管。');}
function renderSummaries() {
  const host=$('workspace-content');
  if(!model.summaries.length){host.replaceChildren(emptyState('给一段讨论，留一份回顾','在右侧选择群聊的起止时段，先检查覆盖情况，再生成本地摘录或调用自己的 AI 服务。',[button('打开摘要工具',()=>{$('app').classList.add('show-inspector');$('summary-start')?.focus();},'soft')]));return;}
  const cards=model.summaries.slice().sort((a,b)=>b.createdAt-a.createdAt).map(s=>node('button',
    {class:'summary-list-card','data-summary-id':s.id,onclick:()=>{model.summary=s;model.groupId=s.groupId;model.preview=null;renderSidebar();renderHeader();renderSummary();renderInspector();}},
    node('div',{class:'card-meta'},node('span',{class:'card-group'},groupName(s.groupId)),node('span',{class:'live-badge'},s.mode==='local'?'本地摘录':'AI 摘要'),node('span',{},fmt(s.createdAt,true))),
    node('h3',{},s.title),node('p',{class:'summary-excerpt'},s.body),
    node('div',{class:'card-actions'},node('span',{class:'caption'},`${s.refs?.length || 0} 处原文引用　↗`))
  ));
  host.replaceChildren(node('div',{class:'view-toolbar'},node('span',{class:'caption'},`${model.summaries.length} 份已保存摘要 · 点击查看引用与导出`)),node('div',{class:'content-scroll'},cards));
}
function summaryText(body, refs) {const fragment=document.createDocumentFragment();const regex=/\[(M\d+)\]/g;let previous=0;for(const match of String(body||'').matchAll(regex)){fragment.append(document.createTextNode(String(body).slice(previous,match.index)));const ref=refs.find(r=>r.label===match[1]) || refs[Number(match[1].slice(1))-1];if(ref)fragment.append(button(`[${match[1]}]`,()=>jumpToMessage(ref),'citation',{'aria-label':`查看原文引用 ${match[1]}`}));else fragment.append(document.createTextNode(match[0]));previous=match.index+match[0].length;}fragment.append(document.createTextNode(String(body||'').slice(previous)));return fragment;}
function renderSummary() {
  const s=model.summary;if(!s)return renderSummaries();const refs=s.refs || [];
  const doc=node('article',{class:'summary-document'},node('div',{class:'document-overline'},button('← 所有摘要',()=>{model.summary=null;renderHeader();renderSummaries();renderInspector();},'text small'),node('span',{class:'live-badge'},s.mode==='local'?'本地摘录 · 无联网':'AI 摘要 · 请核对原文')),node('h2',{class:'document-title'},s.title),node('div',{class:'document-meta'},`${groupName(s.groupId)}\n${fmt(s.start,true)} — ${fmt(s.end,true)}（结束不含）\n生成于 ${fmt(s.createdAt,true)} · ${refs.length} 条原文引用`),s.warning?node('div',{class:'warning'},noteText(s.warning)):null,node('div',{class:'summary-body'},summaryText(s.body,refs)),node('section',{class:'reference-list'},node('h3',{},'回到原始对话'),...refs.map((r,i)=>node('button',{class:'reference-item',onclick:()=>void run('jump-reference',()=>jumpToMessage(r))},node('span',{class:'reference-number'},r.label || `M${i+1}`),node('div',{class:'reference-copy'},node('p',{},r.text || '查看消息'),node('small',{},`${fmt(r.time,true)}　查看原文 ↗`))))));
  $('workspace-content').replaceChildren(node('div',{class:'view-toolbar'},node('span',{class:'caption'},'摘要与引用已保存到本机'),button('导出 Markdown',async()=>{const result=await api('summary.export',{summaryId:s.id});if(!result?.canceled&&!result?.cancelled)toast('摘要与原文引用已导出。');},'small',{id:'export-summary'})),node('div',{class:'content-scroll'},doc));
}
function notionPanel() {
  const card=node('section',{class:'tool-card'},node('div',{class:'tool-card-heading'},node('span',{class:'tool-card-symbol'},'↗'),'输出到 Notion'),node('p',{},'将这份摘要和原文引用保存为目标页面的子页面。导出前可预览内容。'));
  if(!model.state.credentials.notion){card.append(button('配置 Notion 连接',showSettings,'full'));return card;}
  card.append(button('读取已授权页面',async()=>{model.targets=await api('notion.targets');if(!model.targets.some(t=>t.id===model.targetId))model.targetId=model.targets[0]?.id||'';renderInspector();if(!model.targets.length)toast('没有可用页面。请在 Notion 中将目标页面共享给你的 integration。');},'full',{id:'notion-load-targets'}));
  if(model.targets.length){const select=node('select',{id:'notion-target',class:'notion-target','aria-label':'Notion 目标页面',onchange:e=>model.targetId=e.target.value},...model.targets.map(t=>node('option',{value:t.id,selected:t.id===model.targetId},t.title || t.id)));card.append(select,button('预览导出内容',previewNotion,'primary full',{id:'notion-preview'}));}
  card.append(node('p',{class:'caption'},'只有确认导出时才会写入 Notion。相同来源、目标与编辑内容会复用记录；改稿将新建页面。'));return card;
}
async function chooseBookmarkNotionTarget(ids) {
  const bookmarkIds=[...new Set(ids.map(String))].sort();
  if(!bookmarkIds.length)throw new Error('请先选择至少一条收藏。');
  if(bookmarkIds.length>100)throw new Error('一次最多导出 100 条收藏。');
  if(!model.state.credentials.notion){showSettings();toast('请先配置 Notion 连接，当前收藏选择会保留。',true);return;}
  let targetId=model.targetId;
  const source=Object.freeze({bookmarkIds:Object.freeze(bookmarkIds)});
  const select=node('select',{id:'notion-target',class:'notion-target','aria-label':'Notion 目标页面',onchange:event=>{targetId=event.target.value;model.targetId=targetId;preview.disabled=!targetId;}});
  const preview=button('编辑导出预览',()=>openNotionEditor(source,targetId),'primary',{id:'notion-preview',disabled:!targetId});
  const fillTargets=()=>{
    if(!model.targets.some(target=>target.id===targetId))targetId=model.targets[0]?.id || '';
    select.replaceChildren(...model.targets.map(target=>node('option',{value:target.id,selected:target.id===targetId},target.title || target.id)));
    if(!model.targets.length)select.append(node('option',{value:''},'请先读取已授权页面'));
    select.value=targetId;model.targetId=targetId;preview.disabled=!targetId;
  };
  const body=node('div',{},node('p',{class:'form-description'},`已选择 ${bookmarkIds.length} 条收藏。选择目标页面后，可编辑即将导出的标题和正文；原收藏不会改变。`),field('Notion 目标页面',select),button('读取已授权页面',async()=>{
    const targets=await api('notion.targets');if(!body.isConnected || !$('modal').open)return;
    model.targets=targets || [];fillTargets();if(!model.targets.length)throw new Error('没有可用页面。请先在 Notion 中将目标页面共享给你的 integration。');
  },'full',{id:'notion-load-targets'}));
  fillTargets();modal('将收藏导出到 Notion',body,[preview]);
}
async function previewNotion() {
  if(!model.summary || !model.targetId)throw new Error('请选择一个 Notion 目标页面。');
  return openNotionEditor(Object.freeze({summaryId:model.summary.id}),model.targetId);
}
async function openNotionEditor(source,targetId) {
  if(!targetId)throw new Error('请选择一个 Notion 目标页面。');
  const dialog=$('modal'),owner=dialog.firstChild,wasOpen=dialog.open;
  const preview=await api('notion.preview',{...source,targetId});
  if(owner!==dialog.firstChild || wasOpen!==dialog.open)return;
  if(!preview.sourceHash)throw new Error('导出预览缺少内容校验，请重新打开预览。');
  const targetTitle=model.targets.find(target=>target.id===targetId)?.title || targetId;
  const draft={title:String(preview.title || ''),body:String(preview.body || ''),includeReferences:preview.includeReferences!==false};
  const titleLimit=Number(preview.limits?.titleChars)||180,bodyLimit=Number(preview.limits?.bodyChars)||200000;
  let agreed=false,saving=false;
  const title=node('input',{id:'notion-edit-title',value:draft.title,maxlength:titleLimit,oninput:event=>{draft.title=event.target.value;updateSend();}});
  const body=node('textarea',{id:'notion-edit-body',class:'notion-body-editor',value:draft.body,maxlength:bodyLimit,rows:12,oninput:event=>{draft.body=event.target.value;updateCount();}});
  const count=node('small',{id:'notion-edit-count',class:'caption'});
  const referencePreview=node('details',{id:'notion-reference-preview',hidden:!draft.includeReferences},node('summary',{},'查看将附加的引用原文与本地定位'),node('div',{class:'preview-blocks'},preview.referencesText || '没有可附加的原文引用。'));
  const include=check('引用原文与本地定位',draft.includeReferences,enabled=>{draft.includeReferences=enabled;referencePreview.hidden=!enabled;},{id:'notion-include-references'});
  const consent=check(`我确认将以上编辑内容导出到“${targetTitle}”`,false,enabled=>{agreed=enabled;updateSend();},{id:'notion-consent'});
  const status=node('p',{id:'notion-submit-status',class:'caption',role:'status','aria-live':'polite',hidden:true});
  const send=button('确认导出到 Notion',async()=>{
    if(saving)return;
    if(!agreed || !draft.title.trim())throw new Error('请填写标题并确认导出目标。');
    saving=true;updateSend();status.hidden=false;status.textContent='等待发送确认或 Notion 返回，请稍候…';
    const fields=[title,body,include.querySelector('input'),consent.querySelector('input')];fields.forEach(field=>field.disabled=true);
    const close=$('modal-close');if(close)close.disabled=true;
    // Capture exactly what is displayed. Toggling references never rebuilds body.
    const payload={...source,targetId,sourceHash:preview.sourceHash,draft:{title:draft.title.trim(),body:draft.body,includeReferences:draft.includeReferences},confirmed:true};
    try{
      const result=await api('notion.export',payload);closeModal();
      const content=node('div',{},node('p',{class:'success-note'},`导出状态：${result.status || '已处理'}。目标：${targetTitle}。`),node('p',{class:'form-description'},'相同编辑内容再次导出会复用记录；修改后的内容会作为新的导出版本，不会改动原收藏或摘要。'));
      modal('Notion 导出结果',content,[result.url?button('打开 Notion 页面',()=>api('external.open',{url:result.url})):null,button('完成',closeModal,'primary')]);
    }catch(error){status.textContent='导出未完成，编辑内容已保留。不会自动重试。';reportError(error);}
    finally{saving=false;fields.forEach(field=>field.disabled=false);if(close)close.disabled=false;updateSend();}
  },'primary',{id:'notion-confirm-export',disabled:true});
  function updateSend(){send.disabled=saving || !agreed || !draft.title.trim();send.textContent=saving?'正在导出…':'确认导出到 Notion';}
  function updateCount(){count.textContent=`正文 ${draft.body.length.toLocaleString()} / ${bodyLimit.toLocaleString()} 字符`;}
  updateCount();
  modal('编辑 Notion 导出预览',node('div',{},node('p',{id:'notion-export-target',class:'form-description'},`目标：${targetTitle}\n${preview.resumeNotice?'将继续此目标下未完成的原页面。':'将以以下标题新建子页面，编辑仅用于本次导出。'}`),preview.contextText?node('div',{id:'notion-export-context',class:'notion-export-context'},preview.contextText):null,preview.resumeNotice?node('p',{id:'notion-resume-notice',class:'warning',role:'status'},preview.resumeNotice):null,field('页面标题',title),field('导出正文',body),count,node('p',{class:'caption'},'页面会附加导出标识，以便识别重复导出。'),node('div',{class:'notion-reference-option'},include,node('p',{class:'caption'},'取消勾选仅移除附加的原文与定位，保留你编辑的正文。'),referencePreview),node('div',{class:'form-section'},consent),status),[send],{onClose:()=>{if(!saving)closeModal();}});
}

function aiProviderName(id) {
  return ({openai:'OpenAI',deepseek:'DeepSeek',kimi:'Kimi',zhipu:'智谱',minimax:'MiniMax',hunyuan:'混元',qwen:'千问',xiaomi:'小米',custom:'自定义'})[id] || '自定义';
}
function aiEndpointIdentity(value) {
  // This is only a form hint. The host independently validates address and key scope.
  const endpoint=String(value || '').trim();
  if(!endpoint || endpoint.length>2048 || /[\u0000-\u0020\u007f\\]/.test(endpoint))return '';
  try{
    const url=new URL(endpoint);
    if(url.username || url.password || url.search || url.hash)return '';
    if(url.protocol!=='https:'){
      const authority=endpoint.match(/^http:\/\/([^/]+)/i)?.[1];
      if(url.protocol!=='http:' || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(authority || ''))return '';
    }
    const path=url.pathname.replace(/\/+$/,'');
    if(/\/(responses|messages)$/.test(path) || (/\/completions$/.test(path) && !path.endsWith('/chat/completions')))return '';
    url.pathname=!path?'/v1/chat/completions':path.endsWith('/chat/completions')?path:path+'/chat/completions';
    return url.href;
  }catch{return '';}
}
function showSettings(restoredDraft) {
  const settings=model.state.settings,creds=model.state.credentials,accountId=model.state.account?.id;
  // Draft credentials stay in this dialog closure and never enter the shared model.
  const draft=restoredDraft?.kind==='settings-draft' && restoredDraft.accountId===accountId?restoredDraft:{kind:'settings-draft',accountId,notionToken:'',deleteSecrets:false,resetUnreadable:false};
  const notionToken=node('input',{id:'notion-token',type:'password',value:draft.notionToken,placeholder:creds.notion?'已保存 · 留空保持不变':'Notion integration token',autocomplete:'new-password',oninput:event=>draft.notionToken=event.target.value});
  const aiDetails=node('div',{class:'ai-settings-summary'},node('div',{class:'ai-settings-summary-title'},node('h3',{},'AI 模型'),node('span',{class:'live-badge'},creds.ai?'已配置 Key':'未配置 Key')),
    node('p',{id:'ai-current-model'},settings.model?aiProviderName(settings.aiProviderId || 'custom')+' · '+settings.model:'添加你自己的模型配置'),
    settings.endpoint?node('p',{id:'ai-current-endpoint',class:'ai-settings-address'},settings.endpoint):null,
    button(settings.endpoint || settings.model?'编辑自定义模型':'添加自定义模型',()=>showAiConfiguration(draft),'full',{id:'configure-ai'}));
  const body=node('div',{},node('p',{class:'form-description'},'凭据由 Windows 保护并绑定当前本地工作区。已保存的 Key 不会回显。AI 模型与 Notion 连接分别保存。'),aiDetails,
    node('div',{class:'form-section'},node('h3',{},'Notion 连接'),node('p',{class:'form-description'},'使用你自己的 Notion integration，并在 Notion 页面中授予它访问权限。保存设置不会写入任何页面。'),field('Integration token',notionToken,creds.notion?'已保存的 Token 留空保持不变。':null)),
    node('div',{class:'form-section'},check('清除当前账号保存的 AI 与 Notion 凭据',draft.deleteSecrets,value=>draft.deleteSecrets=value,{id:'delete-secrets'})),
    node('div',{class:'source-note'},'没有后台定时发送。只有点击并确认 AI 总结或 Notion 导出后，选定内容才会发送到对应服务。'),
    accountKind()==='weibo'?node('div',{class:'form-section'},button('退出微博网页登录',async()=>{await api('logout');draft.notionToken='';notionToken.value='';closeModal();await refreshState();renderInspector();toast('已退出微博会话。本机保存的记录仍然保留。');},'danger')):null);
  if(model.state.credentialError)body.append(node('div',{class:'warning'},model.state.credentialError),check('重新初始化无法解密的旧凭据（需要重新登录微博）',draft.resetUnreadable,value=>draft.resetUnreadable=value));
  modal('设置与连接',body,[button('保存设置',async()=>{
    model.state=await api('settings.save',{notionToken:notionToken.value,deleteSecrets:draft.deleteSecrets,resetUnreadable:draft.resetUnreadable});
    draft.notionToken='';notionToken.value='';closeModal();renderSidebar();renderHeader();renderInspector();toast('设置已保存在本机。');
  },'primary',{id:'save-settings'})],{onClose:()=>{draft.notionToken='';notionToken.value='';closeModal();}});
}
async function showAiConfiguration(settingsDraft) {
  const dialog=$('modal'),owner=dialog.firstChild,epoch=model.accountEpoch,accountId=model.state.account?.id;
  const providers=await api('ai.providers');
  if(owner!==dialog.firstChild || !dialog.open || epoch!==model.accountEpoch)return;
  if(!Array.isArray(providers) || !providers.some(item=>item.id==='openai') || !providers.some(item=>item.id==='custom'))throw new Error('模型厂商目录不可用，请重新打开设置。');
  const settings={...model.state.settings},hasSavedKey=!!model.state.credentials.ai;
  const savedProvider=settings.aiProviderId || 'custom',savedEndpoint=aiEndpointIdentity(settings.endpoint);
  const hasConfig=!!(settings.endpoint || settings.model || hasSavedKey);
  let providerId=hasConfig?savedProvider:'openai',customEndpoint=String(settings.endpoint || ''),saving=false;
  if(!providers.some(item=>item.id===providerId))providerId='custom';
  const providerSelect=node('select',{id:'ai-provider','aria-label':'模型厂商'},...providers.flatMap(provider=>[provider.custom?node('option',{value:'',disabled:true},'──────────'):null,node('option',{value:provider.id,selected:provider.id===providerId},provider.name)]));
  const aiKey=node('input',{id:'ai-key',type:'password',autocomplete:'new-password',placeholder:'输入此服务的 API Key',maxlength:8192});
  const modelInput=node('input',{id:'ai-model',value:settings.model || '',placeholder:'填写服务商支持的 API 模型名称',autocomplete:'off',maxlength:200});
  const endpoint=node('input',{id:'ai-endpoint',type:'url',value:customEndpoint,placeholder:'https://你的服务地址/v1',autocomplete:'off',maxlength:2048});
  const keyHint=node('small',{id:'ai-key-guidance',class:'inline-help'});
  const eye=node('span',{class:'key-eye','aria-hidden':'true'});
  const toggle=node('button',{id:'toggle-ai-key',type:'button',class:'ai-key-toggle',disabled:true,'aria-label':'显示新输入的 API Key','aria-pressed':'false',title:'显示新输入的 API Key',onclick:()=>{
    const reveal=aiKey.type==='password';aiKey.type=reveal?'text':'password';toggle.setAttribute('aria-pressed',String(reveal));toggle.setAttribute('aria-label',reveal?'隐藏 API Key':'显示新输入的 API Key');toggle.title=reveal?'隐藏 API Key':'显示新输入的 API Key';eye.classList.toggle('is-visible',reveal);
  }},eye);
  const address=node('p',{id:'ai-provider-endpoint',class:'ai-provider-address'});
  const notice=node('p',{id:'ai-provider-notice',class:'ai-provider-notice'});
  const customField=field('API 服务地址',endpoint,'填写兼容 Chat Completions 的基础地址或完整 /chat/completions 地址。仅明确的本机地址可使用 HTTP；不支持原生 /responses 或 /messages 地址。');
  customField.classList.add('ai-custom-endpoint');
  const selectedProvider=()=>providers.find(item=>item.id===providerId);
  const targetEndpoint=()=>selectedProvider()?.custom?endpoint.value.trim():String(selectedProvider()?.endpoint || '');
  const mayKeep=()=>hasSavedKey && providerId===savedProvider && !!savedEndpoint && aiEndpointIdentity(targetEndpoint())===savedEndpoint;
  function hideTypedKey(){aiKey.type='password';toggle.setAttribute('aria-pressed','false');toggle.setAttribute('aria-label','显示新输入的 API Key');toggle.title='显示新输入的 API Key';eye.classList.remove('is-visible');}
  function clearTypedKey(){aiKey.value='';hideTypedKey();}
  function updateSave(){
    const keep=mayKeep(),modelValue=modelInput.value.trim();
    aiKey.placeholder=keep?'已保存 · 留空保持不变':'输入此服务的 API Key';
    keyHint.textContent=keep?'已保存的 Key 不会回显。留空会保留当前服务的 Key。':'请填写当前服务的 Key。切换厂商或地址后，不会沿用原来的 Key。';
    toggle.disabled=saving || !aiKey.value;
    save.disabled=saving || !modelValue || /[\r\n\u0000]/.test(modelValue) || !aiEndpointIdentity(targetEndpoint()) || (!aiKey.value.trim() && !keep);
    save.textContent=saving?'正在保存…':'保存';
  }
  function updateProvider(){
    const provider=selectedProvider(),custom=!!provider?.custom;
    customField.hidden=!custom;address.hidden=custom;address.textContent=custom?'':'请求地址：'+String(provider?.endpoint || '');
    notice.textContent=String(provider?.notice || '');notice.hidden=!notice.textContent;
    updateSave();
  }
  function returnToSettings(){
    if(saving)return;
    clearTypedKey();
    if(epoch===model.accountEpoch && accountId===model.state.account?.id)showSettings(settingsDraft);else{settingsDraft.notionToken='';closeModal();}
  }
  const save=button('保存',async()=>{
    if(saving)return;
    updateSave();if(save.disabled)return;
    const payload={providerId,endpoint:targetEndpoint(),model:modelInput.value.trim(),aiKey:aiKey.value.trim(),keyAction:aiKey.value.trim()?'replace':'keep'};
    saving=true;updateSave();
    const controls=[providerSelect,aiKey,modelInput,endpoint,toggle,$('modal-close'),dialog.querySelector('.modal-head button')].filter(Boolean);controls.forEach(control=>control.disabled=true);
    try{
      model.state=await api('settings.ai.save',payload);clearTypedKey();saving=false;renderInspector();showSettings(settingsDraft);toast('AI 模型配置已保存在本机，尚未发送请求。');
    }catch(error){reportError(error);}
    finally{saving=false;controls.forEach(control=>control.disabled=false);updateSave();}
  },'primary',{id:'save-ai-config',disabled:true});
  providerSelect.addEventListener('change',()=>{if(selectedProvider()?.custom)customEndpoint=endpoint.value;providerId=providerSelect.value;endpoint.value=customEndpoint;clearTypedKey();updateProvider();});
  endpoint.addEventListener('input',()=>{customEndpoint=endpoint.value;clearTypedKey();updateSave();});
  aiKey.addEventListener('input',()=>{if(!aiKey.value)hideTypedKey();updateSave();});
  modelInput.addEventListener('input',updateSave);
  const body=node('div',{class:'ai-config-fields'},field('模型厂商',providerSelect),address,notice,customField,
    node('div',{class:'field'},node('label',{for:'ai-key'},'API Key'),node('div',{class:'ai-key-field'},aiKey,toggle),keyHint),
    field('模型名称',modelInput,'使用该服务支持的 API 模型名称，可自由填写。'));
  modal('添加自定义模型',body,[save],{closeLabel:'返回设置',onClose:returnToSettings});
  dialog.classList.add('ai-config-dialog');
  dialog.querySelector('.modal-footer').prepend(node('p',{class:'ai-config-footnote'},'自定义配置遵循服务商的模型规则，Token 消耗由服务商计费。保存不会测试连接或调用模型。'));
  updateProvider();
}

function loginDialogVisible() {return $('modal').open && $('modal').dataset.context==='login';}
function loginText(id,value) {const element=$(id);if(element && element.textContent!==value)element.textContent=value;}
function loginStageLabel(stage) {
  return ({opening:'正在打开官方登录页',ready:'等待完成官方登录',identity:'正在确认微博身份',groups:'正在读取群聊列表',verify:'正在复核登录身份',saving:'正在保存本机账号',completed:'群聊读取完成',error:'读取未完成',canceled:'已取消读取'})[stage] || '正在读取群聊';
}
function renderLoginStatus() {
  if(!loginDialogVisible())return;
  const active=loginFlow.running || loginFlow.opening;
  const status=$('login-status');
  status.setAttribute('aria-busy',String(active));
  status.classList.toggle('is-running',active);status.classList.toggle('has-error',!!loginFlow.error);
  loginText('login-stage',loginFlow.canceling?'正在取消读取…':loginStageLabel(loginFlow.stage));
  loginText('login-detail',loginFlow.message);
  const errorWasHidden=$('login-error').hidden;
  loginText('login-error',loginFlow.error);
  $('login-error').hidden=!loginFlow.error;
  if(loginFlow.error && errorWasHidden)$('login-error').scrollIntoView({block:'nearest'});
  const elapsed=active&&loginFlow.startedAt?Math.max(0,Math.floor((Date.now()-loginFlow.startedAt)/1000)):0;
  loginText('login-elapsed',active?`已等待 ${elapsed} 秒${loginFlow.running?` · 本次最长约 ${Math.ceil(loginFlow.timeoutMs/1000)} 秒`:''}`:'');
  $('login-spinner').hidden=!active;
  const complete=$('complete-login');complete.disabled=active || loginFlow.canceling;
  complete.textContent=loginFlow.running?'正在读取群聊…':loginFlow.error||loginFlow.stage==='canceled'?'重试读取群聊':'我已登录，读取群聊';
  const open=$('open-official-login');open.disabled=active || loginFlow.canceling;open.textContent=loginFlow.opening?'正在打开…':'打开官方登录页';
  const cancel=$('cancel-login-read');cancel.hidden=!loginFlow.running;cancel.disabled=loginFlow.canceling;
  cancel.textContent=loginFlow.canceling?'正在取消…':'取消读取';
  $('modal-close').textContent=loginFlow.running?'取消读取并关闭':'关闭';
}
function stopLoginPolling() {clearTimeout(loginFlow.pollTimer);clearInterval(loginFlow.tickTimer);loginFlow.pollTimer=null;loginFlow.tickTimer=null;}
function startLoginPolling(generation) {
  stopLoginPolling();
  const poll=async()=>{
    if(generation!==loginFlow.generation || !loginFlow.running)return;
    try{
      const status=await api('login.status');
      if(generation!==loginFlow.generation || !loginFlow.running)return;
      // The host supplies only sanitized stage text, never credentials or responses.
      if(status?.stage){loginFlow.stage=String(status.stage);if(status.message)loginFlow.message=String(status.message);}
      if(status?.startedAt && Number.isFinite(Number(status.startedAt)))loginFlow.startedAt=Number(status.startedAt);
      if(status?.timeoutMs && Number.isFinite(Number(status.timeoutMs)))loginFlow.timeoutMs=Number(status.timeoutMs);
      if(status?.error)loginFlow.error=String(status.error);
    }catch(error){
      if(generation===loginFlow.generation && loginFlow.running){
        loginFlow.error=`暂时无法读取进度：${error?.message || '桌面连接未回应'}。主请求仍在等待，可取消读取后重试。`;
      }
    }
    renderLoginStatus();
    if(generation===loginFlow.generation && loginFlow.running)loginFlow.pollTimer=setTimeout(poll,700);
  };
  loginFlow.pollTimer=setTimeout(poll,250);
  loginFlow.tickTimer=setInterval(()=>{
    if(generation!==loginFlow.generation)return;
    renderLoginStatus();
    if(loginFlow.running && !loginFlow.watchdogFired && Date.now()-loginFlow.startedAt>loginFlow.timeoutMs+5000){
      loginFlow.watchdogFired=true;
      loginFlow.error='读取已超过时限，正在请求停止。本次登录会话会保留；确认停止后可以重试。';
      void cancelLoginRead(false);
    }
  },500);
}
async function openLoginWindow() {
  if(loginFlow.running || loginFlow.opening)return;
  loginFlow.opening=true;loginFlow.stage='opening';loginFlow.message='即将在独立窗口打开微博官方页面，请在该窗口自行完成登录。';loginFlow.error='';loginFlow.startedAt=Date.now();
  renderLoginStatus();
  try{await api('login.open');loginFlow.stage='ready';loginFlow.message='官方窗口已打开。完成登录及验证后，回到这里读取群聊。';}
  catch(error){loginFlow.stage='error';loginFlow.error=error?.message || '官方窗口未能打开，请重试。';loginFlow.message='当前账号与本机数据未改变。请检查网络后重试打开官方页面。';}
  finally{loginFlow.opening=false;renderLoginStatus();}
}
async function completeLogin() {
  if(loginFlow.running || loginFlow.opening)return;
  const generation=++loginFlow.generation;
  loginFlow.running=true;loginFlow.canceling=false;loginFlow.closeWhenDone=false;loginFlow.stage='identity';loginFlow.message='正在读取官方会话中的账号身份，随后获取你有权访问的群聊。';loginFlow.error='';loginFlow.startedAt=Date.now();loginFlow.timeoutMs=60000;loginFlow.watchdogFired=false;
  renderLoginStatus();
  startLoginPolling(generation);
  try{
    const activated=await activateAccount('login.complete');
    if(!activated)throw new Error('已取消读取，官方登录会话保留。');
    if(generation!==loginFlow.generation)return;
    loginFlow.running=false;loginFlow.canceling=false;loginFlow.stage='completed';loginFlow.message='群聊已读取，可以选择保存到本机的群聊。';loginFlow.error='';stopLoginPolling();
    closeModal();await showGroups();
  }catch(error){
    if(generation!==loginFlow.generation)return;
    const canceled=loginFlow.canceling || loginFlow.stage==='canceled' || /取消/.test(error?.message || '');
    loginFlow.running=false;loginFlow.canceling=false;loginFlow.stage=canceled?'canceled':'error';
    loginFlow.message=canceled?'已停止读取。官方登录会话和当前本机账号保持不变，可以直接重试。':'没有完成账号切换。请先在官方窗口确认已登录、已通过验证，再重试读取。';
    loginFlow.error=canceled?'':error?.message || '读取失败，请重试。';
    stopLoginPolling();renderLoginStatus();
    if(loginFlow.closeWhenDone && canceled)closeModal();
  }finally{
    if(generation===loginFlow.generation){stopLoginPolling();renderLoginStatus();}
  }
}
async function cancelLoginRead(closeWhenDone=false) {
  if(!loginFlow.running){if(closeWhenDone)closeModal();return;}
  if(closeWhenDone)loginFlow.closeWhenDone=true;
  if(loginFlow.canceling)return;
  loginFlow.canceling=true;loginFlow.message='正在停止本次群聊读取。此操作不会退出微博，也不会清除登录会话。';renderLoginStatus();
  let timeout;
  try{
    await Promise.race([api('login.cancel'),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('取消请求暂未得到回应，尚不能确认已停止')),10000);})]);
    if(loginFlow.running){loginFlow.message='已提交取消请求，正在等待当前读取停止。登录会话会保留。';renderLoginStatus();}
  }catch(error){
    if(loginFlow.running){loginFlow.canceling=false;loginFlow.closeWhenDone=false;loginFlow.error=error?.message || '取消失败，请重试取消。';renderLoginStatus();}
  }finally{clearTimeout(timeout);}
}
function showLogin() {
  const status=node('section',{id:'login-status',class:'login-progress','aria-live':'polite','aria-atomic':'false','aria-busy':'false'},
    node('div',{class:'login-progress-heading'},node('span',{id:'login-spinner',class:'busy-indicator',hidden:true,'aria-hidden':'true'}),node('strong',{id:'login-stage'}),node('span',{id:'login-elapsed',class:'caption','aria-live':'off'})),
    node('p',{id:'login-detail'}),node('div',{id:'login-error',class:'error-note',role:'alert',hidden:true}),
    button('取消读取',()=>cancelLoginRead(false),'small',{id:'cancel-login-read',hidden:true}));
  const dialog=modal('在微博官方页面登录',node('div',{},
    node('p',{class:'form-description'},'登录在独立的微博官方窗口完成。微阅不会读取或保存你的密码，也不会使用其他应用的登录凭据。'),
    node('div',{class:'login-step'},node('span',{class:'step-number'},'1'),node('p',{},'打开官方登录窗口，在 api.weibo.com/chat 页面自行完成登录及必要的验证。')),
    node('div',{class:'login-step'},node('span',{class:'step-number'},'2'),node('p',{},'登录成功后回到这里，点击“我已登录，读取群聊”。这里会显示身份确认、群列表读取和保存进度。')),
    node('div',{class:'login-step'},node('span',{class:'step-number'},'3'),node('p',{},'选择想保存到本机的群聊，再手动同步消息。读取失败可在本窗口重试，不需要退出登录。')),
    status,node('div',{class:'source-note'},'账号资料和 Cookie 仅在本机处理。请不要将密码、Cookie 或验证码发给他人。')),
    [button('打开官方登录页',openLoginWindow,'soft',{id:'open-official-login'}),button('我已登录，读取群聊',completeLogin,'primary',{id:'complete-login'})],
    {closeLabel:'关闭',onClose:()=>cancelLoginRead(true)});
  dialog.dataset.context='login';renderLoginStatus();
}
async function showGroups() {
  if(!model.state.account)return showLogin();const selected=new Set(model.state.groups.filter(g=>g.selected!==false).map(g=>String(g.id)));
  const body=node('div',{},node('p',{class:'form-description'},accountKind()==='weibo'?'只同步你选择且有权访问的群聊。选择后每 60 秒自动更新，可暂停，也可手动同步最新或更早记录。':'选择在侧栏显示的本地群聊。隐藏群聊不会删除已保存的数据。'),...model.state.groups.map(g=>node('label',{class:'group-choice'},node('input',{type:'checkbox',checked:selected.has(String(g.id)),onchange:e=>{if(e.target.checked)selected.add(String(g.id));else selected.delete(String(g.id));}}),node('span',{class:'group-avatar'},String(g.name||'群').slice(0,1)),node('span',{class:'group-choice-copy'},g.name,node('small',{},g.coverage?.note || (g.coverage?.newest?`最近记录 ${fmt(g.coverage.newest,true)}`:'尚未同步记录'))))));
  if(!model.state.groups.length)body.append(node('div',{class:'warning'},'当前没有群聊可选择。如果已经在微博登录，可重新读取群聊。'));
  modal('选择我的群聊',body,[button('保存选择',async()=>{await flushReading(false);stashReadingDraft();await api('groups.select',{ids:[...selected]});closeModal();await refreshState();if(!selected.has(String(model.groupId)))model.groupId=model.state.groups.find(g=>selected.has(String(g.id)))?.id || null;renderSidebar();renderHeader();await loadReading(true);toast('群聊选择已保存。');},'primary',{id:'save-groups'})]);
}

$('settings-button').addEventListener('click',()=>void run('settings',showSettings));
$('manage-groups').addEventListener('click',()=>void run('groups-dialog',showGroups));
$('modal').addEventListener('cancel',event=>{if(model.modalCloseHandler){event.preventDefault();void run('modal-close',requestModalClose);}});
$('modal').addEventListener('close',()=>scheduleRead());
window.addEventListener('pointerup',()=>{model.pointerScrolling=false;model.pointerReading=null;model.touchY=null;scheduleReadingRefresh();});
window.addEventListener('mouseup',()=>{model.pointerScrolling=false;model.pointerReading=null;scheduleReadingRefresh();});
window.addEventListener('pointercancel',()=>invalidateReadingIntent());
window.addEventListener('blur',()=>{invalidateReadingIntent();void flushReading(false).catch(()=>{});});
window.addEventListener('focus',()=>{scheduleRead();void pollUpdates();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void flushReading(false).catch(()=>{});else scheduleRead();});
window.api?.onBeforeClose?.(()=>{
  if(model.closing)return;model.closing=true;clearInterval(model.pollTimer);
  void (async()=>{try{await flushReading(false);await model.readWrite.catch(()=>{});}catch(error){reportError(error);}finally{await api('window.closeReady').catch(()=>{});}})();
});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='f'&&!$('modal').open){event.preventDefault();($('message-search') || $('bookmark-search'))?.focus();}});
void run('startup',async()=>{await refreshState();await loadReading(true);startUpdatePolling();});
})();

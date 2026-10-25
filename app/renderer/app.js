'use strict';

(() => {

// All account content is rendered as text. Only the isolated preload can call the host.
const $ = (id) => document.getElementById(id);
const reading = window.WeiyueReading;
const links = window.WeiyueLinks;
const emoticons = window.WeiyueEmoticons.create({manifest:window.WeiyueEmoticonManifest,links});
emoticons.installCopyHandler(document);
const filters = window.WeiyueFilters;
const syncDisplay = window.WeiyueSyncStatus;
const appearance = window.WeiyueAppearance;
function applyAppearance(value) {
  // Message colors and application chrome are independent settings.
  window.WeiyueAppearanceSettings.apply($('workspace'),value);
}
function emptyFilters() {return {keyword:'',senderIds:[],start:'',end:'',importantOnly:false};}
const model = {
  state: { accounts: [], groups: [], stats: {}, readPositions: {}, importantMembers: [], settings: {}, credentials: {} },
  view: 'read', groupId: null, messages: [], total: 0, offset: 0, limit: 160,
  members: [], selected: new Set(), inspected: null, bookmarks: [], summaries: [],
  summary: null, summaryDeletion: null, preview: null, targets: [], targetId: '', bookmarkQuery: '', bookmarkSelected: new Set(), aiRequest: null, aiRequestSequence: 0,
  filters: emptyFilters(),
  searchEditor: null, filterReturn: null, readNavigation: null,
  advanced: false, range: todayRange(), busy: 0, readTimer: null, queryVersion: 0,
  pending: new Set(), toastTimer: null, saveNote: '', saveTags: '', accountEpoch: 0, switching: false,
  modalCloseHandler: null, viewport: null, restoring: false, restoreFrame: null,
  renderedReading: null, readBoundary: null, layoutVersion: 0, intentVersion: 0, scrollTop: 0, pointerScrolling: false, touchY: null,
  pointerReading: null, messageDrag: null, readingInput: null, pagingGestureSequence: 0, readingActivity: null, readingCommits: new Map(), pendingReadingRefresh: null, pendingReadingTimer: null,
  messageObserver: null, drafts: new Map(), readWrite: Promise.resolve(), lastReadPayload: '',
  syncStatus: null, syncRevision: null, polling: false, pollTimer: null, refreshRunning: false, manualSync: false, cleanupOperation: null,
  messageSignatures: new Map(), closing: false, enrichmentAttempted: new Set(), enrichmentErrors: new Map(), enriching: false, enrichmentRetryTimer: null
};
const readIntent = reading.createReadIntentGate();
const autoPage = window.WeiyueAutoPage.createAutoPager({
  snapshot: autoPageSnapshot, load: loadNextLocalPage, apply: appendLocalPage,
  onState: () => {updateAutoPageChrome();scheduleReadingRefresh();},
  onError: () => toast(autoPage.status().direction<0?'更早消息加载失败，请再次向上滚动或点击“更早一页”重试。':'后续消息加载失败，请再次向下滚动或点击“更多消息”重试。',true),
  now: () => performance.now()
});
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
const avatarStates=new WeakMap();
const AVATAR_FAILURE_COOLDOWN_MS=60000;
function safeAvatarSource(value,kind,id) {
  // Chromium may canonicalize away userinfo on a registered custom scheme.
  if(typeof value!=='string' || !value.startsWith('app://avatar/') || value.length>4096 || /[\s\\\u0000-\u001f\u007f]/.test(value))return '';
  try{
    const url=new URL(value),parts=url.pathname.split('/').slice(1);
    if(url.protocol!=='app:' || url.hostname!=='avatar' || url.username || url.password || url.port || url.search || url.hash)return '';
    return parts.length===4 && parts.every(Boolean) && parts[1]===kind && String(id??'') && decodeURIComponent(parts[2])===String(id)?url.href:'';
  }catch{return '';}
}
function avatarIdentity(kind,id) {return JSON.stringify([model.accountEpoch,model.state.account?.id,kind,kind==='member'?model.groupId:null,String(id??'')]);}
function updateAvatar(host,{kind,id,name,source}) {
  const owner=avatarIdentity(kind,id),src=safeAvatarSource(source,kind,id);
  let letter=host.querySelector('.avatar-letter');
  if(!letter){letter=node('span',{class:'avatar-letter'});host.append(letter);}
  letter.textContent=Array.from(String(name|| (kind==='group'?'群':'?')))[0];
  host.dataset.avatarId=String(id??'');host.dataset.avatarKind=kind;
  const previous=avatarStates.get(host);
  if(previous?.owner===owner && previous.source===src && (!previous.retryAt || Date.now()<previous.retryAt))return;
  previous?.image?.remove();host.classList.remove('has-image');
  const state={owner,source:src,image:null,retryAt:0};avatarStates.set(host,state);
  if(!src)return;
  const image=node('img',{class:'avatar-image',alt:'',width:kind==='group'?31:33,height:kind==='group'?31:33,loading:'lazy',decoding:'async',referrerpolicy:'no-referrer',draggable:'false'});
  state.image=image;
  const current=()=>avatarStates.get(host)===state && state.image===image;
  image.addEventListener('load',()=>{if(current() && image.naturalWidth>0){image.classList.add('is-loaded');host.classList.add('has-image');}});
  image.addEventListener('error',()=>{if(current()){image.remove();state.image=null;state.retryAt=Date.now()+AVATAR_FAILURE_COOLDOWN_MS;host.classList.remove('has-image');}});
  host.append(image);image.src=src;
}
function avatarNode(className,options) {const host=node('span',{class:className,'aria-hidden':'true'});updateAvatar(host,options);return host;}
function updateMessageAvatar(card,message) {
  const avatar=card.querySelector('.avatar');if(!avatar)return;
  updateAvatar(avatar,{kind:'member',id:message.senderId,name:message.senderName,source:message.senderAvatarSrc});
}
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
  applyAppearance(model.state.settings.appearance);
  window.WeiyueInterfaceTheme.apply(document.body,model.state.settings.interfaceTheme);
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
  renderGroupList(state.groups.filter(g=>g.selected!==false));
  $('manage-groups').disabled = !state.account;
}
function renderGroupList(groups) {
  const host=$('group-list'),owner=avatarIdentity('groups','');
  const existing=host.dataset.avatarOwner===owner?new Map([...host.querySelectorAll('.group-item')].map(item=>[item.dataset.groupId,item])):new Map();
  const children=groups.map(group=>{
    const id=String(group.id),active=id===String(model.groupId);
    let item=existing.get(id);
    if(!item){
      item=node('button',{'data-group-id':id,onclick:()=>void run('choose-group',()=>selectGroup(id))},
        avatarNode('group-avatar',{kind:'group',id,name:group.name,source:group.avatarSrc}),
        node('span',{class:'group-copy'},node('span',{class:'group-name'}),node('span',{class:'group-meta'})),
        node('span',{class:'unread-badge'}),node('span',{class:'group-selected-dot'}));
    }
    item.className='group-item'+(active?' active':'');
    updateAvatar(item.querySelector('.group-avatar'),{kind:'group',id,name:group.name,source:group.avatarSrc});
    item.querySelector('.group-name').textContent=group.name;
    item.querySelector('.group-meta').textContent=group.coverage?.newest?fmt(group.coverage.newest,true)+' 更新':'等待阅读';
    const badge=item.querySelector('.unread-badge'),count=Number(group.unreadCount)||0;
    badge.hidden=count===0;badge.textContent=reading.unreadLabel(count);badge.setAttribute('aria-label',count+' 条未读');
    item.querySelector('.group-selected-dot').hidden=!active;
    return item;
  });
  if(!children.length)children.push(node('p',{class:'empty-sidebar'},'选择你关心的群聊，\n把消息读回自己的节奏。'));
  host.dataset.avatarOwner=owner;reconcileChildren(host,children);
}
function renderHeader() {
  const isRead = model.view === 'read';
  const actions = [];
  if (isRead && model.groupId && accountKind() === 'weibo') {
    actions.push(button(model.syncStatus?.enabled===false?'恢复自动更新':'暂停自动更新',toggleAutoSync,'text small',{id:'auto-sync-toggle'}));
    actions.push(button('同步最新',()=>sync(false),'soft',{id:'sync-latest',title:'检查新消息，并从已保存的位置继续补齐离线消息；不跳转阅读位置。'}));
    actions.push(button('更早历史',()=>sync(true),'',{id:'sync-history',title:'读取本机最早记录之前的历史；中间的离线缺口由“补齐离线消息”继续读取。'}));
  }
  actions.push(button('工具栏',()=>{$('app').classList.toggle('show-inspector');},'mobile-panel-toggle'));
  // Navigation already identifies the view and group. Keep the actual controls
  // and task status without spending a second row on the same title.
  $('workspace-header').replaceChildren(node('div',{class:'header-utility-row'},node('div',{class:'header-status-area'},node('span',{id:'header-status',class:'header-status'}),node('div',{class:'sync-status-stack',hidden:accountKind()!=='weibo'},node('p',{id:'sync-status-line',class:'sync-status-line'}),node('p',{id:'sync-gap-line',class:'sync-gap-line'}))),node('div',{class:'header-actions',role:'group','aria-label':'工作区操作'},actions)));
  updateBusy();
  renderSyncStatus();renderAiRequestStatus();renderCleanupProgress();
}
async function switchAccount(id) {
  await activateAccount('account.switch',{id});
}
function clearContext() { if(model.summaryDeletion){model.summaryDeletion=null;if($('modal').dataset.context==='summary-delete')closeModal();}disposeSearchEditor();invalidateReadingIntent();model.accountEpoch++; model.queryVersion++;model.selected.clear(); model.inspected=null; model.preview=null; model.summary=null; model.summaries=[]; model.bookmarks=[];model.bookmarkSelected.clear();model.bookmarkQuery='';model.targets=[]; model.targetId=''; model.groupId=null; model.filters=emptyFilters(); model.offset=0; model.saveNote='';model.saveTags='';model.viewport=null;model.lastReadPayload='';model.syncRevision=null;model.syncStatus=null;model.messageObserver?.disconnect();clearTimeout(model.readTimer); }
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
async function selectGroup(id) { disposeSearchEditor();await flushReading(false);stashReadingDraft();model.groupId=String(id);model.view='read';model.filters=emptyFilters();model.selected.clear();model.inspected=null;model.summary=null;model.preview=null;model.offset=0;model.viewport=null;model.lastReadPayload='';restoreReadingDraft();renderSidebar();renderHeader();await loadReading(true); }
function queryPayload() {
  const f=model.filters;
  return {groupId:model.groupId,keyword:f.keyword,senderIds:f.senderIds,importantOnly:f.importantOnly,limit:model.limit,offset:model.offset,...filters.parseChinaMinuteRange(f.start,f.end)};
}
function autoPageKey() {
  return JSON.stringify([readingOwner(),model.searchEditor?.revision,model.filters,
    model.filters.importantOnly?model.state.importantMembers:null,model.state.revision]);
}
function autoPageSnapshot() {
  const scroll=$('message-scroll');
  return {key:autoPageKey(),enabled:!!scroll && isCurrentReadingRendered() && !model.switching && !model.closing && document.visibilityState==='visible' && document.hasFocus(),
    blocked:cleanupWorkActive() || model.restoring || model.refreshRunning || searchEditing() || !!model.readNavigation || !!model.searchEditor?.memberPicker?.isInteracting() || !!model.messageDrag?.isDragging() || !!$('modal')?.open,
    atTop:!!scroll && window.WeiyueAutoPage.isAtTop(scroll),atBottom:!!scroll && window.WeiyueAutoPage.isAtBottom(scroll),offset:model.offset,count:model.messages.length,total:model.total,pageSize:model.limit};
}
async function loadNextLocalPage(snapshot) {
  const last=model.messages.at(-1),first=model.messages[0];
  const previous=snapshot.direction<0;
  const boundary=previous?(first?{beforeId:String(first.id)}:{offset:0}):(last?{afterId:String(last.id)}:{offset:snapshot.offset});
  const result=await api('messages.query',{...queryPayload(),...boundary,limit:snapshot.pageSize});
  // A stable boundary is resolved against the same complete filtered list in
  // the store. Never use an unfiltered locate offset for filtered pagination.
  if(first && (previous?result.offset+result.messages.length!==snapshot.offset:result.offset!==snapshot.offset+snapshot.count)){queueReadingRefresh();throw new Error('分页位置已更新，请重试');}
  return result;
}
function appendLocalPage(result,snapshot={direction:1}) {
  const scroll=$('message-scroll'),space=$('reading-end-space');if(!scroll || !space)return;
  const previous=snapshot.direction<0;
  const seen=new Set(model.messages.map(message=>String(message.id)));
  const added=(result.messages || []).filter(message=>!seen.has(String(message.id)) && seen.add(String(message.id)));
  if(added.length!==result.messages.length || !added.length && (previous?model.offset>0:model.offset+model.messages.length<result.total))throw new Error('消息分页尚未完整加载，请重试');
  const anchor=captureViewport() || model.viewport;
  model.messageObserver?.disconnect();
  // Inserting only new siblings preserves native selection and selected tools.
  const insertion=previous?scroll.firstChild:space;
  let day=!previous && model.messages.length?new Date(model.messages.at(-1).time).toDateString():'';
  for(const message of added){
    const next=new Date(message.time).toDateString();
    if(next!==day){scroll.insertBefore(node('div',{class:'day-divider','data-day':next},dateLabel(message.time)),insertion);day=next;}
    const element=messageCard(message);scroll.insertBefore(element,insertion);model.messageSignatures.set(String(message.id),messageSignature(message));
  }
  if(previous){
    if(added.length && insertion?.classList.contains('day-divider') && insertion.dataset.day===day)insertion.remove();
    model.messages.unshift(...added);model.offset=result.offset;
  }else model.messages.push(...added);
  model.total=result.total;
  // Restoring by the first visible ID and its measured offset also revokes the
  // old gesture's read permission. Newly appended rows require fresh reading.
  restoreViewport(anchor);watchMessageSizes();updateReadChrome();scheduleRead();
}
function updateAutoPageChrome() {
  const status=autoPage.status(),scroll=$('message-scroll'),next=$('next-page'),previous=$('previous-page');
  const ended=model.offset+model.messages.length>=model.total;
  if(scroll){scroll.dataset.autoPageState=status.loading?'loading':status.state==='error'?'error':ended?'end':'idle';scroll.setAttribute('aria-busy',String(status.loading));}
  for(const [button,direction,end] of [[previous,-1,model.offset===0],[next,1,ended]]){
    if(!button)continue;
    const loading=status.loading && status.direction===direction,failed=status.state==='error' && status.direction===direction;
    button.disabled=status.loading || end;
    button.textContent=direction<0?(loading?'正在加载更早消息…':failed?'↑ 重试更早消息':'↑ 更早一页'):(loading?'正在加载后续消息…':failed?'重试更多消息 ↓':'更多消息 ↓');
    button.title=loading?'正在加载本地消息':failed?'加载失败，继续向相应方向滚动或点击重试':direction<0?'查看更早消息；滚动或使用上下翻页键到顶部也会自动加载':'查看后续消息；滚动或使用上下翻页键到底部也会自动加载';
  }
}
async function loadReading(restore=false, targetId=null, request=null) {
  if(request && !request.active())return;
  autoPage.reset();
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
    const loaded=[...element.querySelectorAll('img:not(.avatar-image):not(.emoticon-image)')].every(img=>img.complete && (img.naturalWidth>0 || img.hidden));
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
  return cleanupWorkActive() || autoPage.status().loading || searchEditing() || model.searchEditor?.memberPicker?.isInteracting() || !!model.readNavigation || !!model.messageDrag?.isDragging() || model.readingActivity?.owner===owner || (model.readingCommits.get(owner)||0)>0 ||
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
  clearTimeout(model.pagingWheelTimer);model.pagingWheel=null;
  model.readingInput?.cancel();
  autoPage.cancelIntent();
  model.messageDrag?.cancel();
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
  clearTimeout(model.pagingWheelTimer);model.pagingWheel=null;
  model.readingInput?.cancel();
  autoPage.cancelIntent();
  model.messageDrag?.cancel();
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
function messageSignature(message) {
  // Decorative avatar metadata never changes chat text, tools or reading layout.
  const {senderAvatarSrc,senderAvatarUrl,...content}=message;
  return JSON.stringify([content,isImportant(message.senderId),model.enrichmentErrors.get(enrichmentKey(message))]);
}
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
      updateMessageAvatar(element,message);
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
  const groupId=model.groupId,version=model.queryVersion,epoch=model.accountEpoch,key=autoPageKey();
  const active=()=>version===model.queryVersion && epoch===model.accountEpoch && groupId===model.groupId && model.view==='read' && key===autoPageKey();
  const anchor=captureViewport() || model.viewport;
  try{
    if(!active())return;
    const throughId=model.state.readStates?.[groupId]?.readThroughId;
    const [result,boundary]=await Promise.all([window.WeiyueAutoPage.queryWindow({query:payload=>api('messages.query',payload),payload:queryPayload(),
      firstId:model.messages[0]?String(model.messages[0].id):null,lastId:model.messages.at(-1)?String(model.messages.at(-1).id):null,count:model.messages.length,active}),locateReadBoundary(groupId,throughId)]);
    if(!active())return;
    if(readingBusy()){queueReadingRefresh(force);return;}
    // Re-capture after awaiting IPC: a user may have scrolled while data was loading.
    const latestAnchor=captureViewport() || anchor;
    model.readBoundary=boundary;model.offset=result.offset;model.total=result.total || 0;model.messages=result.messages || [];
    patchMessageList(model.messages,latestAnchor);
    if(force){const members=await api('members.list',{groupId});if(version===model.queryVersion && groupId===model.groupId){
      if(readingBusy()){queueReadingRefresh(force);return;}
      const changed=JSON.stringify(model.members)!==JSON.stringify(members || []);model.members=members || [];
      if(changed && isSearchEditorCurrent(model.searchEditor))updateSearchMembers(model.searchEditor);
    }}
  }catch(error){
    if(active())throw error;
    // A draft/IME change discards this result, then resumes refresh only after
    // the same reading pane settles. A different account/group owns no retry.
    if(version===model.queryVersion && epoch===model.accountEpoch && groupId===model.groupId && model.view==='read')queueReadingRefresh(force);
  }
  finally{model.refreshRunning=false;scheduleReadingRefresh();}
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
  return isSearchEditorCurrent(editor) && (editor.composing || editor.invalidRange || editor.timer!==null || editor.applying ||
    editor.draft!==model.filters.keyword);
}
function cancelSearchWork(editor=model.searchEditor) {
  if(!editor)return;
  clearTimeout(editor.timer);editor.timer=null;editor.revision++;
}
function disposeSearchEditor() {
  cancelSearchWork();model.searchEditor?.memberPicker?.destroy();model.searchEditor=null;model.filterReturn=null;
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
  const signature=JSON.stringify(model.members);
  if(signature===editor.members || !editor.memberPicker)return;
  editor.memberPicker.setMembers(model.members);editor.members=signature;
}
function resetFilterControls(editor) {
  editor.input.value='';editor.draft='';editor.composing=false;
  editor.filters=emptyFilters();
  editor.memberPicker?.setSelected([]);
  editor.filter.querySelectorAll('input[type="datetime-local"]').forEach(input=>input.value='');
  const error=editor.filter.querySelector('#reading-filter-error');if(error){error.hidden=true;error.textContent='';}
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
  const member=node('div',{id:'member-filter'});
  const advanced=node('div',{class:'filter-extra',hidden:!model.advanced},field('开始时间 · 北京时间',node('input',{type:'datetime-local',step:60,id:'reading-start',value:model.filters.start,'aria-label':'阅读开始时间（北京时间）',onchange:e=>{void applyFilters({start:e.target.value});}})),field('结束时间 · 含整分钟',node('input',{type:'datetime-local',step:60,id:'reading-end',value:model.filters.end,'aria-label':'阅读结束时间（北京时间）',onchange:e=>{void applyFilters({end:e.target.value});}})),node('div',{class:'filter-check'},check('只看重点成员',model.filters.importantOnly,v=>{void applyFilters({importantOnly:v});},{id:'important-filter'})));
  filter=node('div',{class:'filter-area',id:'reading-filters'},node('div',{class:'filter-row'},node('div',{class:'search-wrap'},node('span',{class:'search-symbol','aria-hidden':'true'},'⌕'),search),member,button(model.advanced?'收起筛选':'更多筛选',()=>{model.advanced=!model.advanced;advanced.hidden=!model.advanced;const btn=$('filter-toggle');btn.textContent=model.advanced?'收起筛选':'更多筛选';},'text small',{id:'filter-toggle'})),advanced,node('p',{id:'reading-filter-error',class:'filter-error',role:'alert',hidden:true}));
  const editor=bindSearchEditor(search,filter);
  editor.memberPicker=filters.createMemberPicker({container:member,members:model.members,selectedIds:model.filters.senderIds,onChange:ids=>{if(isSearchEditorCurrent(editor))void applyFilters({senderIds:ids});},onInteraction:active=>{if(active)invalidateReadingIntent();else scheduleReadingRefresh();}});
  }
  updateSearchMembers(model.searchEditor);
  const meta=node('div',{class:'read-meta'},node('span',{id:'read-count'},`${model.total.toLocaleString()} 条消息${hasFilters()?' · 已筛选':''} · 时间正序`),node('span',{},hasFilters()?button('清除筛选',clearReadingFilters,'text small'):node('span',{},'阅读位置自动保存')));
  const scroll=node('div',{id:'message-scroll',class:'message-scroll',tabindex:0,'aria-label':'消息列表',onscroll:handleReadingScroll});
  bindReadingInput(scroll);
  model.messageSignatures.clear();let day='';model.messages.forEach(m=>{const next=new Date(m.time).toDateString();if(next!==day){scroll.append(node('div',{class:'day-divider','data-day':next},dateLabel(m.time)));day=next;}scroll.append(messageCard(m));model.messageSignatures.set(String(m.id),messageSignature(m));});
  if(!model.messages.length)scroll.append(emptyState('这个范围暂时没有消息','试试调整日期、成员或关键词；新登录的群聊需要手动同步记录。',[button('清除筛选',clearReadingFilters,'soft')]));
  scroll.append(node('div',{id:'reading-end-space','aria-hidden':'true'}));
  const pagination=node('div',{class:'pagination'},button('↑ 更早一页',async()=>{await flushReading(false);model.offset=Math.max(0,model.offset-model.limit);await loadReading();},'',{id:'previous-page',disabled:model.offset===0}),node('span',{id:'page-position'},model.total?`${model.offset+1}–${Math.min(model.offset+model.messages.length,model.total)} / ${model.total}`:'暂无记录'),button('更多消息 ↓',async()=>{await flushReading(false);model.offset+=model.messages.length || model.limit;await loadReading();},'',{id:'next-page',disabled:model.offset+model.messages.length>=model.total}));
  const unread=node('div',{id:'new-messages-notice',class:'new-messages-notice','aria-live':'polite'},node('span',{id:'new-messages-count'}),button('加载到最新',jumpToLatest,'primary small',{id:'jump-latest'}));
  const navigation=node('div',{class:'reading-navigation'},unread,pagination,button('最新已读位置',jumpToLatestRead,'soft small',{id:'jump-latest-read',title:'回到本群最新读到的消息；不会将后面的未读消息标为已读'}));
  reconcileChildren(host,[filter,meta,scroll,selectionBar(),node('footer',{class:'reading-footer','aria-label':'翻页与阅读位置'},navigation)]);
  model.renderedReading={accountId:model.state.account.id,epoch:model.accountEpoch,groupId:model.groupId,version:model.queryVersion,filtered:hasFilters()};
  updateReadingSpace();updateReadChrome();
}
function hasFilters(value=model.filters) {return !!(value.keyword || value.senderIds?.length || value.start || value.end || value.importantOnly);}
async function applyFilters(changes=null,request=null) {
  const editor=request?.editor || model.searchEditor;
  if(!isSearchEditorCurrent(editor) || request && request.revision!==editor.revision)return;
  rememberUnfilteredViewport();
  if(!request){cancelSearchWork(editor);editor.filters={...editor.filters,...changes};}
  if(editor.composing)return;
  const revision=editor.revision,nextFilters={...editor.filters,keyword:editor.draft};
  const active=()=>isSearchEditorCurrent(editor) && revision===editor.revision && !editor.composing;
  const error=editor.filter.querySelector('#reading-filter-error');
  try{filters.parseChinaMinuteRange(nextFilters.start,nextFilters.end);}
  catch(problem){editor.invalidRange=true;invalidateReadingIntent();if(error){error.replaceChildren(document.createTextNode(`${problem.message} 当前仍显示上次查询结果。 `),button('清除筛选',clearReadingFilters,'text small'));error.hidden=false;}return;}
  editor.invalidRange=false;
  if(error){error.hidden=true;error.textContent='';}
  const filtered=hasFilters(nextFilters),token={revision};
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
  if(m.systemNotice?.kind==='weibo-system')return systemNoticeCard(m);
  const selected=model.selected.has(String(m.id));const important=isImportant(m.senderId);let tone=0;for(const char of String(m.senderId))tone=(tone+char.charCodeAt(0))%5;
  const card=node('article',{class:`message${selected?' chosen':''}${important?' is-important':''}`, 'data-message-id':m.id,'data-sender-id':m.senderId});
  const cb=node('input',{type:'checkbox',class:'message-check',checked:selected,'aria-label':`选择 ${m.senderName} ${fmt(m.time)} 的消息`,onchange:e=>{if(e.target.checked)model.selected.add(String(m.id));else model.selected.delete(String(m.id));card.classList.toggle('chosen',e.target.checked);model.inspected=m;updateSelection();}});
  const bookmark=messageIconButton('bookmark',()=>{model.selected=new Set([String(m.id)]);model.inspected=m;updateSelection();$('app').classList.add('show-inspector');$('bookmark-note')?.focus();},{'data-action':'bookmark-message'});
  updateBookmarkAction(bookmark,m.senderName,selected);
  const priority=messageIconButton('important',async event=>{
    const keyboardFocus=event.detail===0 && priority.matches(':focus-visible');
    const pointerExpanded=event.detail>0 && affordance.classList.contains('is-expanded');
    await api('important.set',{senderId:m.senderId,enabled:!important});await refreshState({background:true});
    if(model.filters.importantOnly){model.offset=0;await loadReading();}
    else await refreshReadingIncrementally(true);
    const current=findMessageElement(m.id)?.querySelector('.message-affordance');
    if(pointerExpanded && current?.matches(':hover'))current.classList.add('is-expanded');
    if(keyboardFocus && (document.activeElement===priority || document.activeElement===document.body))current?.querySelector('[data-action="important-member"]')?.focus({preventScroll:true});
  },{'data-action':'important-member','aria-label':`${important?'取消重点':'设为重点'}：${m.senderName}`,title:important?'取消重点':'设为重点','aria-pressed':String(important)});
  priority.classList.toggle('active',important);
  const tools=node('div',{class:'message-tools',role:'group','aria-label':`${m.senderName} 的消息操作`},bookmark,priority);
  const avatar=avatarNode(`avatar tone-${tone}`,{kind:'member',id:m.senderId,name:m.senderName,source:m.senderAvatarSrc});
  const affordance=node('div',{class:'message-affordance',onpointerleave:()=>affordance.classList.remove('is-expanded')},cb,node('div',{class:'message-rail'},avatar,tools));
  bindMessageAffordance(affordance,avatar);
  card.append(affordance,node('div',{class:'message-copy'},node('div',{class:'message-top'},node('span',{class:'sender-name',title:important?'重点成员':null},m.senderName),node('span',{class:'message-time',title:`消息 ID：${m.id}`},fmt(m.time))),renderMessageContent(m)));
  return card;
}
function bindMessageAffordance(affordance,trigger) {
  // Only entering the avatar opens mouse controls. The whole compact rail then
  // remains interactive so travelling to a button or checkbox cannot close it.
  trigger.addEventListener('pointerenter',()=>affordance.classList.add('is-expanded'));
  // Chromium can retain :focus-visible when the mouse clicks an already focused
  // keyboard control. Suppress that retained state until the next keyboard input.
  affordance.addEventListener('pointerdown',()=>affordance.classList.toggle('pointer-mode',affordance.contains(document.activeElement)));
  affordance.addEventListener('keydown',()=>affordance.classList.remove('pointer-mode'));
  affordance.addEventListener('focusout',event=>{if(!affordance.contains(event.relatedTarget))affordance.classList.remove('pointer-mode');});
}
function systemNoticeCard(m) {
  const selected=model.selected.has(String(m.id));
  const card=node('article',{class:`message message-system${selected?' chosen':''}`,'data-message-id':m.id,'data-sender-id':m.senderId});
  const cb=node('input',{type:'checkbox',class:'message-check',checked:selected,'aria-label':`选择 ${fmt(m.time)} 的系统通知`,onchange:event=>{if(event.target.checked)model.selected.add(String(m.id));else model.selected.delete(String(m.id));model.inspected=m;updateSelection();}});
  const icon=node('span',{class:'system-notice-icon','aria-hidden':'true'},'ⓘ');
  const affordance=node('div',{class:'message-affordance system-notice-affordance',onpointerleave:()=>affordance.classList.remove('is-expanded')},cb,icon);
  bindMessageAffordance(affordance,icon);
  const fullId=`system-notice-${encodeURIComponent(String(m.id))}`;
  const full=node('div',{id:fullId,class:'system-notice-full',hidden:true},renderMessageContent(m));
  const arrow=node('span',{'aria-hidden':'true',class:'system-notice-arrow'},'⌄');
  const toggle=button('展开系统通知全文',()=>{const expanded=full.hidden;full.hidden=!expanded;toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-label',expanded?'收起系统通知全文':'展开系统通知全文');toggle.title=expanded?'收起通知全文':'展开通知全文';arrow.textContent=expanded?'⌃':'⌄';},'system-notice-toggle',{'aria-expanded':'false','aria-controls':fullId,title:'展开通知全文'});
  toggle.replaceChildren(node('span',{class:'system-notice-text'},m.text || '系统通知'),arrow);
  card.append(node('div',{class:'system-notice-line'},affordance,node('span',{class:'message-time',title:`消息 ID：${m.id}`},fmt(m.time)),toggle),full);
  return card;
}
function messageIconButton(kind,action,props={}) {
  const control=button(kind==='important'?'设置重点成员':'整理消息收藏',action,`message-icon message-icon-${kind}`,props);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',width:'17',height:'17',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(key,value);
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',kind==='important'?'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z':'M6 3h12v18l-6-4-6 4V3Z');svg.append(path);control.replaceChildren(svg);return control;
}
function updateBookmarkAction(control,senderName,selected) {
  const label=selected?'已选择此消息，编辑收藏':'收藏此消息';
  control.title=label;control.setAttribute('aria-label',`${label}：${senderName}`);control.setAttribute('aria-pressed',String(selected));control.classList.toggle('active',selected);
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
    const open=node('button',{type:'button',class:'image-button','aria-label':`查看${caption}${index+1}原图`,onclick:()=>{if(original)void run('查看原图',()=>showOriginalImage(original,`${caption} ${index+1}`,message));else reportError(new Error('这张图片没有可用的本机代理地址，请在官方页面查看。'));}},image);
    cell.append(open,loading,failure,node('figcaption',{class:'image-caption'},'点击查看原图'));
    if(src)image.src=src;else{loading.hidden=true;image.hidden=true;failure.hidden=false;}
    return cell;
  }));
}
async function showOriginalImage(source,title,message) {
  const src=safeMediaSource(source);if(!src)throw new Error('图片地址未通过本机代理检查。');
  await api('image.open',{source:src,title,caption:`${message.senderName || '群聊分享'} · ${fmt(message.time,true)}`});
}
function isNotificationOnly(message) {
  if(!/^我发布了新微博[，,]\s*快来围观吧[！!]?$/.test(String(message.text || '').trim()))return false;
  const post=message.sharedPost;
  if(!post)return true;
  return post.state==='unavailable' && post.reason==='通知未提供原微博地址，无法确定原帖' &&
    post.text==='' && Array.isArray(post.images) && post.images.length===0 &&
    [post.id,post.url,post.author].every(value=>value===undefined || value===null || value==='') && !post.truncated;
}
function needsMessageContext(message) {
  // Sender names can identify candidates for a bounded official detail lookup;
  // they never classify a notification or change the rendered message type.
  return message.contextVersion!==1 && (message.senderName==='粉丝群' ||
    /^「(?:@[^\r\n:]{1,256}:)?图片」\r?\n- - - - - - - - - - - - - - -\r?\n/.test(message.text || ''));
}
function isLegacyShare(message) {
  if(isNotificationOnly(message))return false;
  return (!message.mediaVersion && /分享.*图片|我发布了新微博|分享.*微博/.test(message.text || '')) ||
    ((message.text || '').trim()==='分享语音' && !message.attachments?.some(a=>a.kind==='audio')) ||
    ((message.text || '').trim()==='实况照片' && !message.attachments?.some(a=>a.kind==='video' && a.livePhoto)) ||
    (!message.attachmentVersion && /^(?:文件消息|分享视频)$/.test((message.text || '').trim())) ||
    (!message.referenceVersion && (!!message.images?.length || !!message.sharedPost || !message.text?.trim() || /分享.*图片|分享.*微博|「图片」/.test(message.text || '')));
}
function enrichmentKey(message) {return `${model.state.account?.id || ''}\u0000${message.groupId}\u0000${message.id}`;}
function renderMessageContent(message) {
  const openLink=url=>void run('open-external-link',()=>api('external.open',{url}));
  const content=node('div',{class:'message-content'},emoticons.appendText(node('div',{class:'message-text'}),message.text || '',openLink));
  if(message.images?.length)content.append(imageGallery(message.images,message));
  for(const attachment of message.attachments || []){
    const archive=attachment.kind==='archive';
    const type=attachment.livePhoto?'实况照片':attachment.kind==='video'?'视频':attachment.kind==='audio'?'语音':attachment.kind==='pdf'?'PDF 文件':attachment.kind==='document'?'文档':archive?'压缩文件':'文件';
    const action=attachment.livePhoto?'播放实况照片':attachment.kind==='video'?'播放视频':attachment.kind==='audio'?'播放语音':archive?'下载压缩文件':'预览文件';
    const info=[type,attachment.size?((attachment.size/1024/1024).toFixed(2)+' MB'):'',attachment.state==='needs-metadata'?'点击读取文件信息':''].filter(Boolean).join(' · ');
    const download=async()=>{const result=await api('attachment.download',{source:attachment.src});if(!result?.canceled)toast('原文件已保存到所选位置。');};
    content.append(node('section',{class:'attachment-card'},node('div',{class:'attachment-copy'},node('strong',{},attachment.name || type),node('small',{},info)),button(action,archive?download:()=>api('attachment.open',{source:attachment.src}),'small attachment-open',{'aria-label':action+' '+(attachment.name || type)}),['file','document'].includes(attachment.kind)?button('下载原文件',download,'small attachment-download'):null,node('span',{class:'attachment-save-hint'},archive?'选择保存位置，不解压或运行':'预览窗口内可另存原文件')));
  }
  const post=message.sharedPost;
  if(post && !isNotificationOnly(message)){
    const cached=post.state!=='ready' && !!(post.text || post.images?.length);
    const card=node('section',{class:'shared-post'},node('div',{class:'shared-post-title'},node('strong',{},post.author || '分享的微博'),node('span',{},cached?'本地缓存':post.state==='ready'?'微博内容':'内容暂不可用')));
    if(post.text)card.append(emoticons.appendText(node('div',{class:'shared-post-text'}),post.text,openLink));
    if(post.images?.length)card.append(imageGallery(post.images,message,'微博配图'));
    if(post.state!=='ready')card.append(node('p',{class:'shared-post-warning'},`${cached?'这里保留的是本地缓存内容，当前原帖未确认可用。\n':''}${post.reason || '当前无法取得原微博内容，请通过原链接或官方页面核对。'}`));
    if(post.truncated)card.append(node('p',{class:'shared-post-warning'},'当前返回的微博正文可能不完整，请打开原微博查看全文。'));
    const originalLink=links.createLink(document,post.url,'打开原微博 ↗',openLink);
    if(originalLink){originalLink.classList.add('post-original-link');card.append(originalLink);}
    if(post.state!=='ready' && post.url && accountKind()==='weibo')card.append(button('重试读取原文',()=>enrichMessages([message],true),'text small'));
    content.append(card);
  }
  if(message.references?.length)content.append(...window.WeiyueReferences.render(message,{node,appendText:emoticons.appendText,imageGallery,createLink:(url,title,cb)=>links.createLink(document,url,title,cb),openLink}));
  const quote=message.quotePreview;
  if(message.contextVersion===1 && quote?.kind==='image' && quote.state==='unavailable' && quote.reasonCode==='WEB_REFERENCE_TARGET_UNAVAILABLE'){
    content.append(node('p',{class:'legacy-share-note quote-image-note'},'当前网页数据无法确认这条引用的原图，暂不能可靠打开。'),officialChatButton());
  }else if(!message.contextVersion && /^「(?:@[^\r\n:]{1,256}:)?图片」\r?\n- - - - - - - - - - - - - - -\r?\n/.test(message.text || '')){
    content.append(node('p',{class:'legacy-share-note quote-image-note'},'引用图片信息尚未补全，可尝试重新同步。'),officialChatButton());
  }
  if(isLegacyShare(message)){
    const error=model.enrichmentErrors.get(enrichmentKey(message));
    const note=node('div',{class:'legacy-share-note'},error?`补全未完成：${error}`:'这条记录尚缺语音、实况照片或完整分享信息，可按需补全。');
    if(accountKind()==='weibo')note.append(button(error?'重试补全':'补全这条分享',()=>enrichMessages([message],true),'text small'));
    else note.textContent='这条导入记录未包含完整媒体或原微博信息，可导入完整数据或在官方页面查看。';
    content.append(note);
  }
  if(message.mediaVersion && /分享.*图片/.test(message.text || '') && !message.images?.length && !post?.images?.length)content.append(node('p',{class:'legacy-share-note'},'这条消息未提供可用的图片地址，可在官方页面查看。'),officialChatButton());
  return content;
}
async function enrichMessages(messages,manual=false) {
  if(model.enriching || accountKind()!=='weibo' || model.switching)return;
  const groupId=messages[0]?.groupId;if(!groupId)return;
  const candidates=messages.filter(m=>m.groupId===groupId && (isLegacyShare(m) || needsMessageContext(m) || manual && m.sharedPost?.state==='unavailable' && m.sharedPost?.url) && (manual || !model.enrichmentAttempted.has(enrichmentKey(m)))).slice(0,10);
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
function updateSelection() { document.querySelectorAll('[data-message-id]').forEach(el=>{const yes=model.selected.has(el.dataset.messageId);el.classList.toggle('chosen',yes);el.querySelector('input[type=checkbox]').checked=yes;const action=el.querySelector('[data-action="bookmark-message"]');if(action)updateBookmarkAction(action,el.querySelector('.sender-name')?.textContent || '',yes);});const bar=$('selection-bar');if(bar)bar.replaceWith(selectionBar());renderInspector(); }
function bindReadingInput(scroll) {
  model.readingInput?.dispose();
  model.messageDrag?.dispose();model.messageDrag=null;
  let dragSequence=0,dragDirection=0,dragTrusted=false,hoverTarget=null;
  const listeners=[],heldKeys=new Map();
  const listen=(target,name,listener,options)=>{target.addEventListener(name,listener,options);listeners.push(()=>target.removeEventListener(name,listener,options));};
  const current=()=>scroll===$('message-scroll') && isCurrentReadingRendered() && !model.switching && !model.closing && !$('modal').open && document.visibilityState==='visible' && document.hasFocus();
  const interactive=target=>target instanceof Element && (target.isContentEditable || !!target.closest('input,textarea,select,option,button,a[href],summary,video,audio,dialog,[role="dialog"],[role="combobox"],[role="listbox"],[role="menu"],[role="slider"],[contenteditable]:not([contenteditable="false"])'));
  const nextGesture=()=>`${readingOwner()}:${++model.pagingGestureSequence}`;
  const geometry=direction=>({scroll,direction,owner:readingOwner(),layout:model.layoutVersion,height:scroll.scrollHeight,clientHeight:scroll.clientHeight});
  const cancel=()=>{model.pagingKeyboard=null;model.pagingPointer=null;autoPage.cancelIntent();};
  model.readingInput={cancel,dispose:()=>{listeners.splice(0).forEach(remove=>remove());heldKeys.clear();hoverTarget=null;cancel();}};
  const pageIntent=(event,kind,gestureId,direction=event.deltaY ?? dragDirection)=>autoPage.intent({trusted:event.isTrusted===true,kind,direction,
    gestureId,modified:!!(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)});
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
  listen(scroll,'wheel',event=>{
    if(!current() || !event.isTrusted || !event.deltaY || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.target instanceof Element && event.target.closest('input,textarea,select,video,audio,[contenteditable]:not([contenteditable="false"])'))return;
    if(event.deltaY>0)arm(event);else resetReadCandidate();
    model.pagingKeyboard=null;
    clearTimeout(model.pagingWheelTimer);model.pagingWheel=null;
    const token={...geometry(Math.sign(event.deltaY)),until:performance.now()+250};model.pagingWheel=token;
    // A native wheel animation spans several frames. Geometry changes revoke
    // this short-lived intent rather than loading because an image resized.
    model.pagingWheelTimer=setTimeout(()=>{if(model.pagingWheel===token){model.pagingWheel=null;autoPage.cancelIntent();}},250);
    pageIntent(event,'wheel');
  },{passive:true});
  listen(scroll,'pointerenter',event=>{if(event.isTrusted)hoverTarget=event.target;});
  listen(scroll,'pointerleave',()=>{hoverTarget=null;});
  listen(document,'keydown',event=>{
    const direction=['PageUp','ArrowUp'].includes(event.key)?-1:['PageDown','ArrowDown'].includes(event.key)?1:0;
    if(!direction || !event.isTrusted || event.defaultPrevented || event.isComposing || event.keyCode===229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !current())return;
    const active=document.activeElement,safeRoot=target=>target===document.body || target===document.documentElement;
    // A focused control in any pane keeps its keys. Body focus can use the
    // reading pane only while the pointer is actually over non-interactive chat.
    if(interactive(event.target) || interactive(active) || !(active===scroll && event.target===scroll || safeRoot(active) && safeRoot(event.target) && hoverTarget && !interactive(hoverTarget)))return;
    event.preventDefault();
    let gesture=heldKeys.get(event.key);
    if(!gesture){if(event.repeat)return;gesture={id:nextGesture(),owner:readingOwner()};heldKeys.set(event.key,gesture);}
    if(gesture.owner!==readingOwner())return;
    if(direction>0)arm(event);else resetReadCandidate();
    clearTimeout(model.pagingWheelTimer);model.pagingWheel=null;
    const token={...geometry(direction),until:performance.now()+250};model.pagingKeyboard=token;
    pageIntent(event,'keyboard',gesture.id,direction);
    const step=event.key.startsWith('Page')?Math.max(40,scroll.clientHeight-40):40;
    scroll.scrollTop=Math.max(0,Math.min(scroll.scrollHeight-scroll.clientHeight,scroll.scrollTop+direction*step));
    handleReadingScroll();
  });
  listen(document,'keyup',event=>{heldKeys.delete(event.key);if(!heldKeys.size)model.pagingKeyboard=null;});
  listen(window,'blur',()=>{heldKeys.clear();hoverTarget=null;cancel();});
  listen(scroll,'keydown',event=>{
    if(event.target!==scroll || event.ctrlKey || event.metaKey || event.altKey)return;
    if(['End',' '].includes(event.key) && !event.shiftKey)arm(event);
    else if(event.key==='Home' || event.key===' ' && event.shiftKey)invalidateReadingIntent();
  });
  listen(scroll,'pointerdown',event=>{
    // Only a native scrollbar drag grants scroll intent; clicking message tools does not.
    const bounds=scroll.getBoundingClientRect();
    if(event.isTrusted && current() && event.button===0 && event.target===scroll && event.clientX>=bounds.right-(scroll.offsetWidth-scroll.clientWidth)-2){
      model.pointerScrolling=arm(event);model.pointerReading=model.pointerScrolling?{owner:readingOwner(),scroll}:null;
      model.pagingPointer={...geometry(0),gestureId:nextGesture(),trusted:true};
    }
    if(event.pointerType==='touch')model.touchY=event.clientY;
  });
  listen(scroll,'pointermove',event=>{
    if(event.isTrusted)hoverTarget=event.target;
    if(event.pointerType==='touch' && model.touchY!==null){if(event.clientY<model.touchY)arm(event);model.touchY=event.clientY;}
    else if(model.pointerScrolling && event.buttons)arm(event);
  });
  const releasePointer=event=>{
    const token=model.pagingPointer;model.pagingPointer=null;
    if(token && event.isTrusted && current() && token.direction && pagingGeometryMatches(token,scroll))pageIntent(event,'drag',token.gestureId,token.direction);
  };
  listen(window,'pointerup',releasePointer);listen(window,'mouseup',releasePointer);
  listen(window,'pointercancel',()=>{model.pagingPointer=null;autoPage.cancelIntent();});
  model.messageDrag=window.WeiyueDragScroll?.attach(scroll,{
    isCurrent:()=>scroll===$('message-scroll') && isCurrentReadingRendered() && !model.switching && !model.closing && !$('modal').open,
    canStart:event=>{
      const target=event.target,bounds=scroll.getBoundingClientRect();
      // Text descendants, avatars, tools, links, media and forms retain native
      // input. Only these containers contain empty padding instead of direct text.
      return target instanceof Element && (target===scroll || target.matches('.message,.message-copy,.message-top,#reading-end-space')) &&
        event.clientX<bounds.right-(scroll.offsetWidth-scroll.clientWidth)-2;
    },
    onStart:()=>{dragSequence=nextGesture();dragDirection=0;dragTrusted=false;scroll.classList.add('is-dragging');window.getSelection()?.removeAllRanges();},
    onIntent:(event,{direction})=>{dragDirection=direction;dragTrusted=event.isTrusted===true;},
    beforeMove:(event,{from,to})=>{if(to>from)arm(event);else if(to<from)resetReadCandidate();},
    onEnd:({cancelled})=>{
      scroll.classList.remove('is-dragging');
      if(!cancelled && scroll.scrollTop!==model.scrollTop)handleReadingScroll();
      readIntent.reset();
      if(cancelled){resetReadCandidate();scheduleRead();}
      // Release completes this physical gesture, including a clamped short page.
      // A stable token grants at most one append after any duration of holding.
      if(!cancelled)pageIntent({isTrusted:dragTrusted},'drag',dragSequence);
      else autoPage.cancelIntent();
      scheduleReadingRefresh();
    }
  }) || null;
}
function pagingGeometryMatches(token,scroll) {
  return token.scroll===scroll && token.owner===readingOwner() && token.layout===model.layoutVersion && token.height===scroll.scrollHeight && token.clientHeight===scroll.clientHeight && (token.until===undefined || performance.now()<=token.until);
}
function handleReadingScroll() {
  const scroll=$('message-scroll');if(!scroll || model.restoring || !isCurrentReadingRendered())return;
  model.viewport=captureViewport();
  // A delayed duplicate scroll event must not replace the final drag's dwell.
  if(scroll.scrollTop===model.scrollTop){updateReadChrome();return;}
  // Chromium handles an active native scrollbar drag without dispatching DOM
  // pointermove events. Its verified pointerdown stays valid until release or
  // context cancellation; renew from the last accepted position on each move.
  if(model.pointerScrolling && model.pointerReading?.owner===readingOwner() && model.pointerReading.scroll===scroll && scroll.scrollTop>model.scrollTop && canAdvanceRead() && !hasFilters()){
    readIntent.arm(readingContext(),model.scrollTop,performance.now(),true);model.readingActivity={owner:readingOwner()};
  }
  const candidate=canAdvanceRead() && !hasFilters()?readIntent.scroll(readingContext(),scroll.scrollTop,performance.now(),model.viewport?.readThroughId):null;
  const direction=scroll.scrollTop>model.scrollTop?1:-1;
  model.scrollTop=scroll.scrollTop;updateReadChrome();scheduleRead(candidate);
  const pointer=model.pagingPointer;
  if(pointer){if(pagingGeometryMatches(pointer,scroll))pointer.direction=direction;else model.pagingPointer=null;}
  for(const field of ['pagingWheel','pagingKeyboard']){
    const token=model[field];if(!token)continue;
    if(!pagingGeometryMatches(token,scroll)){model[field]=null;autoPage.cancelIntent();}
    else if(direction===token.direction)autoPage.observe();
  }
}
function canAdvanceRead() {return !cleanupWorkActive() && isCurrentReadingRendered() && !searchEditing() && !model.searchEditor?.memberPicker?.isInteracting() && !model.readNavigation && document.visibilityState==='visible' && document.hasFocus() && !$('modal').open && !model.switching;}
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
  if(cleanupWorkActive()){invalidateReadingIntent();return;}
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
  const notice=$('new-messages-notice');if(notice){notice.hidden=false;$('new-messages-count').textContent=`${unread} 条未读`;}
  const latestRead=$('jump-latest-read');if(latestRead){latestRead.disabled=!!model.readNavigation || !model.state.readStates?.[model.groupId]?.readThroughId;latestRead.title=latestRead.disabled && !model.readNavigation?'本群还没有已读位置；正常向下阅读后自动保存。':'回到本群最新读到的消息；不会将后面的未读消息标为已读';}
  updateAutoPageChrome();
}
async function jumpToLatestRead(event) {
  if(!event?.isTrusted || model.readNavigation)return;
  const groupId=model.groupId,epoch=model.accountEpoch,accountId=model.state.account?.id,version=model.queryVersion;
  const editor=model.searchEditor;cancelSearchWork(editor);
  const revision=editor?.revision,token={groupId,epoch};model.readNavigation=token;
  const ownerActive=()=>model.readNavigation===token && groupId===model.groupId && epoch===model.accountEpoch && accountId===model.state.account?.id && model.view==='read' && !model.switching && !model.closing;
  const active=()=>ownerActive() && version===model.queryVersion && (!editor || editor===model.searchEditor && revision===editor.revision);
  updateReadChrome();
  try{
    await flushReading(false);await model.readWrite;if(!active())return;
    const state=await api('state');if(!active() || state.account?.id!==accountId)return;
    const target=state.readStates?.[groupId]?.readThroughId;
    if(!target){toast('本群还没有已读位置，正常向下阅读后会自动保存。');return;}
    const located=await api('messages.locate',{groupId,messageId:String(target)});if(!active())return;
    if(!located?.message)throw new Error('这条已读消息尚未保存在本机，请补充同步后再试。');
    const cleared=hasFilters() || hasFilters(editor?.filters) || !!editor?.draft;
    model.state=state;disposeSearchEditor();model.filters=emptyFilters();
    model.offset=reading.chooseWindow({anchorIndex:Number(located.offset),limit:model.limit}).offset;
    const loaded=await loadReading(false,String(target),{active:ownerActive});
    if(!loaded || !ownerActive() || loaded!==model.queryVersion)return;
    updateUnreadBadges();
    // Restore both layout frames before persisting only the viewport anchor.
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if(!ownerActive() || loaded!==model.queryVersion)return;
    await flushReading(false);
    if(ownerActive())toast(cleared?'已清除筛选，返回最新已读位置。':'已返回最新已读位置。');
  }finally{
    if(model.readNavigation===token)model.readNavigation=null;
    updateReadChrome();scheduleReadingRefresh();
  }
}
async function jumpToLatest(event) {
  if(!event?.isTrusted)return;
  const groupId=model.groupId,epoch=model.accountEpoch,version=model.queryVersion;
  const active=()=>groupId===model.groupId && epoch===model.accountEpoch && version===model.queryVersion && model.view==='read';
  await flushReading(false);if(!active())return;
  // The count is a snapshot. Messages arriving after it are outside this action.
  const first=await api('messages.query',{groupId,limit:1,offset:0});if(!active())return;
  const total=Number(first.total)||0;
  disposeSearchEditor();model.filters=emptyFilters();
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
  disposeSearchEditor();model.groupId=groupId;model.view='read';model.filters=emptyFilters();model.offset=Math.max(0,Number(result.offset)-25);model.selected.clear();model.inspected=null;model.summary=null;renderSidebar();renderHeader();await loadReading(false,messageId);toast('已定位到本机保存的原始消息。');
}
async function sync(history) {
  if(model.manualSync)return;
  const groupId=model.groupId;model.manualSync=true;renderSyncStatus();
  try {
    const result=await api('sync',{groupId,history});
    await refreshState({background:true});await refreshReadingIncrementally(true);model.preview=null;
    toast(syncDisplay.manualResult({history,added:result?.count,group:model.state.groups.find(g=>String(g.id)===String(groupId))}));
  } catch(error) {
    // A failed later page can still have saved progress. Display that state,
    // but preserve the original failure rather than announcing success.
    await refreshState({background:true}).catch(()=>{});
    await refreshReadingIncrementally(true).catch(()=>{});
    throw error;
  } finally {model.manualSync=false;renderSyncStatus();}
}
function renderSyncStatus() {
  const line=$('sync-status-line');if(!line || accountKind()!=='weibo')return;
  const status=model.syncStatus,automatic=syncDisplay.automaticStatus(status,{formatTime:time=>fmt(time)}),group=syncDisplay.groupStatus(currentGroup());
  line.textContent=automatic.text;line.title=automatic.text;line.classList.toggle('has-error',automatic.tone==='warning');
  const gap=$('sync-gap-line');if(gap){gap.textContent=group.text;gap.title=group.text;gap.classList.toggle('has-error',group.tone==='warning');}
  const toggle=$('auto-sync-toggle');if(toggle)toggle.textContent=automatic.toggleLabel;
  const rateWait=status?.errorCode==='RATE_LIMIT'&&Number.isFinite(status?.nextRunAt)&&status.nextRunAt>Date.now();
  const latest=$('sync-latest');if(latest){latest.textContent=group.actionLabel;latest.disabled=cleanupWorkActive()||model.manualSync||!!status?.running||rateWait;}
  const history=$('sync-history');if(history)history.disabled=cleanupWorkActive()||model.manualSync||!!status?.running||rateWait;
}
async function toggleAutoSync() {model.syncStatus=await api('sync.configure',{enabled:model.syncStatus?.enabled===false||!!model.syncStatus?.blocked});renderSyncStatus();}
async function pollUpdates() {
  if(model.polling || model.switching || model.closing || cleanupWorkActive())return;
  model.polling=true;
  try{
    const epoch=model.accountEpoch;
    const status=await api('sync.status',{accountId:model.state.account?.id,groupId:model.view==='read'?model.groupId:null});
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
  card.append(button('生成本地摘录',()=>generateSummary(false),'primary full',{id:'generate-local',disabled:!model.groupId}),button('使用 AI 总结…',confirmAI,'full',{id:'generate-ai',disabled:!model.groupId || model.aiRequest?.status==='running'}),node('p',{class:'caption'},'AI 先准备本时段可读正文与图片，显示实际范围和遗漏；只有确认后才发送到所选服务。图片需要支持视觉的模型，可能额外计费。'));
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
  if(here&&running)actions.push(button('取消请求',async()=>{await api('summary.ai.cancel',{requestId:request.requestId,previewId:request.previewId});toast('已请求取消；服务已接收的内容和费用无法撤回。');},'text small',{id:'cancel-ai-request'}));
  if(here && request.status==='complete')actions.push(button('查看摘要',async()=>{
    const epoch=model.accountEpoch;await flushReading(false);stashReadingDraft();if(epoch!==model.accountEpoch)return;
    model.summary=request.summary;model.groupId=request.summary.groupId;model.view='summaries';renderSidebar();renderHeader();renderSummary();renderInspector();
  },'text small',{id:'view-ai-summary'}));
  if(!running)actions.push(button('关闭',()=>{if(model.aiRequest===request)model.aiRequest=null;renderAiRequestStatus();},'text small',{id:'dismiss-ai-status','aria-label':'关闭 AI 请求状态'}));
  header.append(node('div',{id:'ai-request-status',class:'ai-request-status '+request.status,role:'status','aria-live':'polite','aria-busy':String(running)},running?node('span',{class:'busy-indicator','aria-hidden':'true'}):null,node('span',{id:'ai-request-message'},message),...actions));
}
function startAiSummary(range,preview) {
  if(model.aiRequest?.status==='running')return;
  const request={sequence:++model.aiRequestSequence,requestId:'send-'+Date.now()+'-'+model.aiRequestSequence,previewId:preview.previewId,status:'running',accountId:model.state.account?.id,epoch:model.accountEpoch,range:Object.freeze({...range}),error:'',summary:null};
  // Lock before closing the dialog or yielding: a second click cannot create a second request.
  model.aiRequest=request;closeModal();renderAiRequestStatus();
  void run('active-ai-request-'+request.sequence,async()=>{
    try{
      await flushReading(false);stashReadingDraft();
      if(request.epoch!==model.accountEpoch || request.accountId!==model.state.account?.id)throw new Error('工作区已切换');
      const summary=await api('summary.ai',{previewId:request.previewId,requestId:request.requestId,confirmed:true});
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
  if(!model.state.credentials.ai || !model.state.settings.endpoint || !model.state.settings.model){showSettings();toast('请先配置 AI 服务地址、模型和 Key。',true);return;}
  const range=getRange(),epoch=model.accountEpoch;
  const preparation={requestId:'prepare-'+Date.now()+'-'+(++model.aiRequestSequence),canceled:false,previewId:null};
  const cancelPreparation=async()=>{preparation.canceled=true;closeModal();await api('summary.ai.cancel',{requestId:preparation.requestId,previewId:preparation.previewId});};
  modal('准备 AI 总结内容',node('div',{class:'ai-prepare-status',role:'status'},node('p',{},'正在核对选定时段的分享微博正文与图片…'),node('p',{class:'form-description'},'此步骤只读取本地记录及其中可访问的微博内容，不调用 AI。准备完成后会列出实际发送范围、模型和遗漏。')) ,[],{onClose:cancelPreparation,closeLabel:'取消准备'});
  let p;
  try{
    p=await api('summary.ai.prepare',{...range,requestId:preparation.requestId});preparation.previewId=p.previewId;
    if(preparation.canceled||epoch!==model.accountEpoch){await api('summary.ai.discard',{previewId:p.previewId});return;}
  }catch(error){if(preparation.canceled)return;closeModal();throw error;}
  model.preview=p;renderInspector();
  if(!p.messageCount)throw new Error('选定时段没有可发送的消息。');
  const scope=p.contentScope||{},omissions=scope.omissions||[];
  let agreed=false;const send=button('确认发送并生成',()=>{if(!agreed)throw new Error('请先确认发送范围。');if(model.aiRequest?.status==='running')return;send.disabled=true;startAiSummary(range,p);},'primary',{id:'confirm-ai-send',disabled:true});
  const cancelPreview=async()=>{closeModal();await api('summary.ai.discard',{previewId:p.previewId});};
  modal('确认发送至 AI 服务',node('div',{},
    node('p',{class:'form-description'},'将发送下列快照中的聊天与可读微博正文、成员显示名、时间、引用标记，以及实际准备好的图片字节。只发送到所列服务；不会隐式调用 OCR 或其他模型。'),
    node('div',{class:'preview-blocks',id:'ai-content-scope'},`服务：${p.service.url}\n实际模型：${p.service.model}\n群聊：${groupName(range.groupId)}\n时段：${fmt(range.start,true)} — ${fmt(range.end,true)}\n聊天：${p.messageCount} 条；分享微博正文：${scope.postCount||0} 条\n实际图片：${scope.imageCount||0} 张（${((scope.imageBytes||0)/1024/1024).toFixed(2)} MiB）；重复图片：${scope.duplicateImages||0} 张\n请求分段：${p.chunkCount} 个；范围遗漏：${omissions.length} 项`),
    node('p',{class:scope.vision?.supported?'form-description':'warning',id:'ai-vision-status'},scope.vision?.reason||p.service.vision?.reason||'请核对所选模型的图片能力。'),
    node('div',{class:'warning',id:'ai-cost-notice'},scope.costNotice||'图片会额外消耗 token，具体费用由所选服务决定。每段最多生成 4096 token；本次不自动提高预算、重试或更换服务。'),
    p.warning?node('div',{class:'warning'},noteText(p.warning)):null,
    omissions.length?node('details',{open:true,id:'ai-omissions'},node('summary',{},`未完整纳入的内容 · ${omissions.length} 项`),node('div',{class:'preview-blocks'},omissions.map(item=>`[${item.label||item.messageId||'来源'}] ${item.kind==='post'?'微博正文':'图片'}：${item.reason}`).join('\n'))):node('p',{class:'caption'},'当前准备步骤未报告遗漏；这不代表群聊历史记录完整。'),
    node('details',{},node('summary',{},`展开前 ${(p.messages||[]).length} 条正文预览`),node('div',{class:'preview-blocks'},(p.messages||[]).map(m=>`${fmt(m.time,true)} ${m.senderName}\n${m.text}`).join('\n\n'))),
    node('div',{class:'form-section'},check('我已核对实际正文、图片与遗漏，确认发送并承担所选服务费用',false,v=>{agreed=v;send.disabled=!v || model.aiRequest?.status==='running';},{id:'ai-consent'}))),[send],{onClose:cancelPreview});
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
  host.replaceChildren(...model.bookmarks.map(b=>node('article',{class:'bookmark-card','data-bookmark-id':b.id},node('div',{class:'card-meta'},node('input',{type:'checkbox',class:'bookmark-select','data-bookmark-id':b.id,'aria-label':`选择收藏：${(b.note || b.messages?.[0]?.text || groupName(b.groupId)).slice(0,40)}`,checked:model.bookmarkSelected.has(String(b.id)),onchange:event=>changeBookmarkSelection([b.id],event.target.checked)}),node('span',{class:'card-group'},groupName(b.groupId)),node('span',{},`${b.messageIds?.length || b.messages?.length || 0} 条消息`),node('span',{},fmt(b.createdAt,true))),node('div',{class:'bookmark-chat-surface'},...(b.messages||[]).map(m=>node('div',{class:`bookmark-message${m.systemNotice?.kind==='weibo-system'?' message-system':isImportant(m.senderId)?' is-important':''}`,'data-sender-id':m.senderId},node('div',{class:'message-top'},node('span',{class:'sender-name',title:isImportant(m.senderId)?'重点成员':null},m.senderName),node('span',{class:'message-time'},fmt(m.time,true))),renderMessageContent(m),button('回到原文 ↗',()=>jumpToMessage(m),'text small')))),b.note?node('div',{class:'bookmark-note'},b.note):null,node('div',{class:'tag-row'},(b.tags||[]).map(t=>node('span',{class:'tag'},`# ${t}`))),node('div',{class:'card-actions'},button('导出到 Notion',()=>chooseBookmarkNotionTarget([b.id]),'text small',{'data-action':'notion-export'}),button('编辑备注',()=>editBookmark(b),'text small'),button('移除收藏',()=>confirmRemoveBookmark(b),'text small')))));
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
  const cards=model.summaries.slice().sort((a,b)=>b.createdAt-a.createdAt).map(s=>node('article',
    {class:'summary-list-card','data-summary-id':s.id},
    node('button',{type:'button',class:'summary-open','aria-label':`查看摘要：${s.title}`,onclick:()=>{model.summary=s;model.groupId=s.groupId;model.preview=null;renderSidebar();renderHeader();renderSummary();renderInspector();}},
      node('div',{class:'card-meta'},node('span',{class:'card-group'},groupName(s.groupId)),node('span',{class:'live-badge'},s.mode==='local'?'本地摘录':'AI 摘要'),node('span',{},fmt(s.createdAt,true))),
      node('h3',{},s.title),node('p',{class:'summary-excerpt'},s.body),
      node('div',{class:'card-actions'},node('span',{class:'caption'},`${s.refs?.length || 0} 处原文引用　↗`))),
    summaryDeleteButton(s)
  ));
  host.replaceChildren(node('div',{class:'view-toolbar'},node('span',{class:'caption'},`${model.summaries.length} 份已保存摘要 · 点击查看引用与导出`)),node('div',{class:'content-scroll'},cards));
}
function summaryDeleteButton(summary) {
  const control=button('删除摘要',event=>confirmDeleteSummary(summary,event.currentTarget),'summary-delete',{
    title:'删除摘要','aria-label':'删除摘要','data-action':'delete-summary','data-summary-id':summary.id,disabled:!!model.summaryDeletion
  });
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',width:'18',height:'18',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(key,value);
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d','M9 6V4h6v2M4 6h16M6 6l1 14h10l1-14M10 10v6M14 10v6');svg.append(path);
  control.replaceChildren(svg);return control;
}
function updateSummaryDeleteButtons() {
  document.querySelectorAll('.summary-delete').forEach(control=>{
    control.disabled=!!model.summaryDeletion;
    if(model.summaryDeletion?.saving)control.setAttribute('aria-busy','true');else control.removeAttribute('aria-busy');
  });
}
function summaryDeleteContextCurrent(operation) {
  return model.summaryDeletion===operation && !model.switching && model.accountEpoch===operation.epoch &&
    model.state.account?.id===operation.accountId && model.view===operation.view &&
    model.groupId===operation.viewGroupId && model.summary?.id===operation.detailId;
}
function validateSummaryDeletionResult(result,operation) {
  if(!result || result.accountId!==operation.accountId || result.summaryId!==operation.summaryId || result.groupId!==operation.groupId ||
     (!result.deleted&&!result.missing) || !Number.isInteger(result.summaryCount) || result.summaryCount<0)throw new Error('删除结果无法核对，请重新打开摘要列表检查。');
}
function applySummaryDeletion(result,operation) {
  validateSummaryDeletionResult(result,operation);
  const sameView=summaryDeleteContextCurrent(operation);
  if(model.accountEpoch!==operation.epoch || model.state.account?.id!==operation.accountId)return;
  model.summaries=model.summaries.filter(s=>s.id!==operation.summaryId);
  model.state.stats.summaries=result.summaryCount;
  if(model.summary?.id===operation.summaryId)model.summary=null;
  if(model.aiRequest?.accountId===operation.accountId && model.aiRequest.summary?.id===operation.summaryId)model.aiRequest=null;
  renderSidebar();renderHeader();
  if(model.view==='summaries'&&!model.summary){
    renderSummaries();renderInspector();
    const scroll=$('workspace-content').querySelector('.content-scroll');
    if(scroll)scroll.scrollTop=operation.scrollTop;
    if(sameView){
      const choices=[...document.querySelectorAll('.summary-open')];
      (choices[Math.min(operation.cardIndex,choices.length-1)] || $('workspace-content').querySelector('.empty-actions button'))?.focus({preventScroll:true});
    }
  }
  toast(result.deleted?'摘要已从本机删除。':'这份摘要已不存在，列表已更新。');
}
async function confirmDeleteSummary(summary,trigger) {
  if(model.summaryDeletion)return;
  const operation={accountId:model.state.account?.id,summaryId:String(summary.id),groupId:String(summary.groupId),
    epoch:model.accountEpoch,view:model.view,viewGroupId:model.groupId,detailId:model.summary?.id,
    scrollTop:$('workspace-content').querySelector('.content-scroll')?.scrollTop||0,
    cardIndex:Math.max(0,[...document.querySelectorAll('.summary-list-card')].indexOf(trigger.closest('.summary-list-card'))),saving:false};
  model.summaryDeletion=operation;updateSummaryDeleteButtons();
  const release=()=>{
    if(model.summaryDeletion===operation)model.summaryDeletion=null;
    updateSummaryDeleteButtons();
  };
  const cancel=()=>{
    if(operation.saving)return;
    const restore=summaryDeleteContextCurrent(operation);closeModal();release();
    if(restore&&trigger.isConnected)trigger.focus({preventScroll:true});
  };
  try{
    const preview=await api('summary.delete.preview',{accountId:operation.accountId,summaryId:operation.summaryId,groupId:operation.groupId});
    if(!summaryDeleteContextCurrent(operation)){release();return;}
    if(preview.missing){applySummaryDeletion(preview,operation);release();return;}
    if(preview.accountId!==operation.accountId || preview.summaryId!==operation.summaryId || preview.groupId!==operation.groupId || typeof preview.confirmationToken!=='string')throw new Error('无法核对所选摘要，请重新打开列表。');
    const warning=node('p',{id:'summary-delete-warning',class:'form-description'},'仅删除这份本地摘要，不影响聊天记录、收藏或已经导出的 Notion 页面。删除后无法撤销。');
    const status=node('p',{id:'summary-delete-status',class:'caption',role:'status','aria-live':'polite',hidden:true});
    const confirm=button('删除摘要',async()=>{
      if(operation.saving)return;
      if(!summaryDeleteContextCurrent(operation)){cancel();throw new Error('当前工作区或摘要视图已变化，请重新选择要删除的摘要。');}
      operation.saving=true;updateSummaryDeleteButtons();
      const controls=[confirm,$('summary-delete-cancel'),$('modal').querySelector('.modal-head button')].filter(Boolean);
      controls.forEach(control=>control.disabled=true);confirm.setAttribute('aria-busy','true');
      status.hidden=false;status.textContent='正在删除本地摘要…';$('modal-error')?.remove();
      try{
        const result=await api('summary.delete',{accountId:operation.accountId,summaryId:operation.summaryId,groupId:operation.groupId,confirmationToken:preview.confirmationToken,confirmed:true});
        validateSummaryDeletionResult(result,operation);
        closeModal();try{applySummaryDeletion(result,operation);}finally{release();}
      }catch(error){
        status.textContent='未能确认删除结果。请关闭后重新打开摘要列表检查，再决定是否重试。';
        reportError(error);
        // A confirmation is single-use; a new preview is required before retrying.
        confirm.dataset.used='true';
        if(!$('modal').open || $('modal').dataset.context!=='summary-delete')release();
      }finally{
        operation.saving=false;controls.forEach(control=>control.disabled=false);
        confirm.disabled=confirm.dataset.used==='true';confirm.removeAttribute('aria-busy');updateSummaryDeleteButtons();
      }
    },'danger',{id:'summary-delete-confirm'});
    const dialog=modal('删除摘要？',node('div',{},node('p',{class:'summary-delete-title'},preview.title),warning,status),[confirm],{onClose:cancel});
    dialog.setAttribute('data-context','summary-delete');
    const cancelButton=$('modal-close');cancelButton.id='summary-delete-cancel';cancelButton.focus();
  }catch(error){release();throw error;}
}
function summaryText(body, refs) {const fragment=document.createDocumentFragment();const regex=/\[(M\d+)\]/g;let previous=0;for(const match of String(body||'').matchAll(regex)){fragment.append(document.createTextNode(String(body).slice(previous,match.index)));const ref=refs.find(r=>r.label===match[1]) || refs[Number(match[1].slice(1))-1];if(ref)fragment.append(button(`[${match[1]}]`,()=>jumpToMessage(ref),'citation',{'aria-label':`查看原文引用 ${match[1]}`}));else fragment.append(document.createTextNode(match[0]));previous=match.index+match[0].length;}fragment.append(document.createTextNode(String(body||'').slice(previous)));return fragment;}
function renderSummary() {
  const s=model.summary;if(!s)return renderSummaries();const refs=s.refs || [];
  const doc=node('article',{class:'summary-document','data-summary-id':s.id},node('div',{class:'document-overline'},button('← 所有摘要',()=>{model.summary=null;renderHeader();renderSummaries();renderInspector();},'text small'),node('div',{class:'document-summary-actions'},node('span',{class:'live-badge'},s.mode==='local'?'本地摘录 · 无联网':'AI 摘要 · 请核对原文'),summaryDeleteButton(s))),node('h2',{class:'document-title'},s.title),node('div',{class:'document-meta'},`${groupName(s.groupId)}\n${fmt(s.start,true)} — ${fmt(s.end,true)}（结束不含）\n生成于 ${fmt(s.createdAt,true)} · ${refs.length} 条原文引用`),s.warning?node('div',{class:'warning'},noteText(s.warning)):null,node('div',{class:'summary-body'},summaryText(s.body,refs)),node('section',{class:'reference-list'},node('h3',{},'回到原始对话'),...refs.map((r,i)=>node('button',{class:'reference-item',onclick:()=>void run('jump-reference',()=>jumpToMessage(r))},node('span',{class:'reference-number'},r.label || `M${i+1}`),node('div',{class:'reference-copy'},node('p',{},r.text || '查看消息'),node('small',{},`${fmt(r.time,true)}　查看原文 ↗`))))));
  if(s.contentScope){
    const scope=s.contentScope,omissions=Array.isArray(scope.omissions)?scope.omissions:[];
    const details=node('details',{class:'summary-content-scope'},
      node('summary',{},`本次发送范围：${scope.messageCount||0} 条消息 · ${scope.postCount||0} 条微博正文 · ${scope.imageCount||0} 张图片 · ${omissions.length} 项缺失`),
      node('p',{class:'caption'},scope.vision?.reason||'按确认时的内容范围生成。'),
      omissions.length?node('div',{class:'preview-blocks'},...omissions.map(item=>node('p',{},`${item.label||item.messageId||''} ${item.reason||'内容未提供'}`))):null);
    doc.insertBefore(details,doc.querySelector('.summary-body'));
  }
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
  let saving=false;
  const title=node('input',{id:'notion-edit-title',value:draft.title,maxlength:titleLimit,oninput:event=>{draft.title=event.target.value;updateSend();}});
  const body=node('textarea',{id:'notion-edit-body',class:'notion-body-editor',value:draft.body,maxlength:bodyLimit,rows:12,oninput:event=>{draft.body=event.target.value;updateCount();}});
  const count=node('small',{id:'notion-edit-count',class:'caption'});
  const referencePreview=node('details',{id:'notion-reference-preview',hidden:!draft.includeReferences},node('summary',{},'查看将附加的引用原文与本地定位'),node('div',{class:'preview-blocks'},preview.referencesText || '没有可附加的原文引用。'));
  const include=check('引用原文与本地定位',draft.includeReferences,enabled=>{draft.includeReferences=enabled;referencePreview.hidden=!enabled;},{id:'notion-include-references'});
  const status=node('p',{id:'notion-submit-status',class:'caption',role:'status','aria-live':'polite',hidden:true});
  const send=button('确认导出到 Notion',async()=>{
    if(saving)return;
    if(!draft.title.trim())throw new Error('请填写页面标题。');
    saving=true;updateSend();status.hidden=false;status.textContent='正在导出到 Notion，请稍候…';
    const fields=[title,body,include.querySelector('input')];fields.forEach(field=>field.disabled=true);
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
  function updateSend(){send.disabled=saving || !draft.title.trim();send.textContent=saving?'正在导出…':'确认导出到 Notion';}
  function updateCount(){count.textContent=`正文 ${draft.body.length.toLocaleString()} / ${bodyLimit.toLocaleString()} 字符`;}
  updateCount();updateSend();
  modal('编辑 Notion 导出预览',node('div',{},node('p',{id:'notion-export-target',class:'form-description'},`目标：${targetTitle}\n${preview.resumeNotice?'将继续此目标下未完成的原页面。':'将以以下标题新建子页面，编辑仅用于本次导出。'}\n点击“确认导出到 Notion”会立即提交以下编辑内容。`),preview.contextText?node('div',{id:'notion-export-context',class:'notion-export-context'},preview.contextText):null,preview.resumeNotice?node('p',{id:'notion-resume-notice',class:'warning',role:'status'},preview.resumeNotice):null,field('页面标题',title),field('导出正文',body),count,node('p',{class:'caption'},'页面会附加导出标识，以便识别重复导出。'),node('div',{class:'notion-reference-option'},include,node('p',{class:'caption'},'取消勾选仅移除附加的原文与定位，保留你编辑的正文。'),referencePreview),status),[send],{onClose:()=>{if(!saving)closeModal();}});
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
    node('div',{class:'form-section'},node('h3',{},'主题与外观颜色'),node('p',{class:'form-description'},'选择界面主题，或独立调整聊天背景、成员昵称与消息框颜色；仅影响当前账号。'),button('编辑主题与颜色',()=>showAppearanceSettings(draft),'full',{id:'configure-appearance',disabled:!accountId})),
    node('div',{class:'form-section'},node('h3',{},'Notion 连接'),node('p',{class:'form-description'},'使用你自己的 Notion integration，并在 Notion 页面中授予它访问权限。保存设置不会写入任何页面。'),field('Integration token',notionToken,creds.notion?'已保存的 Token 留空保持不变。':null)),
    node('div',{class:'form-section'},check('清除当前账号保存的 AI 与 Notion 凭据',draft.deleteSecrets,value=>draft.deleteSecrets=value,{id:'delete-secrets'})),
    node('div',{class:'source-note'},'没有后台定时发送。只有点击并确认 AI 总结或 Notion 导出后，选定内容才会发送到对应服务。'),
    node('div',{class:'form-section'},node('h3',{},'本地数据'),node('p',{class:'caption'},'按群和北京时间筛选，先预览保留规则，再将消息移入可恢复的本地回收区。'),button('管理本地消息与回收区',()=>{draft.notionToken='';notionToken.value='';return showMessageCleanup();},'full',{id:'manage-local-data'})),
    accountKind()==='weibo'?node('div',{class:'form-section'},button('退出微博网页登录',async()=>{await api('logout');draft.notionToken='';notionToken.value='';closeModal();await refreshState();renderInspector();toast('已退出微博会话。本机保存的记录仍然保留。');},'danger')):null);
  if(model.state.credentialError)body.append(node('div',{class:'warning'},model.state.credentialError),check('重新初始化无法解密的旧凭据（需要重新登录微博）',draft.resetUnreadable,value=>draft.resetUnreadable=value));
  modal('设置与连接',body,[button('保存设置',async()=>{
    model.state=await api('settings.save',{notionToken:notionToken.value,deleteSecrets:draft.deleteSecrets,resetUnreadable:draft.resetUnreadable});
    draft.notionToken='';notionToken.value='';closeModal();renderSidebar();renderHeader();renderInspector();toast('设置已保存在本机。');
  },'primary',{id:'save-settings'})],{onClose:()=>{draft.notionToken='';notionToken.value='';closeModal();}});
}
function showAppearanceSettings(settingsDraft) {
  const accountId=model.state.account?.id,epoch=model.accountEpoch;
  return window.WeiyueAppearanceSettings.open({api,node,button,modal,toast,appearance:model.state.settings.appearance,interfaceTheme:model.state.settings.interfaceTheme,accountId,
    isCurrent:()=>accountId===model.state.account?.id && epoch===model.accountEpoch && !model.switching && !model.closing,
    onBack:()=>showSettings(settingsDraft),
    onSaved:state=>{if(state.account?.id!==accountId)throw new Error('账号已切换，外观结果未应用。');model.state.settings.appearance=appearance.normalizeAppearance(state.settings?.appearance);model.state.settings.interfaceTheme=window.WeiyueInterfaceTheme.normalizeTheme(state.settings?.interfaceTheme);applyAppearance(model.state.settings.appearance);window.WeiyueInterfaceTheme.apply(document.body,model.state.settings.interfaceTheme);}
  });
}
function cleanupWorkActive(){return model.cleanupOperation?.running===true;}
function renderCleanupProgress(){
  const host=$('cleanup-progress'),operation=model.cleanupOperation;
  if(!host)return;
  if(!operation||operation.accountId!==model.state.account?.id){host.hidden=true;return;}
  const text=window.WeiyueCleanupProgress.describe(operation.status);
  host.hidden=false;host.dataset.phase=operation.status.phase;host.dataset.running=String(operation.running);
  host.dataset.kind=operation.kind;host.dataset.groupId=operation.groupId;
  const actions=[];
  if(operation.refreshError)actions.push(button('重试刷新',()=>refreshCleanupOutcome(operation),'small',{id:'cleanup-progress-retry'}));
  if(!operation.running)actions.push(button('收起',()=>{if(model.cleanupOperation===operation){model.cleanupOperation=null;renderCleanupProgress();}},'text small',{id:'cleanup-progress-dismiss'}));
  host.replaceChildren(node('div',{class:'cleanup-progress-copy'},node('span',{id:'cleanup-progress-label'},`${groupName(operation.groupId)} · ${text.label}`),node('span',{id:'cleanup-progress-detail'},text.detail)),node('div',{class:'cleanup-progress-actions'},actions));
}
async function refreshCleanupOutcome(operation){
  if(operation.accountId!==model.state.account?.id||model.closing)return;
  // Completion reconciles the *current* view using fresh reads. Even after a user
  // switches away and back, no old state/result payload is installed in this view.
  const epoch=model.accountEpoch,groupId=model.groupId,view=model.view;
  const current=()=>operation.accountId===model.state.account?.id&&epoch===model.accountEpoch&&groupId===model.groupId&&view===model.view&&!model.closing;
  operation.refreshError=false;operation.status={...operation.status,phase:'refreshing',running:false,detail:'正在刷新本地消息与分页数量。'};renderCleanupProgress();
  try{
    await refreshState({background:true});if(!current())return;
    if(view==='read'&&groupId===operation.groupId){
      // Let a real drag, selection/read commit or IME composition finish. A data
      // result is never itself reading intent, and does not cancel user input.
      while(current()&&(readingBusy()||model.restoring||model.refreshRunning))await new Promise(resolve=>setTimeout(resolve,80));
      if(!current())return;
      const anchor=captureViewport()||model.viewport,previous=model.messages.map(message=>String(message.id));
      const pivot=Math.max(0,previous.indexOf(anchor?.anchorId));
      const candidates=[];for(let step=1;step<=4;step++){if(previous[pivot+step])candidates.push(previous[pivot+step]);if(previous[pivot-step])candidates.push(previous[pivot-step]);}
      const version=++model.queryVersion,filterKey=JSON.stringify(model.filters);autoPage.reset();invalidateReadingIntent();model.refreshRunning=true;
      const active=()=>current()&&version===model.queryVersion&&filterKey===JSON.stringify(model.filters);
      try{
        const [result,members,boundary]=await Promise.all([
          window.WeiyueCleanupProgress.queryCleanedWindow({query:payload=>api('messages.query',payload),payload:queryPayload(),anchor,candidates,active}),
          api('members.list',{groupId}),locateReadBoundary(groupId,model.state.readStates?.[groupId]?.readThroughId)
        ]);
        if(!active())return;
        model.readBoundary=boundary;model.offset=result.offset;model.total=result.total;model.messages=result.messages;model.members=members||[];
        const surviving=new Set(model.messages.map(message=>String(message.id)));model.selected=new Set([...model.selected].filter(id=>surviving.has(String(id))));
        model.preview=null;model.inspected=null;
        const rendered=model.renderedReading,ownsDOM=rendered&&rendered.accountId===model.state.account?.id&&rendered.epoch===epoch&&rendered.groupId===groupId&&$('message-scroll');
        if(ownsDOM){model.renderedReading={...rendered,version,filtered:hasFilters()};patchMessageList(model.messages,result.anchor);}
        else{renderReading();restoreViewport(result.anchor);watchMessageSizes();}
        if(isSearchEditorCurrent(model.searchEditor))updateSearchMembers(model.searchEditor);
        updateSelection();updateReadChrome();renderInspector();
        if(anchor?.anchorId&&!result.anchor)operation.status.detail='清理已完成；原临时定位不在筛选结果中，已显示邻近可用消息。';
      }finally{model.refreshRunning=false;scheduleReadingRefresh();}
    }
    if(current()){renderSidebar();renderHeader();}
    operation.status={...operation.status,phase:'completed',detail:operation.success};
  }catch(error){
    if(current()){
      operation.refreshError=true;operation.status={...operation.status,phase:'completed',detail:'数据操作已完成，但界面刷新失败。可重试刷新；不会再次删除。'};
    }
  }finally{
    if(operation.status.phase==='refreshing')operation.status={...operation.status,phase:'completed',detail:operation.success};
    renderCleanupProgress();
  }
}
async function performCleanupOperation(spec){
  if(cleanupWorkActive()||model.cleanupStarting)throw new Error('本地数据操作正在进行，请等待完成。');
  if(spec.accountId!==model.state.account?.id||model.closing)throw new Error('账号已变化，请重新打开本地数据管理。');
  model.cleanupStarting=true;
  try{await flushReading(false);if(spec.accountId!==model.state.account?.id||model.closing)throw new Error('账号已变化，尚未提交清理。');}
  catch(error){model.cleanupStarting=false;throw error;}
  const operation={...spec,epoch:model.accountEpoch,running:true,polling:false,refreshError:false,
    status:{kind:spec.kind,phase:'submitting',processed:null,total:null,running:true,detail:'正在提交；确认成功后才更新消息列表。'}};
  model.cleanupOperation=operation;model.cleanupStarting=false;invalidateReadingIntent();autoPage.reset();
  const rendered=model.renderedReading,currentRendered=rendered&&rendered.accountId===model.state.account?.id&&rendered.epoch===model.accountEpoch&&rendered.groupId===model.groupId&&rendered.version===model.queryVersion;
  model.queryVersion++;if(currentRendered)model.renderedReading={...rendered,version:model.queryVersion};
  spec.onStarted();renderCleanupProgress();renderSyncStatus();
  const poll=async()=>{
    if(!operation.running||operation.polling||model.closing||operation.accountId!==model.state.account?.id)return;
    operation.polling=true;
    try{
      const status=await window.api.call('messages.cleanup.status',{accountId:operation.accountId});
      if(operation.running&&status?.accountId===operation.accountId&&status.groupId===operation.groupId&&status.kind===operation.kind&&status.jobId){
        operation.status={...status};if(model.cleanupOperation===operation)renderCleanupProgress();
      }
    }catch{/* The final apply Promise is authoritative; polling cannot invent failure. */}
    finally{operation.polling=false;}
  };
  const timer=setInterval(()=>void poll(),350);
  try{
    // Fixed account payload and raw bridge keep an old job's final result from
    // being mistaken for a failure merely because the visible account changed.
    const result=await window.api.call(spec.action,spec.payload);
    const count=spec.kind==='restore'?result?.restoredCount:spec.kind==='purge'?result?.purgedCount:result?.deletedCount;
    const applied=spec.kind==='restore'?result?.restored===true:spec.kind==='purge'?result?.purged===true:result?.deleted===true;
    if(result?.accountId!==spec.accountId||result.groupId!==spec.groupId||!applied||count!==spec.total){
      operation.status={kind:spec.kind,phase:'uncertain',running:false,detail:'返回结果无法核对，操作结果待核实。请重新打开本地数据管理检查，勿重复提交。'};
      operation.uncertain=true;return;
    }
    operation.result=result;operation.running=false;operation.status={kind:spec.kind,phase:'completed',processed:count,total:count,running:false,detail:spec.success};
    await refreshCleanupOutcome(operation);
  }catch(error){
    let status=null;
    try{if(operation.accountId===model.state.account?.id)status=await window.api.call('messages.cleanup.status',{accountId:operation.accountId});}catch{}
    const confirmedFailure=status?.accountId===operation.accountId&&status.groupId===operation.groupId&&status.kind===operation.kind&&status.phase==='failed'&&status.commitState==='not-committed';
    operation.status={kind:spec.kind,phase:confirmedFailure?'failed':'uncertain',running:false,detail:confirmedFailure?`${status.error||error.message} 当前操作未提交，原数据保持。`:`${error.message} 结果尚待核实，请检查本地数据管理，勿重复提交。`};
  }finally{
    clearInterval(timer);operation.running=false;renderCleanupProgress();renderSyncStatus();
    model.syncRevision=null;scheduleReadingRefresh();
  }
}
async function showMessageCleanup(){
  if(cleanupWorkActive()||model.cleanupStarting)throw new Error('本地数据操作正在进行，进度显示在中间栏。');
  const accountId=model.state.account?.id,epoch=model.accountEpoch;
  await flushReading(false);
  return window.WeiyueCleanup.open({api,node,button,field,check,modal,closeModal,toast,filters,accountId,groups:model.state.groups,groupId:model.groupId,
    isCurrent:()=>accountId===model.state.account?.id&&epoch===model.accountEpoch&&!model.closing,performOperation:performCleanupOperation});
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
  const visionSelect=node('select',{id:'ai-vision-mode','aria-label':'图片理解能力'},
    node('option',{value:'auto',selected:!settings.aiVisionMode||settings.aiVisionMode==='auto'},'自动识别已知官方视觉模型'),
    node('option',{value:'enabled',selected:settings.aiVisionMode==='enabled'},'我确认此模型支持兼容协议的图片输入'),
    node('option',{value:'disabled',selected:settings.aiVisionMode==='disabled'},'仅发送文本，不发送图片'));
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
    const payload={providerId,endpoint:targetEndpoint(),model:modelInput.value.trim(),aiVisionMode:visionSelect.value,aiKey:aiKey.value.trim(),keyAction:aiKey.value.trim()?'replace':'keep'};
    saving=true;updateSave();
    const controls=[providerSelect,aiKey,modelInput,visionSelect,endpoint,toggle,$('modal-close'),dialog.querySelector('.modal-head button')].filter(Boolean);controls.forEach(control=>control.disabled=true);
    try{
      model.state=await api('settings.ai.save',payload);clearTypedKey();saving=false;renderInspector();showSettings(settingsDraft);toast('AI 模型配置已保存在本机，尚未发送请求。');
    }catch(error){reportError(error);}
    finally{saving=false;controls.forEach(control=>control.disabled=false);updateSave();}
  },'primary',{id:'save-ai-config',disabled:true});
  providerSelect.addEventListener('change',()=>{if(selectedProvider()?.custom)customEndpoint=endpoint.value;providerId=providerSelect.value;endpoint.value=customEndpoint;visionSelect.value='auto';clearTypedKey();updateProvider();});
  endpoint.addEventListener('input',()=>{customEndpoint=endpoint.value;visionSelect.value='auto';clearTypedKey();updateSave();});
  aiKey.addEventListener('input',()=>{if(!aiKey.value)hideTypedKey();updateSave();});
  modelInput.addEventListener('input',()=>{visionSelect.value='auto';updateSave();});
  const body=node('div',{class:'ai-config-fields'},field('模型厂商',providerSelect),address,notice,customField,
    node('div',{class:'field'},node('label',{for:'ai-key'},'API Key'),node('div',{class:'ai-key-field'},aiKey,toggle),keyHint),
    field('模型名称',modelInput,'使用该服务支持的 API 模型名称，可自由填写。'),
    field('图片理解能力',visionSelect,'仅支持 Chat Completions 兼容协议的 image_url 输入。未知服务或模型不会自动发送图片；请先查服务商说明再选择确认支持。图片可能额外计费，保存不会发送测试请求。'));
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
  const body=node('div',{},node('p',{class:'form-description'},accountKind()==='weibo'?'只同步你勾选且有权访问的群聊。新消息定期检查，离线缺口分批续补，可暂停或手动继续。“更早历史”只读取本机最早记录之前的消息。':'选择在侧栏显示的本地群聊。隐藏群聊不会删除已保存的数据。'),...model.state.groups.map(g=>node('label',{class:'group-choice'},node('input',{type:'checkbox',checked:selected.has(String(g.id)),onchange:e=>{if(e.target.checked)selected.add(String(g.id));else selected.delete(String(g.id));}}),node('span',{class:'group-avatar'},String(g.name||'群').slice(0,1)),node('span',{class:'group-choice-copy'},g.name,node('small',{},g.coverage?.note || (g.coverage?.newest?`最近记录 ${fmt(g.coverage.newest,true)}`:'尚未同步记录'))))));
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

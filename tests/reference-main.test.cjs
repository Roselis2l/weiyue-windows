'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {Store}=require('../app/core/store.cjs');
const {safeImageUrl}=require('../app/core/media.cjs');
const {normalizeSource}=require('../app/core/image-viewer.cjs');
const editionPolicy=require('../app/core/edition-policy.cjs');
const {BoundedMediaCache}=require('../app/core/bounded-media-cache.cjs');
const main=fs.readFileSync(path.join(__dirname,'../app/main.cjs'),'utf8');
function section(start,end){const a=main.indexOf(start),b=main.indexOf(end,a);assert.ok(a>=0&&b>a);return main.slice(a,b);}
const decorate=section('const mediaToken=','// net.request');
const serve=section('async function serveImage(','function attachmentRecord(');
const dispatch=section('async function handle(','async function start(');
const observe=section('function observeContent(','function setActive(');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGpsAAAAASUVORK5CYII=','base64');
const plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;return{promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const source=(part='reference-0',index='0',variant='original',token=crypto.createHash('sha256').update('synthetic-one').digest('hex').slice(0,32))=>
  `app://media/${token}/group/message/${part}/${index}/${variant}`;
function fixture({fetch}={}){
  const reference=(id)=>({kind:'post',relation:'repost',id:String(id),url:'https://m.weibo.cn/detail/'+id,
    text:'合成引用 [哈哈]',state:'ready',images:[{url:`https://wx1.sinaimg.cn/original/${id}.png`,originalUrl:`https://wx1.sinaimg.cn/original/${id}.png`,thumbnailUrl:`https://wx1.sinaimg.cn/preview/${id}.png`}]});
  const message={id:'message',groupId:'group',senderId:'member',senderName:'合成成员',text:'原始消息【哈哈】',time:1792544400000,referenceVersion:1,
    references:Array.from({length:20},(_,i)=>reference(i+100)),images:[{url:'https://wx1.sinaimg.cn/own.png'}],sharedPost:{state:'ready',text:'主帖',images:[{url:'https://wx1.sinaimg.cn/post.png'}]}};
  const state={account:{id:'synthetic-one',name:'合成账号',kind:'import'},messages:[message],bookmarks:[],summaries:[],exports:{}};
  const requested=[];
  const closed={images:0,attachments:0,downloads:0};
  const scope={crypto,activeId:'synthetic-one',accountEpoch:0,mediaEpoch:0,contentRevision:0,revision:0,observedContent:new Map(),store:{get:id=>{assert.equal(id,scope.activeId);return state;},getSnapshot:id=>{assert.equal(id,scope.activeId);return state;},getVisibleSnapshot:id=>{assert.equal(id,scope.activeId);return editionPolicy.projectAccount(state);},contentEpoch:()=>editionPolicy.contentEpoch(state)},Response,URL,AbortController,
    imageViewer:{closeAll:()=>closed.images++},attachmentViewer:{closeAll:()=>closed.attachments++},attachmentDownload:{cancelAll:()=>closed.downloads++},activeAi:null,aiPreviews:new Map(),summaryDeletePreviews:new Map(),
    safeImageUrl,session:{defaultSession:{}},imageCache:new Map(),imageJobs:new Map(),attachmentCache:new BoundedMediaCache(64*1024*1024),cachedImageBytes:0,activeImages:0,imageWaiters:[],
    fetchImage:async options=>{requested.push(options.url);return fetch?fetch(options):{bytes:png,mime:'image/png'};},accountSession:()=>{throw new Error('No real session');},imageRequest(){throw new Error('No real network');},closing:()=>false,
    heifDecoder:null,createHeifDecoder:()=>{throw new Error('No HEIC fixture');},BrowserWindow:class{},ipcMain:{},__dirname:path.resolve(__dirname,'../app'),avatars:{source:()=>undefined}};
  vm.createContext(scope);vm.runInContext(observe+decorate+serve+';globalThis.decorate=decorateMessage;globalThis.serve=serveImage;',scope);
  return{scope,state,message,requested,closed,read:(url,original=false)=>scope.serve({method:'GET'},new URL(url),original)};
}

test('actual DTO assigns opaque account/message scoped sources independently to every reference image',()=>{
  const f=fixture(),before=JSON.stringify(f.message),dto=f.scope.decorate(f.message);
  for(const n of [0,9,10,19]){
    assert.equal(dto.references[n].images[0].originalSrc,source('reference-'+n));
    assert.equal(dto.references[n].images[0].src,source('reference-'+n,'0','preview'));
    assert.equal(dto.references[n].url,'https://m.weibo.cn/detail/'+(100+n));
  }
  assert.equal(dto.images[0].originalSrc,source('message'));assert.equal(dto.sharedPost.images[0].originalSrc,source('post'));
  assert.equal(JSON.stringify(f.message),before,'proxy decoration must not change persisted raw metadata');
  const elsewhere=f.scope.decorate(f.message,'synthetic-two');assert.notEqual(elsewhere.references[0].images[0].src,dto.references[0].images[0].src);
});
test('actual image viewer validator accepts only canonical reference indices 0–19 and original variants',()=>{
  for(let i=0;i<20;i++)assert.equal(normalizeSource(source('reference-'+i)),source('reference-'+i));
  for(const url of [source('reference-20'),source('reference-00'),source('reference--1'),source('reference-1e1'),source('reference-0/extra'),source('reference-0','1000'),source('reference-0','0','preview'),source()+'?url=https://outside.invalid/private',source().replace('app://media','https://media'),source().replace('app://media','app://user@media')])assert.equal(normalizeSource(url),null,url);
});
test('main resolves reference preview/original from stored matching section, never a renderer URL or another image',async()=>{
  const f=fixture();
  assert.equal((await f.read(source('reference-19','0','preview'))).status,200);
  assert.equal((await f.read(source('reference-0'))).status,200);
  assert.deepEqual(f.requested,['https://wx1.sinaimg.cn/preview/119.png','https://wx1.sinaimg.cn/original/100.png']);
  const original=await f.read(source('reference-19'),true);assert.equal(original.mime,'image/png');assert.deepEqual(original.bytes,png);
  assert.equal(f.requested.at(-1),'https://wx1.sinaimg.cn/original/119.png');
});
test('reference ordinal bounds and missing image never fall back to message or parent post photos',async()=>{
  const f=fixture();
  for(const url of [source('reference-20'),source('reference-00'),source('reference--1'),source('reference-0','1'),source('reference-19','999'),source('reference-0').replace('/group/','/another-group/'),source('reference-0').replace('/message/','/another-message/')])assert.equal((await f.read(url)).status,404,url);
  assert.deepEqual(f.requested,[]);
});
test('wrong account token and soft-deleted message block reference media even when an identical resource was cached',async()=>{
  const f=fixture();assert.equal((await f.read(source())).status,200);assert.equal(f.requested.length,1);
  const wrong=source('reference-0','0','original',crypto.createHash('sha256').update('synthetic-two').digest('hex').slice(0,32));
  assert.equal((await f.read(wrong)).status,404);
  f.message.localDeletion={batchId:'synthetic-batch',deletedAt:Date.now()};assert.equal((await f.read(source())).status,404);assert.equal(f.requested.length,1);
});
test('account change while a reference image is loading suppresses the late response and cache',async()=>{
  const gate=deferred(),f=fixture({fetch:()=>gate.promise});const work=f.read(source());await tick();
  f.scope.accountEpoch++;f.scope.mediaEpoch++;f.scope.activeId='synthetic-two';for(const job of f.scope.imageJobs.values())job.controller.abort();
  gate.resolve({bytes:png,mime:'image/png'});
  assert.equal((await work).status,502);assert.equal(f.scope.imageCache.size,0);assert.equal(f.scope.imageJobs.size,0);assert.equal(f.scope.activeImages,0);
});
test('a malicious stored reference image fails the same safe host check before transport',async()=>{
  const f=fixture();f.message.references[0].images=[{url:'https://wx1.sinaimg.cn.evil.invalid/private.png'}];
  assert.equal((await f.read(source())).status,404);assert.deepEqual(f.requested,[]);
});

test('public withdrawal removes cached referenced, shared-post and own image access consistently',async()=>{
  const f=fixture();for(const part of ['reference-0','post','message'])assert.equal((await f.read(source(part))).status,200);
  assert.equal(f.requested.length,3);f.message.recall={state:'withdrawn',protocol:'weibo-group-344',observedAt:1793000000000};
  for(const part of ['reference-0','post','message'])assert.equal((await f.read(source(part))).status,404);
  assert.equal(f.requested.length,3);assert.equal(f.scope.mediaEpoch,1);assert.deepEqual(f.closed,{images:1,attachments:1,downloads:1});
});
test('a withdrawal during referenced-image retrieval aborts delivery and leaves no readable cached bytes',async()=>{
  const gate=deferred(),f=fixture({fetch:()=>gate.promise});const work=f.read(source());await tick();
  f.message.recall={state:'withdrawn',protocol:'weibo-group-344',observedAt:1793000000000};f.scope.observeContent();gate.resolve({bytes:png,mime:'image/png'});
  assert.equal((await work).status,502);assert.equal(f.scope.imageCache.size,0);assert.equal(f.scope.imageJobs.size,0);assert.equal(f.closed.images,1);
});

test('opening an image stops the previous video preview before creating the image window',async()=>{
  const calls=[],scope={activeId:'synthetic-account',busy:false,cleanupBusy:()=>false,
    attachmentViewer:{closeAll:()=>calls.push('stop-video')},
    imageViewer:{open:async value=>{calls.push('open-image');assert.equal(value.source,'synthetic-image');return {opened:true};}}};
  vm.createContext(scope);vm.runInContext(dispatch+';globalThis.dispatch=handle;',scope);
  assert.equal((await scope.dispatch('image.open',{source:'synthetic-image'})).opened,true);
  assert.deepEqual(calls,['stop-video','open-image']);
});

test('opening a validated attachment closes the image preview and delegates video replacement to its viewer',async()=>{
  const calls=[],scope={activeId:'synthetic-account',busy:false,cleanupBusy:()=>false,
    attachmentRecord:source=>{calls.push('validate');if(source!=='valid')throw Error('invalid');return {attachment:{name:'Synthetic clip',kind:'video'}};},
    imageViewer:{closeAll:()=>calls.push('close-image')},
    attachmentViewer:{open:async value=>{calls.push('open-video');assert.equal(value.kind,'video');return {opened:true};}}};
  vm.createContext(scope);vm.runInContext(dispatch+';globalThis.dispatch=handle;',scope);
  await assert.rejects(scope.dispatch('attachment.open',{source:'invalid'}),/invalid/);
  assert.deepEqual(calls,['validate']);calls.length=0;
  assert.equal((await scope.dispatch('attachment.open',{source:'valid'})).opened,true);
  assert.deepEqual(calls,['validate','close-image','open-video']);
});
test('real import, persistence, bookmark JSON export and re-import preserve canonical references and original text',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-reference-import-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new Store(path.join(root,'accounts'));store.ensureAccount({id:'before',name:'合成起始账号',kind:'import'});
  const f=fixture(),file=path.join(root,'synthetic-reference-input.json'),data={groups:[{id:'group',name:'合成引用群'}],messages:[f.message]};
  fs.writeFileSync(file,JSON.stringify(data));const saved=[];
  const scope={activeId:'before',busy:false,cleanupBusy:()=>false,store,dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[file]})},fs,path,crypto,win:null,
    setActive:id=>{scope.activeId=id;},snapshot:()=>({account:store.account(scope.activeId)}),saveText:async(name,body,extensions)=>{saved.push({name,body,extensions});return{path:'synthetic-output'};}};
  vm.createContext(scope);vm.runInContext(dispatch+';globalThis.dispatch=handle;',scope);
  const imported=await scope.dispatch('import',{});assert.equal(imported.count,1);assert.notEqual(scope.activeId,'before');assert.equal(scope.busy,false);
  const importedId=scope.activeId;store.bookmark(importedId,{groupId:'group',messageIds:['message'],note:'引用回查',tags:['合成']});
  await scope.dispatch('export.bookmarks',{format:'json'});const exported=JSON.parse(saved[0].body);
  assert.equal(exported[0].messages[0].text,f.message.text);assert.deepEqual(exported[0].messages[0].references,plain(f.message.references));
  assert.equal(exported[0].messages[0].references[0].images[0].src,undefined,'export metadata must not depend on an old account proxy token');
  const reopened=new Store(path.join(root,'accounts'));assert.deepEqual(reopened.get(importedId).messages[0].references,plain(f.message.references));
  reopened.ensureAccount({id:'round-trip',name:'再次导入合成账号',kind:'import'});reopened.importData('round-trip',{groups:data.groups,messages:exported[0].messages});
  assert.deepEqual(reopened.get('round-trip').messages[0].references,plain(f.message.references));
  assert.equal(reopened.get('before').messages.length,0);
});
test('actual renderer passes reference messages through the tested safe helper without inventing quoted-text targets',()=>{
  const renderer=fs.readFileSync(path.join(__dirname,'../app/renderer/app.js'),'utf8');
  const a=renderer.indexOf('function renderMessageContent('),b=renderer.indexOf('async function enrichMessages(',a);assert.ok(a>=0&&b>a);
  const calls=[];
  const node=(tag,attrs,...children)=>({tag,attrs,children,classList:{add(){}},append(...items){children.push(...items);}});
  const helper=require('../app/renderer/message-references.js');
  const scope={node,emoticons:{appendText:(element,text)=>{element.append(text);return element;}},imageGallery:(images,message,title)=>{calls.push({images,message,title});return node('gallery',{});},
    links:{createLink:(_doc,url,title)=>url?node('a',{href:url},title):null},window:{WeiyueReferences:helper},document:{},run(){throw new Error('No actions during render');},api(){throw new Error('No actions during render');},
    isNotificationOnly:()=>false,isLegacyShare:()=>false,officialChatButton:()=>node('button',{},'官方页面'),button:()=>node('button',{}),accountKind:()=> 'import'};
  vm.createContext(scope);vm.runInContext(renderer.slice(a,b)+';globalThis.render=renderMessageContent;',scope);
  const msg={id:'synthetic',text:'引用内容',references:fixture().message.references.slice(0,1)};const rendered=scope.render(msg);
  assert.equal(calls.length,1);assert.equal(calls[0].message,msg);assert.equal(calls[0].title,'引用微博配图');
  const card=rendered.children.find(child=>child.attrs?.class==='shared-post referenced-post');assert.ok(card);assert.equal(card.children.at(-1).attrs.href,'https://m.weibo.cn/detail/100');
  const quoted=scope.render({text:'「@同名成员:图片」\n回应',id:'other'});assert.equal(calls.length,1,'plain quoted text must not create or load guessed media');
  assert.equal(quoted.children.some(child=>child.attrs?.class?.includes('quote-image-note')),false,'ordinary quoted words are not evidence of a verified missing image');
  const verified=scope.render({text:'「图片」\n- - - - - - - - - - - - - - -\n合成回应',id:'verified',contextVersion:1,quotePreview:{kind:'image',state:'unavailable',reasonCode:'WEB_REFERENCE_TARGET_UNAVAILABLE'}});
  assert.ok(verified.children.some(child=>child.tag==='p'&&child.children[0].includes('当前网页数据无法确认')));
  assert.equal(calls.length,1,'verified unavailable quote must not load current or guessed images');
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const references=require('../app/renderer/message-references.js');
const source=fs.readFileSync(path.join(__dirname,'../app/renderer/app.js'),'utf8');
const functionSource=source.slice(source.indexOf('function renderMessageContent(message) {'),source.indexOf('\nasync function enrichMessages(',source.indexOf('function renderMessageContent(message) {')));
const contextFunction=source.slice(source.indexOf('function needsMessageContext('),source.indexOf('\nfunction isLegacyShare(',source.indexOf('function needsMessageContext(')));
const preview={kind:'image',state:'unavailable',reasonCode:'WEB_REFERENCE_TARGET_UNAVAILABLE'};
const quote='「图片」\n- - - - - - - - - - - - - - -\n合成回复';
function fixture(){
  const galleryCalls=[],linkCalls=[];
  const node=(tag,attrs={},...children)=>({tag,attrs,children:children.flat().filter(x=>x!==null),classList:{add(value){attrs.class=(attrs.class||'')+' '+value;}},append(...more){this.children.push(...more.flat().filter(x=>x!==null));}});
  const sandbox={node,window:{WeiyueReferences:references},document:{},run(){throw new Error('Rendering must not invoke external actions');},api(){throw new Error('Rendering must not invoke APIs');},
    emoticons:{appendText(element,text){element.append(text);return element;}},imageGallery(images,message,title){galleryCalls.push({images,message,title});return node('gallery',{},title||'current');},
    officialChatButton(){return node('button',{'data-official':true},'官方页面');},isLegacyShare(){return false;},isNotificationOnly(){return false;},accountKind(){return 'demo';},
    links:{createLink(document,url,title){linkCalls.push({url,title});return /^https:\/\/(?:m\.weibo\.cn|weibo\.com)\//.test(url||'')?node('a',{href:url},title):null;}}};
  vm.createContext(sandbox);vm.runInContext(functionSource+'\nthis.renderUnderTest=renderMessageContent;',sandbox);
  return{render:sandbox.renderUnderTest,galleryCalls,linkCalls};
}
function allNodes(root){return typeof root==='object'&&root?[root,...(root.children||[]).flatMap(allNodes)]:[];}
function text(root){return typeof root==='string'?root:(root.children||[]).map(text).join('');}
function quoteNotes(root){return allNodes(root).filter(n=>n.attrs.class?.split(' ').includes('quote-image-note'));}

test('actual renderer uses verified unavailable marker without creating an image or changing message text',()=>{
  const f=fixture(),message={text:'合成正文 <script>原样文本</script>',contextVersion:1,quotePreview:preview};
  const result=f.render(message),notes=quoteNotes(result);
  assert.equal(notes.length,1);assert.equal(text(notes[0]),'当前网页数据无法确认这条引用的原图，暂不能可靠打开。');
  assert.equal(text(result.children[0]),message.text);assert.equal(f.galleryCalls.length,0);assert.equal(f.linkCalls.length,0);
  assert.equal(allNodes(result).filter(n=>n.attrs['data-official']).length,1);
});
test('legacy full quote gets unverified hint; ordinary image words and malformed markers never claim evidence',()=>{
  const f=fixture();const legacy=f.render({text:quote});
  assert.equal(text(quoteNotes(legacy)[0]),'引用图片信息尚未补全，可尝试重新同步。');
  const cases=[{text:'普通正文中「图片」二字'},{text:'「图片」'},{text:'https://example.invalid/「图片」'},{text:quote,contextVersion:1},
    {text:'普通',contextVersion:1,quotePreview:{...preview,state:'ready'}},{text:'普通',contextVersion:1,quotePreview:{...preview,kind:'post'}},
    {text:'普通',contextVersion:1,quotePreview:{...preview,reasonCode:'OTHER'}},{text:'普通',contextVersion:2,quotePreview:preview}];
  for(const message of cases)assert.equal(quoteNotes(f.render(message)).length,0);
});
test('existing current, shared-post and referenced-post images retain exact separate sources alongside quote hint',()=>{
  const f=fixture(),current=[{src:'app://media/current'}],shared=[{src:'app://media/shared'}],original=[{src:'app://media/reference'}];
  const message={id:'91',text:quote,contextVersion:1,quotePreview:preview,images:current,
    sharedPost:{state:'ready',text:'合成微博分享',images:shared,url:'https://m.weibo.cn/detail/17'},
    references:[{kind:'post',relation:'repost',state:'ready',text:'合成引用微博',images:original,url:'https://m.weibo.cn/detail/16'}]};
  const result=f.render(message);
  assert.deepEqual(f.galleryCalls.map(c=>c.images),[current,shared,original]);
  assert.ok(f.galleryCalls.every(c=>c.message===message));
  assert.deepEqual(f.linkCalls.map(c=>c.url),['https://m.weibo.cn/detail/17','https://m.weibo.cn/detail/16']);
  assert.equal(quoteNotes(result).length,1);assert.equal(allNodes(result).filter(n=>n.tag==='a').length,2);
});
test('legacy candidate selection requests evidence once and never classifies from a display name',()=>{
  assert.ok(contextFunction.startsWith('function needsMessageContext('));
  const sandbox={};vm.createContext(sandbox);vm.runInContext(contextFunction+'\nthis.needs=needsMessageContext;',sandbox);
  assert.equal(sandbox.needs({text:quote}),true);assert.equal(sandbox.needs({text:'普通文字',senderName:'粉丝群'}),true);
  assert.equal(sandbox.needs({text:'普通文字',senderName:'普通成员'}),false);assert.equal(sandbox.needs({text:'普通「图片」'}),false);
  assert.equal(sandbox.needs({text:quote,contextVersion:1}),false);assert.equal(sandbox.needs({text:'普通文字',senderName:'粉丝群',contextVersion:1}),false);
  const message={text:'普通文字',senderName:'粉丝群'};sandbox.needs(message);assert.equal(message.systemNotice,undefined);
});

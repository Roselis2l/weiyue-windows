'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const rendererRoot=path.resolve(__dirname,'../app/renderer');
const manifest=require('../app/renderer/emoticon-manifest.js');
const base=require('../app/renderer/emoticons/catalog-manifest.json');
const extension=require('../app/renderer/emoticons/extensions-manifest.json');
const {createEmoticonAssets}=require('../app/core/emoticon-assets.cjs');
const {create}=require('../app/renderer/emoticons.js');
const links=require('../app/renderer/linkify.js');
const requiredNames=['苦涩','流鼻血','老师好','卡皮巴拉','泪奔','无聊','666','淡淡的','送花花','拜托','努力','捂嘴哭','手指比心','呵呵','流汗','融化'];
const requiredPaths=['/ee8192.png','/ee8cb0.png','/ee9092.png','/ee808e.png','/ee819a.png','/ee858c.png','/ee88a6.png','/ee84a5.png','/ee88ab.png'];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');

test('official visible default picker and reviewed legacy route support every supplemental name and byte',async()=>{
 const sourceBytes=fs.readFileSync(path.join(rendererRoot,'emoticons/extensions-source.json')),source=JSON.parse(sourceBytes);
 assert.equal(hash(sourceBytes),extension.source.sha256);assert.equal(sourceBytes.length,extension.source.bytes);
 assert.equal(source.chatPicker.url,'https://api.weibo.com/chat/');assert.equal(source.chatPicker.category,'默认');
 assert.equal(source.chatPicker.entries.length,182);assert.equal(extension.newNamedMappings,92);
 assert.equal(extension.explicitLegacyPaths,9);assert.equal(extension.mappingCount,101);
 assert.deepEqual(extension.requiredNames,[...requiredNames,...requiredPaths]);
 assert.equal(source.pathCodes.basis.sourceUrl,'https://h5.sinaimg.cn/m/pcweibochat/js/app.48f8ddda.js');
 assert.equal(source.pathCodes.basis.sha256,'572ee8cdb4a0d4b9401ab4f5aca0c5bd1f043fe310063632694a47d76bb30aae');
 assert.match(source.pathCodes.basis.excerpt,/convertEmoji:function/);
 const expected=new Map([...base.entries,...extension.entries].map(({name,...descriptor})=>[name,descriptor]));
 assert.equal(expected.size,409);assert.deepEqual(Object.keys(manifest).sort(),[...expected.keys()].sort());
 const service=createEmoticonAssets({root:rendererRoot,manifest});
 const unique=new Set();
 for(const {name,...descriptor} of extension.entries){
  assert.deepEqual(manifest[name],descriptor);assert.equal(descriptor.format,'png');assert.equal(descriptor.animated,false);
  if(name.startsWith('/')){
   assert.equal(descriptor.sourceUrl,source.pathCodes.entries.find(x=>x.name===name).src);
   assert.equal(new URL(descriptor.sourceUrl).host,'img.t.sinajs.cn');
   assert.equal(descriptor.width,20);assert.equal(descriptor.height,20);
  }else{
   assert.equal(descriptor.sourceUrl,source.chatPicker.entries.find(x=>x.name==='['+name+']').src);
   assert.equal(new URL(descriptor.sourceUrl).host,'face.t.sinajs.cn');
   assert.equal(descriptor.width,96);assert.equal(descriptor.height,96);
  }
  const response=service.serve({method:'GET',url:descriptor.src},new URL(descriptor.src));
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,descriptor.bytes);assert.equal(hash(bytes),descriptor.sha256);
  unique.add(descriptor.src);
 }
 assert.equal(unique.size,extension.uniqueResourceCount);
 assert.equal(new Set(Object.values(manifest).map(x=>x.src)).size,408);
 for(const item of source.chatPicker.entries)assert.ok(manifest[item.name.slice(1,-1)],item.name);
});

test('requested names and explicit paths support both bracket forms, repetition and punctuation without changing text',()=>{
 const display=create({manifest,links});
 const tokens=[...requiredNames,...requiredPaths].flatMap(name=>['['+name+']','【'+name+'】']);
 const text=tokens.join('，')+'。\n'+tokens.join('');
 const parts=display.tokenize(text),emoticons=parts.filter(x=>x.type==='emoticon');
 assert.equal(emoticons.length,tokens.length*2);assert.equal(parts.map(x=>x.text).join(''),text);
 assert.deepEqual(emoticons.map(x=>x.text),[...tokens,...tokens]);
 assert.ok(emoticons.every(x=>x.src===manifest[x.name].src));
 assert.notEqual(manifest['呵呵'].sha256,manifest['微笑'].sha256,'New official 呵呵 is not an inferred alias for 微笑');
 assert.notEqual(manifest['流汗'].sha256,manifest['汗'].sha256,'New official 流汗 is not an inferred alias for 汗');
});

test('unknown/path traversal/ordinary text and URL-contained path codes stay literal with no resource request',()=>{
 const display=create({manifest,links});
 for(const value of ['[/ee0000.png]','[/ee8192.PNG]','[ee8192.png]','[/../ee8192.png]','[//ee8192.png]',
  '[/%65e8192.png]','[/ee8192.png?x=1]','[苦涩的事]','【普通文字】','[[/ee8192.png]]',
  '[得]','[/ee88a6.PNG]','[ee88a6.png]','[/../ee88a6.png]','[/ee88a6.png?x=1]','[[/ee88a6.png]]',
  '[票券]','[/ee84a5.PNG]','[ee84a5.png]','[/../ee84a5.png]','[/ee84a5.png?x=1]','[[/ee84a5.png]]',
  '[空]','[/ee88ab.PNG]','[ee88ab.png]','[/../ee88ab.png]','[/ee88ab.png?x=1]','[[/ee88ab.png]]']){
  assert.deepEqual(display.tokenize(value),[{type:'text',text:value}]);
 }
 for(const url of ['https://example.com/[/ee8192.png]?q=[苦涩]','https://example.com/#【流鼻血】',
  'file:///tmp/[/ee8cb0.png]','javascript:read([/ee8192.png])','https://user:password@example.com/[/ee8192.png]',
  'https://example.com/[/ee88a6.png]?q=【/ee88a6.png】','https://example.com/[/ee84a5.png]?q=【/ee84a5.png】',
  'https://example.com/[/ee88ab.png]?q=【/ee88ab.png】']){
  const text=url+' [苦涩] 【/ee8192.png】',parts=display.tokenize(text);
  assert.equal(parts.filter(x=>x.type==='emoticon').length,2,url);
  assert.equal(parts.map(x=>x.text).join(''),text);
 }
});

test('ee88a6 is one verified official PNG, independent of Unicode or inferred named aliases',()=>{
 const entry=manifest['/ee88a6.png'];
 assert.equal(entry.sourceUrl,'https://img.t.sinajs.cn/t4/appstyle/expression/emimage/ee88a6.png');
 assert.equal(entry.src,'app://local/emoticons/ee88a6.png');assert.equal(entry.bytes,893);
 assert.equal(entry.sha256,'663f97e1ce619f72d02f3d901c5b3d70a56da67db1f6114dbc7c7bfe99991573');
 assert.equal(Object.values(manifest).filter(value=>value.sha256===entry.sha256).length,1);
 const display=create({manifest,links}),text='连续[/ee88a6.png][/ee88a6.png]，全角【/ee88a6.png】。';
 const parts=display.tokenize(text),images=parts.filter(part=>part.type==='emoticon');
 assert.equal(images.length,3);assert.ok(images.every(part=>part.src===entry.src));
 assert.equal(parts.map(part=>part.text).join(''),text);
 const source=require('../app/renderer/emoticons/extensions-source.json').pathCodes.entries.find(item=>item.name==='/ee88a6.png');
 assert.equal(source.historicalEncoding.source,'https://raw.githubusercontent.com/google/emoji4unicode/master/data/emoji4unicode.xml');
 assert.equal(Buffer.from(source.historicalEncoding.utf8Hex,'hex').toString('utf8').codePointAt(0),0xE226);
 assert.equal(source.historicalEncoding.pua,'E226');assert.equal(source.historicalEncoding.unicode,'1F250');
});

test('ee84a5 uses the verified official ticket image and retains mixed original code text',()=>{
 const entry=manifest['/ee84a5.png'];
 assert.equal(entry.sourceUrl,'https://img.t.sinajs.cn/t4/appstyle/expression/emimage/ee84a5.png');
 assert.equal(entry.src,'app://local/emoticons/ee84a5.png');assert.equal(entry.bytes,696);
 assert.equal(entry.sha256,'b280fb9d9deb94883731533aa4251e22b1bfcb5b1a857d63b8c938108d9c8114');
 assert.equal(Object.values(manifest).filter(value=>value.sha256===entry.sha256).length,1);
 const display=create({manifest,links}),text='票券[/ee84a5.png][/ee84a5.png]，全角【/ee84a5.png】及[哈哈]。';
 const parts=display.tokenize(text),images=parts.filter(part=>part.type==='emoticon');
 assert.equal(images.length,4);assert.ok(images.slice(0,3).every(part=>part.src===entry.src));
 assert.equal(parts.map(part=>part.text).join(''),text);
 const source=require('../app/renderer/emoticons/extensions-source.json').pathCodes.entries.find(item=>item.name==='/ee84a5.png');
 assert.equal(source.historicalEncoding.source,'https://raw.githubusercontent.com/google/emoji4unicode/master/data/emoji4unicode.xml');
 assert.equal(Buffer.from(source.historicalEncoding.utf8Hex,'hex').toString('utf8').codePointAt(0),0xE125);
 assert.equal(source.historicalEncoding.pua,'E125');assert.equal(source.historicalEncoding.unicode,'1F3AB');
});

test('ee88ab uses the verified official squared empty image without inferring a named alias',()=>{
 const entry=manifest['/ee88ab.png'];
 assert.equal(entry.sourceUrl,'https://img.t.sinajs.cn/t4/appstyle/expression/emimage/ee88ab.png');
 assert.equal(entry.src,'app://local/emoticons/ee88ab.png');assert.equal(entry.bytes,1023);
 assert.equal(entry.sha256,'7b8f4e08f3f704b1470e4c2191f8cf1ecf4f395796e1c719730f8b3e16332533');
 assert.equal(Object.values(manifest).filter(value=>value.sha256===entry.sha256).length,1);
 const display=create({manifest,links}),text='新码[/ee88ab.png][/ee88ab.png]，全角【/ee88ab.png】及[哈哈]。';
 const parts=display.tokenize(text),images=parts.filter(part=>part.type==='emoticon');
 assert.equal(images.length,4);assert.ok(images.slice(0,3).every(part=>part.src===entry.src));
 assert.equal(parts.map(part=>part.text).join(''),text);
 const source=require('../app/renderer/emoticons/extensions-source.json').pathCodes.entries.find(item=>item.name==='/ee88ab.png');
 assert.equal(source.historicalEncoding.source,'https://raw.githubusercontent.com/google/emoji4unicode/master/data/emoji4unicode.xml');
 assert.equal(Buffer.from(source.historicalEncoding.utf8Hex,'hex').toString('utf8').codePointAt(0),0xE22B);
 assert.equal(source.historicalEncoding.pua,'E22B');assert.equal(source.historicalEncoding.unicode,'1F233');
});

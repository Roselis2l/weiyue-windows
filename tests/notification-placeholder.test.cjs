'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

// Exercise the actual renderer predicates without starting Electron or a network.
const source=fs.readFileSync(path.join(__dirname,'../app/renderer/app.js'),'utf8');
const start=source.indexOf('function isNotificationOnly(');
const end=source.indexOf('function enrichmentKey(',start);
assert.ok(start>=0 && end>start);
const {isNotificationOnly,isLegacyShare}=vm.runInNewContext(source.slice(start,end)+';({isNotificationOnly,isLegacyShare})');
const template='我发布了新微博，快来围观吧！';
const placeholder=()=>({state:'unavailable',reason:'通知未提供原微博地址，无法确定原帖',text:'',images:[]});
const message=(post=placeholder())=>({id:'9007199254740993999',text:template,sharedPost:post});

test('strict archived placeholder is notification-only at either media version and never triggers enrichment',()=>{
  for(const mediaVersion of [undefined,1]){
    const original={...message(),mediaVersion};const before=JSON.stringify(original);
    assert.equal(isNotificationOnly(original),true);assert.equal(isLegacyShare(original),false);
    assert.equal(JSON.stringify(original),before,'classification must not mutate the archived message');
  }
});
test('exact punctuation variants match while additional content remains a share',()=>{
  for(const text of [template,' 我发布了新微博, 快来围观吧!\n','我发布了新微博，快来围观吧'])assert.equal(isNotificationOnly({...message(),text}),true);
  for(const text of [template+' 看看这篇','转发：'+template,template+' https://weibo.com/1/Abc'])assert.equal(isNotificationOnly({...message(),text}),false);
});
test('any actual post evidence or truncated flag keeps the archived card',()=>{
  for(const extra of [{id:'9007199254740993888'},{url:'https://weibo.com/1/Abc'},{author:'作者'},{text:'正文'},{images:[{url:'https://wx1.sinaimg.cn/large/fixture.jpg'}]},{truncated:true}]){
    assert.equal(isNotificationOnly(message({...placeholder(),...extra})),false,JSON.stringify(extra));
  }
});
test('ready, other reasons and incomplete shapes are not the known legacy placeholder',()=>{
  for(const post of [{...placeholder(),state:'ready'},{...placeholder(),state:'unknown'},{...placeholder(),reason:'原文已删除'},{...placeholder(),text:undefined},{...placeholder(),images:undefined}])assert.equal(isNotificationOnly(message(post)),false);
});
test('plain notification with no post needs no enrichment; real image and share notices retain it',()=>{
  for(const mediaVersion of [undefined,1])assert.equal(isLegacyShare({text:template,mediaVersion}),false);
  for(const text of ['分享图片','分享微博 https://weibo.com/1/Abc'])assert.equal(isLegacyShare({text}),true);
  assert.equal(isLegacyShare(message({...placeholder(),url:'https://weibo.com/1/Abc'})),true);
});

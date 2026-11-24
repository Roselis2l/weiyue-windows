'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeMessageContext,normalizeQuotePreview,isImageQuoteText}=require('../app/core/message-references.cjs');
const {normalizeMessages}=require('../app/core/weibo.cjs');
const separator='- - - - - - - - - - - - - - -';
const content=`「图片」\n${separator}\n合成回复文字`;
const preview={kind:'image',state:'unavailable',reasonCode:'WEB_REFERENCE_TARGET_UNAVAILABLE'};
const raw=extra=>({id:'9007199254740993900',from_uid:'71',gid:'81',type:321,media_type:0,time:1792544400,content,...extra});

test('confirmed image quote preview records unavailable web target without inventing an ID or picture',()=>{
  const source=raw({annotations:{smart_search:{topic_id:'0'},push_proc_ext:{msg_ext:'{}'}},mblogid:'1234'});
  assert.deepEqual(normalizeMessageContext(source),{contextVersion:1,quotePreview:preview});
  const [message]=normalizeMessages({messages:[source]},'81');
  assert.equal(message.text,content);assert.equal(message.contextVersion,1);assert.deepEqual(message.quotePreview,preview);
  assert.equal(message.references,undefined);assert.equal(message.images,undefined);
  assert.equal(message.quotePreview.id,undefined);assert.equal(message.quotePreview.url,undefined);
});
test('current image remains current image and unsupported reply aliases cannot bind it to original',()=>{
  const url='https://wx1.sinaimg.cn/large/synthetic-current.jpg';
  const [message]=normalizeMessages({messages:[raw({original_pic:url,reply_message:{id:'123',original_pic:url},quoted_message:{id:'456'},annotations:{reply_mid:'789'}})]},'81');
  assert.equal(message.images[0].originalUrl,url);assert.deepEqual(message.quotePreview,preview);
  assert.equal(message.references,undefined);assert.equal(message.quotePreview.images,undefined);
});
test('only bounded official quote layout is recognized, never image words, URLs or arbitrary punctuation',()=>{
  for(const value of [content,content.replaceAll('\n','\r\n'),content.replace('「图片」','「@合成成员:图片」')])assert.equal(isImageQuoteText(value),true);
  for(const value of [undefined,null,{},'图片','「图片」','「图片」\n普通正文',`普通正文\n${content}`,`https://example.invalid/${content}`,'「@bad\nname:图片」\n'+separator+'\nreply','「图片」\n---\nreply',content+'x'.repeat(1000000)])assert.equal(isImageQuoteText(value),false);
});
test('context refresh certifies ordinary messages without retaining fabricated or stale metadata',()=>{
  assert.deepEqual(normalizeMessageContext(raw({content:'合成普通文本',quotePreview:preview,systemNotice:{kind:'weibo-system',type:321,subType:101}})),{contextVersion:1});
  assert.deepEqual(normalizeMessageContext(raw({content:undefined,text:content})),{contextVersion:1,quotePreview:preview});
  for(const value of [null,undefined,[],1,'text'])assert.throws(()=>normalizeMessageContext(value),TypeError);
});
test('actual system protocol takes precedence; display label never classifies a member as a notice',()=>{
  assert.deepEqual(normalizeMessageContext(raw({sub_type:101})),{contextVersion:1,systemNotice:{kind:'weibo-system',type:321,subType:101}});
  assert.deepEqual(normalizeMessageContext(raw({content:'合成普通文本',from_user:{screen_name:'粉丝群'}})),{contextVersion:1});
});
test('persisted preview has only fixed safe metadata and round trips without text, target or URL',()=>{
  assert.deepEqual(normalizeQuotePreview({...preview,url:'javascript:bad',images:[{url:'file:///private'}],id:'123',text:'discard'}),preview);
  assert.deepEqual(normalizeQuotePreview(JSON.parse(JSON.stringify(preview))),preview);
  for(const value of [null,[],{}, {...preview,state:'ready'},{...preview,kind:'post'},{...preview,reasonCode:'OTHER'}, {...preview,reasonCode:undefined}])assert.throws(()=>normalizeQuotePreview(value),TypeError);
});

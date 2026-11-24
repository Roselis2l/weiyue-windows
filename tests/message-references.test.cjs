'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeMessages,normalizeImages,normalizeSharedPost,normalizeMessageReferences,parsePrecisionJson} = require('../app/core/weibo.cjs');
const {normalizeReferences,mergeReferences,postPermalink,MAX_REFERENCES,MAX_REFERENCE_DEPTH} = require('../app/core/message-references.cjs');
const image = name => `https://wx1.sinaimg.cn/large/${name}.jpg`;
const status = (id,text='合成微博正文',extra={}) => ({idstr:id,text_raw:text,user:{screen_name:'合成作者'},...extra});
const raw = extra => ({id:'9007199254740993900',from_uid:'71',gid:'81',content:'合成分享消息',time:1792544400,...extra});

test('confirmed returned post ID supplies a stable official detail link; chat/notification IDs never do',()=>{
  assert.equal(normalizeSharedPost({status:status('9007199254740993123')}).url,'https://m.weibo.cn/detail/9007199254740993123');
  assert.equal(normalizeSharedPost(raw({content:'我发布了新微博，快来围观吧！'})),undefined);
  assert.equal(postPermalink({id:Number.MAX_SAFE_INTEGER+1}),undefined);
  assert.equal(postPermalink({id:'1e30'}),undefined);
  assert.equal(postPermalink({id:'../admin'}),undefined);
  assert.equal(postPermalink({idstr:'0'}),undefined);
});
test('actual returned status URL remains authoritative',()=>{
  const post=normalizeSharedPost({status:status('123','原文',{url:'https://weibo.com/456/AbCd'})});
  assert.equal(post.url,'https://weibo.com/456/AbCd');
  assert.equal(normalizeSharedPost({status:status('123','原文',{url:'javascript:alert(1)'})}).url,'https://m.weibo.cn/detail/123');
});
test('retweeted original gets its own ID, images and original link rather than the parent share URL',()=>{
  const source=raw({url_objects:[{info:{url_long:'https://weibo.com/1/Parent'},status:status('100','转发文字',{retweeted_status:status('99','图片原文',{original_pic:image('original')})})}]});
  const [message]=normalizeMessages({messages:[source]},'81');
  assert.equal(message.text,source.content);
  assert.equal(message.referenceVersion,1);
  assert.equal(message.sharedPost.url,'https://weibo.com/1/Parent');
  assert.ok(message.sharedPost.text.includes('图片原文'),'existing summary content retains flattened original');
  assert.deepEqual(message.references,[{kind:'post',relation:'repost',text:'图片原文',images:[{url:image('original'),originalUrl:image('original')}],state:'ready',id:'99',url:'https://m.weibo.cn/detail/99',author:'合成作者'}]);
});
test('each additional actual url_objects status is preserved, ordinary link/user entries are not promoted',()=>{
  const refs=normalizeMessageReferences({url_objects:[{status:status('100')},{object:{object_type:'article',object:{url:'https://weibo.com/7/article'}}},{user:{id:'8'}},{info:{url_long:'https://weibo.com/2/Other'},status:status('99','第二条')} ]});
  assert.equal(refs.length,1);assert.equal(refs[0].relation,'shared');assert.equal(refs[0].id,'99');assert.equal(refs[0].url,'https://weibo.com/2/Other');
});
test('plain quote text never guesses a referenced message by sender, image label, link or arbitrary reply aliases',()=>{
  for(const extra of [
    {content:'「@合成成员:图片」\n- - - - - - - - - - - - - - -\n回应'},
    {content:'引用微博 https://weibo.com/7/example'},
    {content:'我发布了新微博，快来围观吧！'},
    {quoted_message:{id:'2',original_pic:image('unsupported')}},
    {reply_message:{id:'3',status:status('4')}}
  ]) assert.deepEqual(normalizeMessageReferences(raw(extra)),[]);
});
test('nested originals stay distinct; duplicate status nodes and IDs cannot make duplicate cards',()=>{
  const original=status('97','最早原文'),middle=status('98','中间转发',{retweeted_status:original}),top=status('99','最新转发',{retweeted_status:middle});
  const refs=normalizeMessageReferences({url_objects:[{status:top},{status:original},{status:status('98','重复副本')}]});
  assert.deepEqual(refs.map(r=>r.id),['98','97']);
  assert.equal(refs[0].text,'中间转发');assert.equal(refs[1].text,'最早原文');
});
test('malicious cyclic or deeply nested references terminate at documented bounds',()=>{
  const a=status('111'),b=status('110');a.retweeted_status=b;b.retweeted_status=a;
  assert.deepEqual(normalizeMessageReferences({status:a}).map(r=>r.id),['110']);
  let head=status('1');for(let i=2;i<50;i++)head=status(String(i),'深层合成',{retweeted_status:head});
  assert.equal(normalizeMessageReferences({status:head}).length,MAX_REFERENCE_DEPTH);
  const many=Array.from({length:100},(_,i)=>({status:status(String(i+1))}));
  assert.equal(normalizeMessageReferences({url_objects:many}).length,MAX_REFERENCES);
});
test('unsafe numeric post IDs never round, while lexical parser preserves large referenced status IDs',()=>{
  const parsed=parsePrecisionJson('{"status":{"id":9007199254740993123,"text":"parent","retweeted_status":{"id":9007199254740993111,"text":"original"}}}');
  assert.equal(normalizeMessageReferences(parsed)[0].id,'9007199254740993111');
  const [bad]=normalizeMessageReferences({status:status('100','parent',{retweeted_status:{id:9007199254740993123,text:'original'}})});
  assert.equal(bad.id,undefined);assert.equal(bad.url,undefined);
});
test('deleted originals expose unavailable state and no cached nested content',()=>{
  const refs=normalizeMessageReferences({status:status('100','parent',{retweeted_status:status('99','残留正文',{deleted:1,original_pic:image('residual'),retweeted_status:status('98','不应公开')})})});
  assert.equal(refs.length,1);assert.equal(refs[0].state,'unavailable');assert.equal(refs[0].text,'');assert.deepEqual(refs[0].images,[]);
  assert.equal(refs[0].url,'https://m.weibo.cn/detail/99');
});
test('referenced post text strips active HTML and rejects offsite media',()=>{
  const refs=normalizeMessageReferences({status:status('100','parent',{retweeted_status:{id:'99',text:'<script>alert(1)</script><b>正文</b><img src=x alt="[哈哈]">',original_pic:'https://outside.invalid/p.jpg'}})});
  assert.equal(refs[0].text,'正文[哈哈]');assert.deepEqual(refs[0].images,[]);
});
test('official pic_gifs and explicit object GIF resources remain originals and deduplicate',()=>{
  const gif='https://wx1.sinaimg.cn/large/synthetic.gif';
  const images=normalizeImages({pic_gifs:{original_pic:gif,thumbnail_pic:image('preview')},pic_infos:[{original_pic:gif}],url_objects:[{object:{object:{gif_name:'合成动图',url:gif}}}],media_type:1,fids:['123']});
  assert.equal(images.length,1);assert.equal(images[0].originalUrl,gif);assert.equal(images[0].thumbnailUrl,image('preview'));
  assert.equal(normalizeImages({url_objects:[{object:{object_type:'collection',gif_name:'另一动图',url:gif}}]})[0].originalUrl,gif);
});
test('collection pic_ids are not guessed into URLs; generic object URLs or fake GIF hosts are not images',()=>{
  for(const value of [
    {object:{object_type:'collection',object:{gif_name:'仅ID',pic_ids:['abc123']}}},
    {object:{object:{url:image('not-gif-evidence')}}},
    {object:{object:{gif_name:'恶意地址',url:'https://wx1.sinaimg.cn.evil.invalid/a.gif'}}},
    {object:{object:{gif_name:'本地文件',url:'file:///private.png'}}}
  ]) assert.deepEqual(normalizeImages({url_objects:[value]}),[]);
});
test('canonical references round trip only safe whitelisted fields',()=>{
  const values=normalizeMessageReferences({status:status('100','parent',{retweeted_status:status('99')})});
  assert.deepEqual(normalizeReferences(JSON.parse(JSON.stringify(values))),values);
  const [normalized]=normalizeReferences([{...values[0],unsafe:'discard',html:'<script>bad</script>'}]);
  assert.equal(normalized.unsafe,undefined);assert.equal(normalized.html,undefined);
  for(const change of [{kind:'message'},{relation:'unknown'},{state:'unknown'},{id:9007199254740993000},{url:'https://outside.invalid/'},{images:[{url:'file:///private.png'}]},{truncated:1},{text:undefined}])assert.throws(()=>normalizeReferences([{...values[0],...change}]),/引用内容格式无效/);
  assert.throws(()=>normalizeReferences(Array(MAX_REFERENCES+1).fill(values[0])),/引用内容格式无效/);
});
test('reference merging preserves richer cached original on incomplete refresh and marks it as cached',()=>{
  const base={kind:'post',relation:'repost',id:'99',url:'https://m.weibo.cn/detail/99',text:'完整的原始合成正文',images:[{url:image('one')}],state:'ready'};
  const refreshed={kind:'post',relation:'repost',id:'99',text:'短',images:[{url:image('two')}],state:'ready'};
  const [result]=mergeReferences([base],[refreshed]);
  assert.equal(result.text,base.text);assert.equal(result.state,'unavailable');assert.equal(result.url,base.url);assert.equal(result.images.length,2);assert.ok(result.reason);
  assert.deepEqual(mergeReferences([base],[]),normalizeReferences([base]));
});
test('reference dedupe and merge output remain bounded across repeated updates',()=>{
  const first=normalizeMessageReferences({url_objects:Array.from({length:21},(_,i)=>({status:status(String(i+1))}))});
  const next=normalizeMessageReferences({url_objects:Array.from({length:21},(_,i)=>({status:status(String(i+30))}))});
  assert.equal(mergeReferences(first,next).length,MAX_REFERENCES);
  assert.equal(normalizeReferences([first[0],first[0]]).length,1);
});

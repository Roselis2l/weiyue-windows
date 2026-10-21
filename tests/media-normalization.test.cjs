'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeImages,normalizeSharedPost,parsePrecisionJson}=require('../app/core/weibo.cjs');
const cdn=name=>'https://wx1.sinaimg.cn/'+name+'.jpg';
const fid=image=>new URL(image.url).searchParams.get('fid');

test('unsafe preferred image fields do not mask explicitly supplied safe variants',()=>{
  const [image]=normalizeImages({pic_infos:[{
    original_pic:'https://unapproved.example/private.jpg',
    largest:{url:'javascript:alert(1)',width:9999,height:9999},
    original:{url:'file:///private.jpg'},
    large:{url:cdn('large'),width:'720',height:480},
    url:cdn('lower-priority')
  }]});
  assert.deepEqual(image,{url:cdn('large'),originalUrl:cdn('large'),width:720,height:480});
});

test('empty nested objects and invalid URLs do not mask safe lower-priority nested variants',()=>{
  for(const largest of [{},{url:''},{url:'https://wx1.sinaimg.cn.evil.example/a.jpg'}]){
    const [image]=normalizeImages({pics:[{largest,original:{url:cdn('original'),width:1920,height:1080},large:{url:cdn('large')}}]});
    assert.equal(image.originalUrl,cdn('original'));assert.equal(image.width,1920);assert.equal(image.height,1080);
  }
  assert.deepEqual(normalizeImages({pics:[{largest:{url:'file:///x'},original:{url:'javascript:alert(1)'},thumbnail:{url:cdn('thumbnail'),width:120,height:80}}]}),
    [{url:cdn('thumbnail'),originalUrl:cdn('thumbnail'),thumbnailUrl:cdn('thumbnail'),width:120,height:80}]);
});

test('explicit bmiddle preview survives without replacing a valid original',()=>{
  for(const thumbnail_pic of [undefined,'','https://unapproved.example/a.jpg']){
    const [image]=normalizeImages({original_pic:cdn('original'),bmiddle_pic:cdn('middle'),thumbnail_pic});
    assert.equal(image.url,cdn('original'));assert.equal(image.originalUrl,cdn('original'));assert.equal(image.thumbnailUrl,cdn('middle'));
  }
  const [image]=normalizeImages({original_pic:cdn('original'),bmiddle_pic:cdn('middle'),thumbnail_pic:cdn('thumbnail')});
  assert.equal(image.thumbnailUrl,cdn('thumbnail'));assert.equal(image.originalUrl,cdn('original'));
  const [nested]=normalizeImages({pics:[{original_pic:cdn('original'),thumbnail_pic:'https://unapproved.example/a.jpg',
    thumbnail:{url:cdn('nested-thumbnail')},bmiddle_pic:cdn('middle')}]});
  assert.equal(nested.thumbnailUrl,cdn('nested-thumbnail'));
  assert.equal(normalizeImages({bmiddle_pic:cdn('middle')})[0].url,cdn('middle'));
});

test('an explicit direct original keeps its own dimensions instead of a discarded nested variant',()=>{
  const [image]=normalizeImages({original_pic:cdn('direct'),width:1600,height:900,
    pic_infos:[{original_pic:cdn('direct'),width:1600,height:900,largest:{url:cdn('other'),width:500,height:500}}]});
  assert.equal(image.originalUrl,cdn('direct'));assert.equal(image.width,1600);assert.equal(image.height,900);
});

test('empty or wholly invalid att_ids falls back to explicit fids while preserving decimal precision',()=>{
  const exact='9007199254740993123';
  for(const att_ids of [undefined,null,[], '', ' , ',['bad','0',9007199254740993123],{fid:exact}]){
    const images=normalizeImages({media_type:1,att_ids,fids:[exact]});
    assert.equal(images.length,1);assert.equal(fid(images[0]),exact);
  }
  const parsed=parsePrecisionJson('{"media_type":1,"att_ids":[],"fids":[9007199254740993123]}');
  assert.equal(fid(normalizeImages(parsed)[0]),exact);
});

test('valid att_ids priority, original priority, deduplication and FID bounds remain unchanged',()=>{
  const images=normalizeImages({media_type:1,att_ids:['invalid','11','11','12'],fids:['13']});
  assert.deepEqual(images.map(fid),['11','12']);
  assert.deepEqual(normalizeImages({media_type:1,att_ids:[],fids:['0','-1','1e3','file:///x',{},9007199254740993123]}),[]);
  assert.deepEqual(normalizeImages({media_type:10,att_ids:[],fids:['123']}),[]);
  assert.deepEqual(normalizeImages({media_type:1,att_ids:[],fids:['123']},{allowFids:false}),[]);
  assert.equal(normalizeImages({media_type:1,att_ids:[],fids:Array.from({length:60},(_,i)=>String(i+1))}).length,50);
  const explicit=normalizeImages({media_type:1,original_pic:cdn('original'),att_ids:[],fids:['123']});
  assert.equal(explicit.length,1);assert.equal(explicit[0].originalUrl,cdn('original'));
});

test('shared posts use safe variant selection without constructing chat FID attachments or extra variants',()=>{
  const shared=normalizeSharedPost({status:{idstr:'123',text_raw:'本地模拟正文',media_type:1,att_ids:[],fids:['456'],
    pics:[{original_pic:'https://unapproved.example/a.jpg',large:{url:cdn('post')},bmiddle_pic:cdn('post-middle')}] }});
  assert.equal(shared.images.length,1);
  assert.deepEqual(shared.images[0],{url:cdn('post'),originalUrl:cdn('post'),thumbnailUrl:cdn('post-middle')});
  assert.equal(shared.images.some(image=>image.url.includes('msget')),false);
});

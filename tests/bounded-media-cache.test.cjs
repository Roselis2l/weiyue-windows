'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {BoundedMediaCache}=require('../app/core/bounded-media-cache.cjs');
const media=n=>({bytes:Buffer.alloc(n),mime:'application/pdf'});
test('bounded validated media cache expires least recently used originals',()=>{
  const cache=new BoundedMediaCache(8);cache.set('a',media(3));cache.set('b',media(3));cache.get('a');cache.set('c',media(3));
  assert.equal(cache.get('b'),undefined);assert.equal(cache.bytes,6);assert.ok(cache.get('a'));assert.equal(cache.set('large',media(9)),false);assert.equal(cache.bytes,6);
  cache.set('a',media(1));assert.equal(cache.bytes,4);cache.clear();assert.equal(cache.bytes,0);assert.equal(cache.get('a'),undefined);
});
test('cache requires byte buffers and does not create a disk path',()=>{const cache=new BoundedMediaCache(8);assert.throws(()=>cache.set('a',{bytes:'secret'}));assert.throws(()=>new BoundedMediaCache(-1));});

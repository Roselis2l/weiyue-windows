'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {render}=require('../app/renderer/message-references.js');
function fixture(){
  const texts=[],images=[],links=[];
  const node=(tag,attrs,...children)=>({tag,attrs,children,classList:{add(value){attrs.class=(attrs.class||'')+' '+value;}},append(...more){children.push(...more);}});
  return{node,texts,images,links,appendText(element,text,callback){texts.push({text,callback});element.append(text);return element;},imageGallery(value,message,title){images.push({value,message,title});return node('gallery',{});},createLink(url,title,callback){links.push({url,title,callback});return /^https:\/\/m\.weibo\.cn\/detail\/\d+$/.test(url||'')?node('a',{href:url},title):null;},openLink(){}};
}
const post=extra=>({kind:'post',relation:'repost',text:'<img src=x onerror=bad()>原文',images:[{src:'weiyue-media://image/synthetic'}],state:'ready',id:'99',url:'https://m.weibo.cn/detail/99',author:'合成作者',...extra});
test('reference rendering delegates images, safe text and distinct exact original links',()=>{
  const deps=fixture(),message={id:'71',references:[post(),post({id:'98',url:'https://m.weibo.cn/detail/98',relation:'shared'})]};
  const cards=render(message,deps);
  assert.equal(cards.length,2);assert.equal(cards[0].attrs['aria-label'],'被引用的原微博');
  assert.equal(cards[1].attrs['aria-label'],'消息中的另一条微博');
  assert.equal(deps.texts[0].text,message.references[0].text);assert.equal(deps.texts[0].callback,deps.openLink);
  assert.equal(deps.images[0].message,message);assert.equal(deps.images[0].title,'引用微博配图');
  assert.deepEqual(deps.links.map(link=>link.url),message.references.map(ref=>ref.url));
  assert.equal(cards[0].children.at(-1).attrs.href,'https://m.weibo.cn/detail/99');
});
test('unavailable/truncated originals retain safe fallback and are never presented as currently ready',()=>{
  const deps=fixture();const cards=render({references:[post({state:'unavailable',truncated:true,reason:'原帖已删除'})]},deps);
  assert.equal(cards[0].children[0].children[1].children[0],'本地缓存');
  assert.ok(cards[0].children.some(child=>child.tag==='p'&&child.children[0].includes('原帖已删除')));
  assert.ok(cards[0].children.some(child=>child.tag==='p'&&child.children[0].includes('不完整')));
});
test('unknown content, non-reference messages and unsafe original URLs cannot create clickable original cards',()=>{
  const deps=fixture();assert.deepEqual(render({},deps),[]);assert.deepEqual(render({references:[{kind:'unknown'}]},deps),[]);
  const cards=render({references:[post({url:'javascript:bad()'})]},deps);
  assert.equal(cards[0].children.some(child=>child.tag==='a'),false);
  assert.equal(render({references:Array(100).fill(post())},deps).length,20);
});

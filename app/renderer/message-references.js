(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.WeiyueReferences=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // The caller supplies the existing safe text/link/image renderers. Reference
  // metadata never becomes HTML, a raw media src, or an application instruction.
  function render(message,{node,appendText,imageGallery,createLink,openLink}){
    if(!Array.isArray(message?.references))return[];
    return message.references.slice(0,20).filter(reference=>reference?.kind==='post').map(reference=>{
      const title=reference.relation==='repost'?'被引用的原微博':'消息中的另一条微博';
      const cached=reference.state!=='ready'&&!!(reference.text||reference.images?.length);
      const card=node('section',{class:'shared-post referenced-post','aria-label':title},
        node('div',{class:'shared-post-title'},node('strong',{},title+(reference.author?' · '+reference.author:'')),
          node('span',{},cached?'本地缓存':reference.state==='ready'?'微博内容':'内容暂不可用')));
      if(reference.text)card.append(appendText(node('div',{class:'shared-post-text'}),reference.text,openLink));
      if(reference.images?.length)card.append(imageGallery(reference.images,message,'引用微博配图'));
      if(reference.state!=='ready')card.append(node('p',{class:'shared-post-warning'},
        (cached?'这是已保存的引用内容，当前原帖未确认可用。\n':'')+(reference.reason||'原帖未提供可读内容，可通过官方原链接核对。')));
      if(reference.truncated)card.append(node('p',{class:'shared-post-warning'},'此引用正文可能不完整，请打开对应原微博查看全文。'));
      const link=createLink(reference.url,reference.relation==='repost'?'打开被引用原微博 ↗':'打开这条微博 ↗',openLink);
      if(link){link.classList.add('post-original-link');card.append(link);}
      return card;
    });
  }
  return Object.freeze({render});
});

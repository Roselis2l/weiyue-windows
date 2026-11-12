(function(root,factory){'use strict';const exported=factory();if(typeof module==='object'&&module.exports)module.exports=exported;else root.WeiyueBrowserSettings=exported;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 let pending=null;
 function bind({api,select,note,isCurrent=()=>true}){
  let state=null,loading=true,saving=false;
  function render(message){if(!isCurrent())return;select.disabled=loading||saving;note.textContent=message||(loading?'正在读取浏览器…':state?.available?'此设置立即保存，仅影响微阅中的网页链接，不更改 Windows 默认浏览器。':'原先选择的浏览器已不可用，请重新选择。');}
  function show(value){if(!isCurrent())return;state=value;select.replaceChildren();for(const item of value.choices){const option=select.ownerDocument.createElement('option');option.value=item.id;option.textContent=item.label;select.append(option);}if(!value.available){const option=select.ownerDocument.createElement('option');option.value=value.selected;option.textContent='先前选择的浏览器（不可用）';option.disabled=true;select.append(option);}select.value=value.selected;}
  async function load(){render();try{if(pending)await pending.catch(()=>{});const result=await api('browser.get');if(!isCurrent())return;show(result);loading=false;render();}catch(error){loading=false;select.disabled=true;if(isCurrent())note.textContent=error.message;}}
  select.addEventListener('change',async()=>{if(loading||saving||pending||!isCurrent()){if(state)select.value=state.selected;return;}const browser=select.value;saving=true;render('正在保存…');pending=Promise.resolve().then(()=>api('browser.save',{browser}));try{const result=await pending;show(result);saving=false;render();}catch(error){saving=false;if(state&&isCurrent())select.value=state.selected;render(error.message);}finally{pending=null;}});
  return {ready:load()};
 }
 return {bind};
});

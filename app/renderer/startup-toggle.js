(function(root,factory){'use strict';const exported=factory();if(typeof module==='object'&&module.exports)module.exports=exported;else root.WeiyueStartupToggle=exported;})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  let pending=null;
  function bind({api,input,note,isCurrent=()=>true}){
    let state=null,loading=true,saving=false;
    const message=value=>!value.supported?'开机自启动仅支持 Windows 安装版。':value.blocked?'此启动项已被 Windows 禁用，可在系统启动应用中开启。':'勾选后，登录 Windows 时自动启动；更改立即保存。';
    function render(text){if(!isCurrent())return;input.disabled=loading||saving||!state?.supported;input.checked=state?.enabled===true;note.textContent=text??(loading?'正在读取启动设置…':message(state));}
    async function load(){loading=true;render();try{if(pending)await pending.catch(()=>{});const result=await api('startup.get');if(!isCurrent())return;state=result;loading=false;render();}catch(error){loading=false;state=null;render(error.message||'启动设置读取失败，请重新打开设置。');}}
    input.addEventListener('change',async()=>{
      const enabled=input.checked;
      if(loading||saving||pending||!state?.supported||!isCurrent()){render();return;}
      saving=true;render('正在保存…');input.checked=enabled;
      pending=Promise.resolve().then(()=>api('startup.save',{enabled}));
      try{const result=await pending;state=result;saving=false;render();}
      catch(error){saving=false;render(error.message||'保存失败，请重试。');}
      finally{pending=null;}
    });
    const ready=load();return {ready};
  }
  return {bind};
});

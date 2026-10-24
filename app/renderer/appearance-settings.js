'use strict';

(() => {
  const appearance=window.WeiyueAppearance;
  const labels={chatBackground:'聊天背景',memberName:'普通成员昵称',importantName:'重点成员昵称',memberBubble:'普通消息框',memberText:'普通成员消息文字颜色',importantBubble:'重点消息框',importantText:'重点消息文字'};
  function readable(background,preferred='#52634b',light='#f4f8f5') {
    if(appearance.contrastRatio(preferred,background)>=4.5)return preferred;
    if(appearance.contrastRatio(light,background)>=4.5)return light;
    return appearance.contrastRatio('#000000',background)>=appearance.contrastRatio('#ffffff',background)?'#000000':'#ffffff';
  }
  function apply(host,value) {
    const theme=appearance.getAppearanceTheme(value),c=theme.colors;
    const variables={
      'chat-bg':c.chatBackground,'member-name':c.memberName,'important-name':c.importantName,
      'member-bubble':c.memberBubble,'important-bubble':c.importantBubble,
      'member-text':theme.memberText,'member-link':theme.memberLink,'important-text':theme.importantText,'important-link':theme.importantLink,
      'chat-text':theme.chatText,'chat-focus':theme.chatLink,
      'chat-target':readable(c.chatBackground,'#965d15','#ffdc9a')
    };
    for(const [key,color] of Object.entries(variables))host.style.setProperty('--'+key,color);
    return theme;
  }
  function open({api,node,button,modal,toast,appearance:initial,accountId,isCurrent,onBack,onSaved}) {
    let draft={...appearance.normalizeAppearance(initial)},saving=false;
    let explicitText=appearance.normalizeHex(draft.importantText)||appearance.DEFAULTS.importantText;
    const controls=new Map(),status=node('p',{id:'appearance-status',class:'appearance-status',role:'status','aria-live':'polite'});
    const warning=node('div',{id:'appearance-warnings',class:'warning','aria-live':'polite',hidden:true});
    const preview=node('section',{id:'appearance-preview',class:'appearance-preview','aria-label':'合成数据局部预览'},
      node('p',{class:'appearance-preview-label'},'示例数据 · 仅预览，不修改聊天记录'),
      ...[false,true].map(important=>node('div',{class:'appearance-example'+(important?' is-important':'')},
        node('span',{class:'appearance-example-avatar','aria-hidden':'true'},important?'重':'普'),
        node('div',{class:'appearance-example-copy'},node('div',{class:'message-top'},node('span',{class:'sender-name'},important?'重点成员示例':'普通成员示例'),node('span',{class:'message-time'},'12:30')),
          node('div',{class:'appearance-example-bubble'},'好的 ',node('span',{class:'appearance-example-link'},'示例链接'))))));
    const fields=node('div',{class:'appearance-fields'});
    for(const key of Object.keys(labels)) {
      const error=node('small',{id:'appearance-'+key+'-error',class:'error-note',hidden:true});
      const starting=draft[key]===null?explicitText:draft[key];
      const hex=node('input',{id:'appearance-'+key+'-hex',type:'text',value:starting,maxlength:7,spellcheck:'false',autocomplete:'off','aria-label':labels[key]+' HEX','aria-describedby':error.id,oninput:()=>{draft[key]=hex.value;update();}});
      const color=node('input',{id:'appearance-'+key+'-color',type:'color',value:starting,'aria-label':labels[key]+'颜色选择器',oninput:()=>{draft[key]=color.value;hex.value=color.value;update();}});
      const auto=key==='importantText'?node('input',{id:'appearance-importantText-auto',type:'checkbox',checked:draft[key]===null,onchange:event=>{
        if(event.target.checked){explicitText=appearance.normalizeHex(hex.value)||explicitText;draft[key]=null;}
        else{draft[key]=explicitText;hex.value=explicitText;color.value=explicitText;}
        update();
      }}):null;
      controls.set(key,{hex,color,error,auto});
      fields.append(node('div',{class:'appearance-field'},node('label',{for:hex.id},labels[key]),node('div',{class:'appearance-color-controls'},color,hex),auto?node('label',{class:'check-row'},auto,'自动选取对比色'):null,error));
    }
    const reset=button('恢复默认',()=>{if(saving)return;draft={...appearance.DEFAULTS};explicitText=draft.importantText;for(const [key,c] of controls){c.hex.value=draft[key];c.color.value=draft[key];if(c.auto)c.auto.checked=false;}update();status.textContent='已恢复默认预览；点击“保存颜色”后才会生效。';},'',{id:'appearance-reset'});
    const save=button('保存颜色',async()=>{
      if(saving)return;
      if(!isCurrent())throw new Error('账号已切换，请重新打开外观设置。');
      const colors=appearance.validateAppearance(draft);saving=true;update();status.textContent='正在保存颜色…';
      try {
        const state=await api('settings.appearance.save',{accountId,appearance:colors});
        if(!isCurrent() || state.account?.id!==accountId || !dialog.open || dialog.firstChild!==owner)throw new Error('账号或设置窗口已切换，外观结果未应用。');
        onSaved(state);saving=false;onBack();toast('外观颜色已保存，仅影响当前账号。');
      } catch(error) {if(!isCurrent() || !dialog.open || dialog.firstChild!==owner)return;status.textContent='保存未完成，草稿仍保留。';throw error;}
      finally {saving=false;update();}
    },'primary',{id:'save-appearance'});
    let dialog,owner;
    function update() {
      let valid=true;const previewValues={};
      for(const [key,c] of controls) {
        const automatic=key==='importantText' && draft[key]===null;
        const value=appearance.normalizeHex(draft[key]),fieldValid=automatic||!!value;valid&&=fieldValid;
        c.error.hidden=fieldValid;c.error.textContent=fieldValid?'':'请输入 #RGB 或 #RRGGBB，例如 #fff 或 #244f42。';
        c.hex.setAttribute('aria-invalid',String(!fieldValid));
        if(automatic)previewValues[key]=null;else if(value){c.color.value=value;previewValues[key]=value;}else previewValues[key]=c.color.value;
        c.hex.disabled=saving||automatic;c.color.disabled=saving||automatic;if(c.auto)c.auto.disabled=saving;
      }
      const theme=apply(preview,previewValues);
      warning.hidden=!theme.warnings.length;warning.replaceChildren(...theme.warnings.map(item=>node('p',{},item.message)));
      save.disabled=saving||!valid;save.textContent=saving?'正在保存…':'保存颜色';reset.disabled=saving;
      if(dialog?.open && dialog.firstChild===owner)for(const close of dialog.querySelectorAll('#modal-close,.modal-head button'))close.disabled=saving;
    }
    dialog=modal('外观颜色',node('div',{},node('p',{class:'form-description'},'选择颜色或输入 HEX。下方仅使用合成示例；保存后应用到当前账号。昵称和指定的消息文字颜色会保留，对比不足会提示；也可让重点文字自动选色。'),fields,warning,preview,status),[reset,save],{closeLabel:'取消并返回设置',onClose:()=>{if(!saving)onBack();}});
    dialog.dataset.context='appearance';owner=dialog.firstChild;update();
  }
  window.WeiyueAppearanceSettings=Object.freeze({apply,open});
})();

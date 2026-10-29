'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WeiyueLayout=api;})(typeof window==='object'?window:globalThis,function(){
  const keys=['leftCollapsed','rightCollapsed'];
  function normalize(value){return Object.fromEntries(keys.map(key=>[key,!!(value&&value[key]===true)]));}
  function create({shell,leftPanel,rightPanel,leftButton,rightButton,save,beforeChange=()=>null,afterChange=()=>{},onError=()=>{}}){
    let state=normalize(),pending=false,initialized=false,idle=Promise.resolve(),releaseIdle,pendingFocus;
    function paint(value){
      const context=beforeChange();state=normalize(value);shell.classList.remove('show-inspector');
      shell.classList.toggle('left-collapsed',state.leftCollapsed);shell.classList.toggle('right-collapsed',state.rightCollapsed);
      leftPanel.hidden=state.leftCollapsed;rightPanel.hidden=state.rightCollapsed;
      for(const [side,button] of [['left',leftButton],['right',rightButton]]){
        const collapsed=state[side+'Collapsed'],text=(collapsed?'展开':'收起')+(side==='left'?'左栏':'右栏');
        button.textContent=text;button.title=text;button.setAttribute('aria-label',text);button.setAttribute('aria-expanded',String(!collapsed));
      }
      afterChange(context);
    }
    function busy(value){
      const document=leftButton.ownerDocument;
      if(value&&!pending){idle=new Promise(resolve=>{releaseIdle=resolve;});pendingFocus=[leftButton,rightButton].find(button=>button===document?.activeElement);}
      pending=value;leftButton.disabled=value;rightButton.disabled=value;shell.setAttribute('aria-busy',String(value));
      if(!value){if(pendingFocus&&document.activeElement===document.body)pendingFocus.focus({preventScroll:true});pendingFocus=null;releaseIdle?.();releaseIdle=null;}
    }
    async function toggle(side){
      if(!initialized||pending||!['left','right'].includes(side))return false;
      const previous={...state},next={...state,[side+'Collapsed']:!state[side+'Collapsed']};busy(true);paint(next);
      try{const stored=normalize(await save(next));if(keys.some(key=>stored[key]!==next[key]))throw new Error('栏位布局未正确保存，请重试。');return true;}
      catch(error){paint(previous);onError(error);return false;}
      finally{busy(false);}
    }
    leftButton.addEventListener('click',()=>{void toggle('left');});rightButton.addEventListener('click',()=>{void toggle('right');});
    busy(true);
    return {initialize(value){if(initialized)return;paint(value);initialized=true;busy(false);},toggle,async expand(side){if(!['left','right'].includes(side))return false;while(pending)await idle;return state[side+'Collapsed']?toggle(side):true;},status:()=>({...state,pending,initialized})};
  }
  return {normalize,create};
});

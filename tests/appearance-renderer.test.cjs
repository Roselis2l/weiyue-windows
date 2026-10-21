'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const renderer=path.join(__dirname,'../app/renderer');
const sources=['appearance.js','appearance-settings.js'].map(name=>fs.readFileSync(path.join(renderer,name),'utf8'));
const plain=value=>JSON.parse(JSON.stringify(value));

// Deliberately small DOM adapter: tests exercise the shipped module, not a
// reimplementation of its draft, validation or asynchronous save decisions.
class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this.dataset={};this.disabled=false;this.hidden=false;this.value='';this.style={values:new Map(),setProperty(name,value){this.values.set(name,value);},getPropertyValue(name){return this.values.get(name)||'';}};}
  append(...children){this.children.push(...children.flat().filter(child=>child!==null&&child!==undefined&&child!==false));}
  replaceChildren(...children){this.children=[];this.append(...children);}
  get firstChild(){return this.children[0]||null;}
  set textContent(text){this.children=[String(text)];}
  get textContent(){return this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
  setAttribute(name,value){this.attributes[name]=String(value);if(name==='id')this.id=String(value);if(name==='class')this.className=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  querySelectorAll(selector){
    assert.equal(selector,'#modal-close,.modal-head button','Unexpected DOM query should be explicitly modeled');
    return descendants(this).filter(el=>el.id==='modal-close'||(el.tagName==='BUTTON'&&descendants(this.children.find(c=>c instanceof Element&&c.className==='modal-head')).includes(el)));
  }
}
function descendants(root){return root instanceof Element?[root,...root.children.flatMap(descendants)]:[];}
function node(tag,attrs={},...children){
  const el=new Element(tag);
  for(const [key,value]of Object.entries(attrs)){
    if(key.startsWith('on'))el[key]=value;
    else if(['value','disabled','hidden','checked'].includes(key))el[key]=value;
    else el.setAttribute(key,value);
  }
  el.append(...children);return el;
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

function fixture(initial){
  const documentStyle=new Element('html').style;
  documentStyle.setProperty('--green','#112233');documentStyle.setProperty('--ink','#223344');
  const sandbox={document:{documentElement:{style:documentStyle}}};sandbox.window=sandbox;
  vm.createContext(sandbox);for(const source of sources)vm.runInContext(source,sandbox);
  const fromRealm=value=>vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify(value))+')',sandbox);
  const library=sandbox.WeiyueAppearance,module=sandbox.WeiyueAppearanceSettings;
  const dialog=node('dialog'),calls=[],saved=[],toasts=[],backs=[],errors=[];
  let current=true,nextApi=()=>Promise.resolve({account:{id:'account-a'}}),closeOptions;
  const button=(label,action,className='',attrs={})=>{
    const el=node('button',{...attrs,class:className},label);el.action=action;
    // Mirrors native disabled buttons: actual user clicks do not dispatch.
    el.click=()=>el.disabled?undefined:el.action();return el;
  };
  const modal=(title,body,footer,options)=>{
    const close=button('Close',()=>options.onClose?.(),'',{id:'modal-close'});
    const head=node('header',{class:'modal-head'},node('h2',{},title),close);
    dialog.replaceChildren(head,body,node('footer',{},...footer));dialog.open=true;closeOptions=options;return dialog;
  };
  const config={api:async(name,payload)=>{calls.push({name,payload:plain(payload)});return nextApi(name,payload);},node,button,modal,toast:message=>toasts.push(message),appearance:fromRealm(initial||plain(library.DEFAULTS)),accountId:'account-a',isCurrent:()=>current,onBack:()=>backs.push(true),onSaved:state=>saved.push(state)};
  const open=overrides=>module.open({...config,...overrides});
  const byId=id=>{const found=descendants(dialog).find(el=>el.id===id);assert.ok(found,'Missing #'+id);return found;};
  const input=(field,value,type='hex')=>{const el=byId('appearance-'+field+'-'+type);assert.equal(el.disabled,false);el.value=value;el.oninput({target:el,currentTarget:el});return el;};
  const auto=value=>{const el=byId('appearance-importantText-auto');assert.equal(el.disabled,false);el.checked=value;const handler=el.onchange||el.oninput;assert.equal(typeof handler,'function');handler({target:el,currentTarget:el});return el;};
  return{module,library,sandbox,fromRealm,documentStyle,dialog,calls,saved,toasts,backs,errors,open,byId,input,auto,
    setCurrent(value){current=value;},setApi(fn){nextApi=fn;},cancel(){closeOptions.onClose();},
    replaceOwner(){const close=button('Busy replacement',()=>{},'',{id:'modal-close'});close.disabled=true;dialog.replaceChildren(node('header',{class:'modal-head'},close));return close;}};
}

test('apply scopes complete canonical appearance variables to its host and leaves global tokens unchanged',()=>{
  const f=fixture(),host=node('section'),before=[...f.documentStyle.values];
  const raw={...plain(f.library.DEFAULTS),chatBackground:'#ABC',memberName:'#fff',memberBubble:'url(https://example.invalid/)',extra:'red; --green: red'};
  const theme=f.module.apply(host,f.fromRealm(raw));
  assert.deepEqual([...f.documentStyle.values],before);
  assert.equal(host.style.getPropertyValue('--chat-bg'),'#aabbcc');
  assert.equal(host.style.getPropertyValue('--member-bubble'),'#ffffff');
  assert.equal(host.style.getPropertyValue('--member-name'),'#ffffff');
  assert.ok(theme.warnings.length>0,'low-contrast chosen names are preserved with a warning');
  assert.equal(host.style.values.size,12);
  for(const [key,value]of host.style.values){assert.match(key,/^--(?:chat-(?:bg|text|focus|target)|(?:member|important)-(?:name|bubble|text|link))$/);assert.match(value,/^#[a-f0-9]{6}$/);}
  for(const key of ['--green','--ink','--extra','background'])assert.equal(host.style.getPropertyValue(key),'');
  for(const prefix of ['member','important'])for(const foreground of ['text','link'])assert.ok(f.library.contrastRatio(host.style.getPropertyValue('--'+prefix+'-'+foreground),host.style.getPropertyValue('--'+prefix+'-bubble'))>=4.5);
  f.module.apply(host,f.fromRealm({}));
  assert.equal(host.style.getPropertyValue('--chat-bg'),f.library.DEFAULTS.chatBackground,'next account missing colors cannot inherit previous palette');
  assert.equal(host.style.getPropertyValue('--member-name'),f.library.DEFAULTS.memberName);
});

test('editing, picker input, restore defaults and cancellation are local drafts with zero writes',()=>{
  const f=fixture({...plain(fixture().library.DEFAULTS),memberBubble:'#123456'});f.open();
  f.input('memberBubble','#AbC');
  assert.equal(f.byId('appearance-memberBubble-color').value,'#aabbcc');
  assert.equal(f.byId('appearance-preview').style.getPropertyValue('--member-bubble'),'#aabbcc');
  f.input('importantBubble','#334455','color');
  assert.equal(f.byId('appearance-importantBubble-hex').value,'#334455');
  f.byId('appearance-reset').click();
  for(const key of f.library.FIELDS)assert.equal(f.byId('appearance-'+key+'-hex').value,f.library.DEFAULTS[key]);
  assert.equal(f.calls.length,0);f.cancel();assert.equal(f.backs.length,1);assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);
  f.open();assert.equal(f.byId('appearance-memberBubble-hex').value,'#123456','cancel/reopen restores saved initial value');
  assert.equal(descendants(f.byId('appearance-preview')).some(el=>el.getAttribute('data-message-id')!==null),false,'synthetic preview does not become a read-tracked message');
});

test('invalid HEX disables saving and preserves the last valid preview; canonical recovery saves exact fields',async()=>{
  const f=fixture();f.open();f.input('memberBubble','#AbC');
  for(const invalid of ['', 'fff', '#12', '#12345g', ' #fff', '#fff ', '#fff;background:red', 'var(--green)']){
    f.input('memberBubble',invalid);
    assert.equal(f.byId('appearance-memberBubble-hex').getAttribute('aria-invalid'),'true');
    assert.equal(f.byId('appearance-memberBubble-error').hidden,false);
    assert.equal(f.byId('save-appearance').disabled,true);f.byId('save-appearance').click();
    assert.equal(f.byId('appearance-preview').style.getPropertyValue('--member-bubble'),'#aabbcc');
  }
  assert.equal(f.calls.length,0);f.input('memberBubble','#DeF');
  assert.equal(f.byId('appearance-memberBubble-hex').getAttribute('aria-invalid'),'false');assert.equal(f.byId('appearance-memberBubble-error').hidden,true);
  await f.byId('save-appearance').click();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'settings.appearance.save');assert.equal(f.calls[0].payload.accountId,'account-a');
  assert.deepEqual(Object.keys(f.calls[0].payload.appearance).sort(),[...f.library.FIELDS].sort());
  assert.equal(f.calls[0].payload.appearance.memberBubble,'#ddeeff');assert.equal(f.saved.length,1);
});

test('low contrast names warn without changing chosen colors or blocking a valid save',()=>{
  const f=fixture();f.open();f.input('chatBackground','#fff');f.input('memberName','#fff');
  assert.equal(f.byId('appearance-warnings').hidden,false);assert.ok(f.byId('appearance-warnings').children.length>0);
  assert.equal(f.byId('appearance-preview').style.getPropertyValue('--member-name'),'#ffffff');assert.equal(f.byId('save-appearance').disabled,false);
  assert.equal(f.calls.length,0);
});

test('one pending save disables editing and closing, rejects duplicate invocation, then applies once',async()=>{
  const f=fixture(),wait=deferred();f.setApi(()=>wait.promise);f.open();f.input('memberName','#123');
  const save=f.byId('save-appearance'),pending=save.click();assert.equal(f.calls.length,1);
  for(const key of f.library.FIELDS)for(const type of ['hex','color'])assert.equal(f.byId('appearance-'+key+'-'+type).disabled,true);
  for(const id of ['save-appearance','appearance-reset','modal-close'])assert.equal(f.byId(id).disabled,true);
  f.cancel();assert.equal(f.backs.length,0);await save.action();assert.equal(f.calls.length,1);
  wait.resolve({account:{id:'account-a'},appearance:{memberName:'#112233'}});await pending;
  assert.equal(f.saved.length,1);assert.equal(f.backs.length,1);assert.equal(f.toasts.length,1);assert.equal(save.disabled,false);
});

test('failed save preserves edited draft and permits an explicit retry without false success',async()=>{
  const f=fixture();f.setApi(()=>Promise.reject(new Error('Synthetic disk failure')));f.open();f.input('importantBubble','#123456');
  const save=f.byId('save-appearance');await assert.rejects(save.click(),/Synthetic disk failure/);
  assert.equal(f.byId('appearance-importantBubble-hex').value,'#123456');assert.equal(save.disabled,false);
  assert.equal(f.byId('appearance-importantBubble-hex').disabled,false);assert.equal(f.byId('modal-close').disabled,false);
  assert.equal(f.saved.length,0);assert.equal(f.backs.length,0);assert.equal(f.toasts.length,0);assert.ok(f.byId('appearance-status').textContent.length>0);
  const original=f.calls[0];f.setApi(()=>Promise.resolve({account:{id:'account-a'}}));await save.click();
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],original);assert.equal(f.saved.length,1);assert.equal(f.toasts.length,1);
});

test('account changes before submit cannot write a draft into the next account',async()=>{
  const f=fixture();f.open();f.input('memberName','#111');f.setCurrent(false);
  await assert.rejects(f.byId('save-appearance').click());assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);assert.equal(f.toasts.length,0);
});

test('account changes during save suppress stale application, navigation and success toast',async()=>{
  const f=fixture(),wait=deferred();f.setApi(()=>wait.promise);f.open();const pending=f.byId('save-appearance').click();f.setCurrent(false);
  wait.resolve({account:{id:'account-a'}});await pending;
  assert.equal(f.calls.length,1);assert.equal(f.saved.length,0);assert.equal(f.backs.length,0);assert.equal(f.toasts.length,0);
});

test('response with the wrong account is a failure and never overwrites current state',async()=>{
  const f=fixture();f.setApi(()=>Promise.resolve({account:{id:'account-b'}}));f.open();f.input('memberName','#456');
  await assert.rejects(f.byId('save-appearance').click());assert.equal(f.saved.length,0);assert.equal(f.backs.length,0);assert.equal(f.toasts.length,0);
  assert.equal(f.byId('appearance-memberName-hex').value,'#456');assert.equal(f.byId('save-appearance').disabled,false);
});

test('closed modal suppresses a late save result without reporting success',async()=>{
  const f=fixture(),wait=deferred();f.setApi(()=>wait.promise);f.open();const pending=f.byId('save-appearance').click();f.dialog.open=false;
  wait.resolve({account:{id:'account-a'}});await pending;assert.equal(f.saved.length,0);assert.equal(f.backs.length,0);assert.equal(f.toasts.length,0);
});

test('replaced modal owner is untouched by a late save completion',async()=>{
  const f=fixture(),wait=deferred();f.setApi(()=>wait.promise);f.open();const pending=f.byId('save-appearance').click();const replacementClose=f.replaceOwner();
  wait.resolve({account:{id:'account-a'}});await pending;
  assert.equal(f.saved.length,0);assert.equal(f.backs.length,0);assert.equal(f.toasts.length,0);
  assert.equal(replacementClose.disabled,true,'late appearance cleanup must not re-enable another modal close control');
});

test('independent account drafts never leak edited or reset colors into each other',()=>{
  const f=fixture(),initial=Object.freeze({...plain(f.library.DEFAULTS),chatBackground:'#345678'});f.open({appearance:f.fromRealm(initial)});f.input('chatBackground','#fed');
  f.open({accountId:'account-b',appearance:f.fromRealm({...initial,chatBackground:'#123456'})});
  assert.equal(f.byId('appearance-chatBackground-hex').value,'#123456');f.byId('appearance-reset').click();
  f.open({appearance:f.fromRealm(initial)});assert.equal(f.byId('appearance-chatBackground-hex').value,'#345678');
  assert.equal(initial.chatBackground,'#345678');assert.equal(f.calls.length,0);
});

test('automatic important text disables only its color inputs and preserves the previous explicit HEX locally',()=>{
  const f=fixture();f.open();
  assert.equal(f.byId('appearance-importantText-auto').checked,false);
  f.input('importantText','#AbC');f.auto(true);
  for(const type of ['hex','color'])assert.equal(f.byId('appearance-importantText-'+type).disabled,true);
  assert.equal(f.byId('appearance-importantBubble-hex').disabled,false);
  assert.equal(f.byId('save-appearance').disabled,false);assert.equal(f.calls.length,0);
  const preview=f.byId('appearance-preview');
  assert.ok(f.library.contrastRatio(preview.style.getPropertyValue('--important-text'),preview.style.getPropertyValue('--important-bubble'))>=4.5);
  f.auto(false);
  for(const type of ['hex','color'])assert.equal(f.byId('appearance-importantText-'+type).disabled,false);
  assert.equal(f.library.normalizeHex(f.byId('appearance-importantText-hex').value),'#aabbcc');
  assert.equal(f.byId('appearance-importantText-color').value,'#aabbcc');
  assert.equal(preview.style.getPropertyValue('--important-text'),'#aabbcc');
  f.auto(true);f.cancel();assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);
  f.open();assert.equal(f.byId('appearance-importantText-auto').checked,false);
  assert.equal(f.byId('appearance-importantText-hex').value,'#860000','cancel discarded the local automatic choice and edited HEX');
});

test('saved automatic text and legacy five-color settings open in automatic mode with a usable explicit fallback',()=>{
  for(const legacy of [false,true]){
    const f=fixture(),initial={...plain(f.library.DEFAULTS),importantText:null};
    if(legacy)delete initial.importantText;
    f.open({appearance:f.fromRealm(initial)});
    assert.equal(f.byId('appearance-importantText-auto').checked,true);
    for(const type of ['hex','color'])assert.equal(f.byId('appearance-importantText-'+type).disabled,true);
    f.auto(false);
    assert.equal(f.byId('appearance-importantText-hex').value,'#860000');
    assert.equal(f.byId('appearance-importantText-color').value,'#860000');
    assert.equal(f.byId('appearance-preview').style.getPropertyValue('--important-text'),'#860000');
    assert.equal(f.calls.length,0);
  }
});

test('automatic text saves null once and stays disabled after a failed save until the user changes mode',async()=>{
  const f=fixture(),wait=deferred();f.setApi(()=>wait.promise);f.open();f.input('importantText','#123456');f.auto(true);
  const save=f.byId('save-appearance'),pending=save.click();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.appearance.importantText,null);
  assert.equal(Object.keys(f.calls[0].payload.appearance).length,6);assert.equal(f.byId('appearance-importantText-auto').disabled,true);
  await save.action();assert.equal(f.calls.length,1);
  wait.reject(new Error('Synthetic automatic text save failure'));await assert.rejects(pending,/Synthetic automatic text save failure/);
  assert.equal(f.byId('appearance-importantText-auto').checked,true);assert.equal(f.byId('appearance-importantText-auto').disabled,false);
  for(const type of ['hex','color'])assert.equal(f.byId('appearance-importantText-'+type).disabled,true);
  assert.equal(f.saved.length,0);assert.equal(f.toasts.length,0);
  f.setApi(()=>Promise.resolve({account:{id:'account-a'},appearance:f.calls[0].payload.appearance}));await save.click();
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].payload.appearance.importantText,null);assert.equal(f.saved.length,1);
  f.open({appearance:f.fromRealm(f.calls[1].payload.appearance)});assert.equal(f.byId('appearance-importantText-auto').checked,true);
});

test('restore defaults switches automatic text back to explicit new default colors without writing',()=>{
  const f=fixture();f.open();f.input('importantText','#987654');f.auto(true);f.byId('appearance-reset').click();
  assert.equal(f.byId('appearance-importantText-auto').checked,false);
  assert.equal(f.byId('appearance-importantText-hex').disabled,false);assert.equal(f.byId('appearance-importantText-color').disabled,false);
  assert.equal(f.byId('appearance-importantText-hex').value,'#860000');
  assert.equal(f.byId('appearance-importantName-hex').value,'#860000');
  assert.equal(f.byId('appearance-importantBubble-hex').value,'#fcd3d4');
  assert.equal(f.byId('appearance-preview').style.getPropertyValue('--important-text'),'#860000');
  assert.equal(f.calls.length,0);f.cancel();assert.equal(f.saved.length,0);
});

test('explicit low-contrast important text remains exact with a warning while links keep independent readable colors',async()=>{
  const f=fixture();f.open();f.input('importantBubble','#fff');f.input('importantText','#FFF');
  const preview=f.byId('appearance-preview');
  assert.equal(preview.style.getPropertyValue('--important-text'),'#ffffff');
  assert.equal(f.byId('appearance-warnings').hidden,false);
  assert.ok(f.library.contrastRatio(preview.style.getPropertyValue('--important-link'),'#ffffff')>=4.5);
  assert.notEqual(preview.style.getPropertyValue('--important-link'),'#ffffff');
  assert.equal(f.byId('save-appearance').disabled,false);await f.byId('save-appearance').click();
  assert.equal(f.calls[0].payload.appearance.importantText,'#ffffff','warning cannot silently replace the user-selected text color');
  f.open({appearance:f.fromRealm({...f.calls[0].payload.appearance,importantText:null})});
  const automaticPreview=f.byId('appearance-preview');
  assert.ok(f.library.contrastRatio(automaticPreview.style.getPropertyValue('--important-text'),'#ffffff')>=4.5);
});

test('invalid explicit important text blocks saving but choosing automatic creates a valid null draft',async()=>{
  const f=fixture();f.open();f.input('importantText','#nohex');
  assert.equal(f.byId('appearance-importantText-hex').getAttribute('aria-invalid'),'true');
  assert.equal(f.byId('appearance-importantText-error').hidden,false);assert.equal(f.byId('save-appearance').disabled,true);
  f.auto(true);
  assert.equal(f.byId('appearance-importantText-error').hidden,true);
  assert.equal(f.byId('appearance-importantText-hex').getAttribute('aria-invalid'),'false');
  assert.equal(f.byId('save-appearance').disabled,false);await f.byId('save-appearance').click();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.appearance.importantText,null);
});

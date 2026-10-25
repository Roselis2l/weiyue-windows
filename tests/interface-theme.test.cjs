'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const themes=require('../app/renderer/interface-theme.js'),appearance=require('../app/renderer/appearance.js');
const {saveAppearanceSettings}=require('../app/core/appearance-settings.cjs'),{Store}=require('../app/core/store.cjs');
test('four original theme palettes have readable normal/muted/accent surfaces without changing message tokens',()=>{
 assert.deepEqual(Object.keys(themes.THEMES),['cool-grey','viridian','pink','violet']);
 for(const [id,t] of Object.entries(themes.THEMES)){
  for(const background of ['shell','panel','surface','hover','selected'])for(const color of ['text','muted','accent'])assert.ok(appearance.contrastRatio(t[color],t[background])>=4.5,id+' '+color+'/'+background);
  assert.ok(appearance.contrastRatio(t.accentText,t.accent)>=4.5);
  const variables=new Map(),host={dataset:{},style:{setProperty:(k,v)=>variables.set(k,v)}};themes.apply(host,id);assert.equal(host.dataset.interfaceTheme,id);
  assert.ok([...variables.keys()].every(k=>k.startsWith('--ui-')));assert.ok([...variables.values()].every(v=>/^#[a-f0-9]{6}$/.test(v)));
 }
});
test('missing legacy theme is normalized in memory; strict saves reject injected/unknown theme values',()=>{
 for(const value of [undefined,null,{},'unknown','__proto__','cool-grey; color:red',true]){assert.equal(themes.normalizeTheme(value),'cool-grey');assert.throws(()=>themes.validateTheme(value),{code:'APPEARANCE_INVALID'});}
 for(const id of Object.keys(themes.THEMES))assert.equal(themes.validateTheme(id),id);
});
test('theme and seven colors persist atomically across store restart, isolated from all other data/accounts',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-theme-126-')),store=new Store(root);
 t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('weiyue-theme-126-'));fs.rmSync(root,{recursive:true});});
 for(const id of ['theme-a','theme-b']){store.ensureAccount({id,name:'Synthetic',kind:'import'});store.mergeMessages(id,[{id:'g',name:'Synthetic',selected:true}],[{id:'1',groupId:'g',senderId:'s',senderName:'Synthetic',text:'Synthetic',time:1}]);store.setReadPosition(id,'g','1');}
 const colors={...appearance.DEFAULTS,memberText:'#123456',importantText:'#654321',chatBackground:'#eeeeee'},before=store.get('theme-a'),other=store.get('theme-b'),context={accountId:'theme-a',epoch:1};
 for(const id of Object.keys(themes.THEMES)){
  saveAppearanceSettings({store,getContext:()=>context,payload:{accountId:'theme-a',appearance:colors,interfaceTheme:id}});
  const after=new Store(root).get('theme-a');assert.deepEqual(after,{...before,settings:{...before.settings,appearance:colors,interfaceTheme:id}});assert.deepEqual(new Store(root).get('theme-b'),other);
 }
 const unchanged=store.get('theme-a');
 assert.throws(()=>saveAppearanceSettings({store,getContext:()=>context,payload:{accountId:'theme-a',appearance:colors,interfaceTheme:'red;bad'}}),{code:'APPEARANCE_INVALID'});assert.deepEqual(store.get('theme-a'),unchanged);
 assert.throws(()=>saveAppearanceSettings({store,getContext:()=>({...context,accountId:'theme-b'}),payload:{accountId:'theme-a',appearance:colors,interfaceTheme:'pink'}}),{code:'APPEARANCE_ACCOUNT_CHANGED'});assert.deepEqual(store.get('theme-a'),unchanged);
 saveAppearanceSettings({store,getContext:()=>context,payload:{accountId:'theme-a',appearance:appearance.DEFAULTS}});assert.equal(store.get('theme-a').settings.interfaceTheme,'violet','legacy callers preserve saved theme');
});

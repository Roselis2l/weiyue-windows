'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const {DEFAULTS,normalizeAppearance}=require('../app/renderer/appearance.js');
const {saveAppearanceSettings}=require('../app/core/appearance-settings.cjs');
const source=fs.readFileSync(path.join(__dirname,'../app/main.cjs'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const snapshotSource=section('function snapshot(){','function syncStatus()');
const dispatchSource=section('async function handle(action,p){','async function start(){');
const plain=value=>JSON.parse(JSON.stringify(value));
function harness({unreadable=false}={}){
 const states=new Map(['account-A','account-B'].map(id=>[id,{account:{id,name:'Synthetic '+id,kind:'import'},groups:[],messages:[],bookmarks:[],summaries:[],readPositions:{group:'42'},readStates:{group:{anchorId:'42',readThroughId:'80',unreadIds:['81']}},importantMembers:['member'],settings:{model:'preserved-model',autoSyncEnabled:false},exports:{}}]));
 const calls={writes:0,vaultWrites:0,secretReads:0,network:0};
 const scope={activeId:'account-A',accountEpoch:1,busy:false,cleanupBusy:()=>false,revision:7,dataRoot:'synthetic-only',
  buildIdentity:require('../app/core/build-identity.cjs').validateBuildIdentity(require('../app/edition.json'),require('../package.json').version),normalizeAppearance,saveAppearanceSettings,visibleMessages:messages=>messages,avatars:{source(){throw Error('no groups in fixture');}},
  closing:()=>false,account:()=>states.get(scope.activeId),publicReadStats:()=>plain(states.get(scope.activeId).readStates),
  secrets:()=>{calls.secretReads++;if(unreadable)throw Error('synthetic credentials locked');return{aiKey:'MOCK-ONLY',notionToken:'MOCK-NOTION'};},
  vault:{write(){calls.vaultWrites++;throw Error('appearance must not touch vault');}},
  net:{fetch(){calls.network++;throw Error('no network allowed');}},
  store:{accounts:()=>[...states.values()].map(state=>state.account),update:(id,mutator)=>{const next=structuredClone(states.get(id));mutator(next);states.set(id,next);calls.writes++;}},
  setActive:id=>{scope.activeId=id;scope.accountEpoch++;}
 };
 vm.createContext(scope);vm.runInContext(snapshotSource+dispatchSource+';globalThis.dispatch=handle;',scope);
 return {scope,states,calls,call:scope.dispatch};
}

test('actual state snapshot supplies appearance defaults without mutating or migrating old settings',async()=>{
 const h=harness(),before=JSON.stringify([...h.states]);
 const result=await h.call('state',{});assert.deepEqual(plain(result.settings.appearance),DEFAULTS);
 result.settings.appearance.memberName='#000000';assert.equal(JSON.stringify([...h.states]),before);
 assert.equal(Object.hasOwn(h.states.get('account-A').settings,'appearance'),false);assert.equal(h.calls.writes,0);assert.equal(h.calls.vaultWrites,0);
 h.states.get('account-A').settings.appearance={memberName:'#ABC',importantBubble:'url(secret)',unknown:'#fff'};
 const old=JSON.stringify([...h.states]);const next=await h.call('state',{});
 assert.deepEqual(plain(next.settings.appearance),{...DEFAULTS,memberName:'#aabbcc',importantText:null});assert.equal(JSON.stringify([...h.states]),old);assert.equal(h.calls.writes,0);
});

test('actual appearance route persists only seven appearance fields and returns snapshot without revision or credentials changes',async()=>{
 const h=harness(),before=structuredClone(h.states.get('account-A')),other=structuredClone(h.states.get('account-B'));
 const colors={...DEFAULTS,memberBubble:'#000',importantBubble:'#fff',memberName:'#ABC',memberText:'#F09'};
 const result=await h.call('settings.appearance.save',{accountId:'account-A',appearance:colors});
 const expected={...DEFAULTS,memberBubble:'#000000',importantBubble:'#ffffff',memberName:'#aabbcc',memberText:'#ff0099'};
 assert.deepEqual(h.states.get('account-A'),{...before,settings:{...before.settings,appearance:expected}});
 assert.deepEqual(h.states.get('account-B'),other);assert.deepEqual(plain(result.settings.appearance),expected);assert.equal(result.account.id,'account-A');
 assert.equal(result.revision,7);assert.equal(h.scope.revision,7);assert.equal(h.calls.writes,1);assert.equal(h.calls.vaultWrites,0);assert.equal(h.calls.network,0);
 assert.ok(!JSON.stringify(result).includes('MOCK-ONLY'));assert.ok(!JSON.stringify(result).includes('MOCK-NOTION'));
 assert.equal(result.credentials.ai,true);assert.equal(result.credentials.notion,true);
});

test('unreadable existing credentials do not prevent independent appearance save or require credential reset',async()=>{
 const h=harness({unreadable:true});
 const result=await h.call('settings.appearance.save',{accountId:'account-A',appearance:DEFAULTS});
 assert.deepEqual(plain(result.settings.appearance),DEFAULTS);assert.equal(result.credentialError,'synthetic credentials locked');assert.equal(h.calls.writes,1);assert.equal(h.calls.vaultWrites,0);
});

test('actual route rejects stale accounts, unknown payload and busy or closing operations before saving',async()=>{
 const h=harness(),before=JSON.stringify([...h.states]);
 await assert.rejects(h.call('settings.appearance.save',{accountId:'account-B',appearance:DEFAULTS}),{code:'APPEARANCE_ACCOUNT_CHANGED'});
 for(const payload of [{appearance:DEFAULTS},{accountId:'account-A',appearance:DEFAULTS,deleteSecrets:true},{accountId:'account-A',appearance:{...DEFAULTS,memberName:'red'}}])await assert.rejects(h.call('settings.appearance.save',payload),{code:'APPEARANCE_INVALID'});
 h.scope.busy=true;await assert.rejects(h.call('settings.appearance.save',{accountId:'account-A',appearance:DEFAULTS}),/操作正在进行/);h.scope.busy=false;
 h.scope.closing=()=>true;await assert.rejects(h.call('settings.appearance.save',{accountId:'account-A',appearance:DEFAULTS}),{code:'APPEARANCE_CLOSING'});
 assert.equal(JSON.stringify([...h.states]),before);assert.equal(h.calls.writes,0);assert.equal(h.calls.secretReads,0);assert.equal(h.calls.vaultWrites,0);assert.equal(h.calls.network,0);
});

test('actual route keeps different appearance values isolated after account switches',async()=>{
 const h=harness();await h.call('settings.appearance.save',{accountId:'account-A',appearance:{...DEFAULTS,chatBackground:'#000',memberText:'#abc'}});
 const switched=await h.call('account.switch',{id:'account-B'});assert.deepEqual(plain(switched.settings.appearance),DEFAULTS);
 await assert.rejects(h.call('settings.appearance.save',{accountId:'account-A',appearance:DEFAULTS}),{code:'APPEARANCE_ACCOUNT_CHANGED'});
 await h.call('settings.appearance.save',{accountId:'account-B',appearance:{...DEFAULTS,chatBackground:'#abc',memberText:'#123'}});
 const back=await h.call('account.switch',{id:'account-A'});assert.equal(back.settings.appearance.chatBackground,'#000000');assert.equal(h.states.get('account-B').settings.appearance.chatBackground,'#aabbcc');
 assert.equal(back.settings.appearance.memberText,'#aabbcc');assert.equal(h.states.get('account-B').settings.appearance.memberText,'#112233');
});

test('actual snapshot supplies black ordinary text for old six-field settings without a migration write',async()=>{
 const h=harness(),legacy={...DEFAULTS,chatBackground:'#000000',memberBubble:'#112233',importantText:'#aabbcc'};delete legacy.memberText;
 h.states.get('account-A').settings.appearance=legacy;const before=JSON.stringify([...h.states]);
 const result=await h.call('state',{});
 assert.deepEqual(plain(result.settings.appearance),{...legacy,memberText:'#000000'});
 assert.equal(JSON.stringify([...h.states]),before);assert.equal(h.calls.writes,0);assert.equal(h.calls.vaultWrites,0);
 assert.equal(Object.hasOwn(h.states.get('account-A').settings.appearance,'memberText'),false);
});

test('preload permits only the explicit appearance action and forwards its account-bound payload',async()=>{
 let api;const calls=[];
 const context=vm.createContext({require:name=>{
  assert.equal(name,'electron');
  return {contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'api');api=value;}},
   ipcRenderer:{invoke:async(...args)=>{calls.push(args);return {ok:true,value:{saved:true}};}}};
 }});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/preload.cjs'),'utf8'),context);
 const payload={accountId:'account-A',appearance:DEFAULTS};const result=await api.call('settings.appearance.save',payload);
 assert.equal(result.saved,true);assert.deepEqual(calls,[['weiyue:call','settings.appearance.save',payload]]);
 await assert.rejects(api.call('settings.appearance.unsafe',payload),/不支持/);assert.equal(calls.length,1);
});

test('local protocol allows only the bundled appearance module path, not adjacent files or traversal',async()=>{
 const protocolSource=section("   protocol.handle('app',request=>{",'  hardenSession(session.defaultSession)');
 const requests=[];let handler;
 const context=vm.createContext({protocol:{handle:(scheme,fn)=>{assert.equal(scheme,'app');handler=fn;}},URL,Response,pdfAssets:new Set(),path,pathToFileURL,__dirname:path.resolve(__dirname,'../app'),net:{fetch:url=>{requests.push(url);return{status:200};}}});
 vm.runInContext(protocolSource,context);
 assert.equal((await handler({method:'GET',url:'app://local/appearance.js'})).status,200);
 assert.equal(requests[0],pathToFileURL(path.resolve(__dirname,'../app/renderer/appearance.js')).href);
 assert.equal((await handler({method:'GET',url:'app://local/appearance-settings.js'})).status,200);
 assert.equal(requests[1],pathToFileURL(path.resolve(__dirname,'../app/renderer/appearance-settings.js')).href);
 for(const url of ['app://local/appearance.cjs','app://local/core/appearance-settings.cjs','app://local/%2e%2e/core/appearance-settings.cjs','app://evil/appearance.js'])assert.equal((await handler({method:'GET',url})).status,404);
 assert.equal((await handler({method:'POST',url:'app://local/appearance.js'})).status,404);assert.equal(requests.length,2);
});

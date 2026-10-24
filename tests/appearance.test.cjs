'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {DEFAULTS,FIELDS,MIN_CONTRAST,normalizeHex,normalizeAppearance,validateAppearance,contrastRatio,getAppearanceTheme}=require('../app/renderer/appearance.js');
const defaultColors={chatBackground:'#f1f3f2',memberName:'#52634b',importantName:'#860000',memberBubble:'#ffffff',importantBubble:'#fcd3d4',importantText:'#860000',memberText:'#000000'};

test('appearance defaults are immutable and reads return independent complete color values',()=>{
 assert.deepEqual(DEFAULTS,defaultColors);assert.deepEqual(FIELDS,Object.keys(defaultColors));assert.equal(MIN_CONTRAST,4.5);
 assert.ok(Object.isFrozen(DEFAULTS));assert.ok(Object.isFrozen(FIELDS));
 for(const value of [undefined,null,false,1,'#fff',[],new Date(),new String('x'),Object.create({memberName:'#abc'})])assert.deepEqual(normalizeAppearance(value),defaultColors);
 const first=normalizeAppearance(),second=normalizeAppearance();first.memberName='#ffffff';assert.deepEqual(second,defaultColors);
 assert.deepEqual(DEFAULTS,defaultColors);
});

test('strict HEX normalization accepts only RGB or RRGGBB without string coercion or CSS syntax',()=>{
 for(const [input,expected] of [['#ABC','#aabbcc'],['#0f9','#00ff99'],['#123456','#123456'],['#AfC091','#afc091']])assert.equal(normalizeHex(input),expected);
 for(const input of ['','#abcd','#12345678','#12','#12345','red','transparent','rgb(0,0,0)','var(--ink)','url(https://example.invalid)',
  '#fff;display:none','#fff\n','#fff ',' #fff','＃fff','#ggg','\0#fff',[],{},null,15,new String('#fff'),{toString(){throw Error('must not coerce');}}])assert.equal(normalizeHex(input),null);
});

test('reading partial or legacy appearance falls back per field, never mutates, and never evaluates accessors',()=>{
 const legacy={chatBackground:'#ABC',memberName:'url(secret)',importantName:'#F12C09',memberBubble:null,importantBubble:'#1234',unknown:'kept outside projection'};
 const before=structuredClone(legacy),result=normalizeAppearance(legacy);
 assert.deepEqual(result,{...defaultColors,chatBackground:'#aabbcc',importantName:'#f12c09',importantText:null});assert.deepEqual(legacy,before);
 const getter={chatBackground:'#000'};let calls=0;Object.defineProperty(getter,'memberName',{enumerable:true,get(){calls++;throw Error('must not execute');}});
 assert.deepEqual(normalizeAppearance(getter),{...defaultColors,chatBackground:'#000000',importantText:null});assert.equal(calls,0);
 const revoked=Proxy.revocable({},{});revoked.revoke();assert.deepEqual(normalizeAppearance(revoked.proxy),defaultColors);
 assert.deepEqual(normalizeAppearance(new Proxy({}, {ownKeys(){throw Error('bad object');}})),defaultColors);
 const nullObject=Object.assign(Object.create(null),{memberBubble:'#ABC'});assert.equal(normalizeAppearance(nullObject).memberBubble,'#aabbcc');
});

test('explicit save requires seven own enumerable data fields, strict HEX and only importantText may be null',()=>{
 assert.deepEqual(validateAppearance({...defaultColors,memberName:'#ABC'}),{...defaultColors,memberName:'#aabbcc'});
 assert.deepEqual(validateAppearance(Object.assign(Object.create(null),defaultColors)),defaultColors);
 const input={...defaultColors},output=validateAppearance(input);output.memberName='#000000';assert.deepEqual(input,defaultColors);
 const invalid=[undefined,null,[],new Date(),{},Object.create(defaultColors),{...defaultColors,unknown:'#fff'},
  {...defaultColors,[Symbol('extra')]:'#fff'},Object.assign(new String('x'),defaultColors),JSON.parse('{"__proto__":"#fff"}')];
 for(const field of FIELDS){const missing={...defaultColors};delete missing[field];invalid.push(missing);
  for(const value of ['#abcd','#12345678','red','#fff; color:red',{},[],undefined,3])invalid.push({...defaultColors,[field]:value});
  if(field!=='importantText')invalid.push({...defaultColors,[field]:null});}
 const getter={...defaultColors};Object.defineProperty(getter,'memberBubble',{enumerable:true,get(){throw Error('must not execute');}});invalid.push(getter);
 const hidden={...defaultColors};Object.defineProperty(hidden,'memberBubble',{value:'#fff',enumerable:false});invalid.push(hidden);
 const revoked=Proxy.revocable({},{});revoked.revoke();invalid.push(revoked.proxy);
 for(const value of invalid)assert.throws(()=>validateAppearance(value),error=>error.code==='APPEARANCE_INVALID'&&!error.message.includes('must not execute'));
 assert.deepEqual(validateAppearance({...defaultColors,importantText:null}),{...defaultColors,importantText:null});
});

test('contrast calculation agrees with black-white and grayscale boundaries and rejects invalid colors',()=>{
 assert.equal(contrastRatio('#000','#fff'),21);assert.equal(contrastRatio('#abc','#abc'),1);
 assert.equal(contrastRatio('#fff','#000'),21);assert.ok(Math.abs(contrastRatio('#777777','#ffffff')-4.478089453577214)<1e-10);
 assert.ok(contrastRatio('#767676','#ffffff')>4.5);
 for(const value of ['red','#ffff','#12345678',null,{}])assert.throws(()=>contrastRatio(value,'#fff'),{code:'APPEARANCE_INVALID'});
});

test('ordinary text stays explicitly black while automatic important text and links adapt to bubble colors',()=>{
 const theme=getAppearanceTheme();assert.deepEqual(theme.colors,defaultColors);
 assert.equal(theme.memberText,'#000000');assert.equal(theme.memberLink,'#356f64');assert.equal(theme.importantText,'#860000');assert.equal(theme.importantLink,'#860000');
 assert.deepEqual(theme.warnings,[]);
 const inverted={...defaultColors,chatBackground:'#000000',memberBubble:'#000000',importantBubble:'#ffffff',importantText:null};
 const before=structuredClone(inverted),result=getAppearanceTheme(inverted);
 assert.equal(result.memberText,'#000000');assert.equal(result.importantText,'#53604f');assert.deepEqual(result.colors,inverted);assert.deepEqual(inverted,before);
 assert.equal(result.warnings.find(warning=>warning.field==='memberText')?.contrast,1);
 const middle=getAppearanceTheme({...defaultColors,memberBubble:'#777777',importantBubble:'#777777',importantText:null});
 for(const field of ['memberText','memberLink','importantText','importantLink'])assert.equal(middle[field],'#000000');
});

test('automatic chat and important text plus derived links retain contrast independently of explicit ordinary text',()=>{
 const values=[0,31,63,95,127,159,191,223,255],colors=['#777777','#767676','#00ff00','#0000ff','#ff0000','#ff00ff','#ffff00','#00ffff'];
 for(const red of values)for(const green of values)for(const blue of values)colors.push('#'+[red,green,blue].map(value=>value.toString(16).padStart(2,'0')).join(''));
 for(const background of colors){
  const theme=getAppearanceTheme({...defaultColors,chatBackground:background,memberBubble:background,importantBubble:background,importantText:null});
  assert.equal(theme.memberText,'#000000');
  for(const field of ['chatText','chatLink','memberLink','importantText','importantLink']){
   assert.match(theme[field],/^#[0-9a-f]{6}$/);assert.ok(contrastRatio(theme[field],background)>=4.5,field+' '+background);
  }
 }
});

test('low contrast nickname colors produce warnings but remain exactly the normalized user selection',()=>{
 const input={...defaultColors,chatBackground:'#fff',memberName:'#fff',importantName:'#eee'};
 const theme=getAppearanceTheme(input);assert.equal(theme.colors.memberName,'#ffffff');assert.equal(theme.colors.importantName,'#eeeeee');
 assert.deepEqual(theme.warnings.map(item=>item.field),['memberName','importantName']);
 assert.ok(theme.warnings.every(item=>item.minimum===4.5&&item.contrast<4.5&&item.message.includes('保留')));
 assert.equal(theme.warnings[0].contrast,1);assert.equal(input.memberName,'#fff');
 const fixed=getAppearanceTheme({...input,memberName:'#000'});assert.deepEqual(fixed.warnings.map(item=>item.field),['importantName']);
});

test('new untouched appearance uses sampled red and pink defaults while old five colors keep automatic text',()=>{
 const oldFive={chatBackground:'#111111',memberName:'#aabbcc',importantName:'#193e32',memberBubble:'#cccccc',importantBubble:'#244f42'};
 const before=structuredClone(oldFive);
 assert.deepEqual(normalizeAppearance(undefined),defaultColors);
 assert.deepEqual(normalizeAppearance(oldFive),{...oldFive,importantText:null,memberText:'#000000'});assert.deepEqual(oldFive,before);
 assert.equal(getAppearanceTheme(oldFive).importantText,'#f4f8f5');
 assert.equal(normalizeAppearance({}).importantText,null);
 assert.equal(normalizeAppearance({...oldFive,importantText:'transparent'}).importantText,null);
 assert.equal(normalizeAppearance({...oldFive,importantText:null}).importantText,null);
 assert.equal(normalizeAppearance({...oldFive,importantText:'#F09'}).importantText,'#ff0099');
 let accessed=0;const accessor={...oldFive};Object.defineProperty(accessor,'importantText',{enumerable:true,get(){accessed++;throw Error('must not execute');}});
 assert.deepEqual(normalizeAppearance(accessor),{...oldFive,importantText:null,memberText:'#000000'});assert.equal(accessed,0);
 for(const invalid of ['#rgba','red',false,{},[],15])assert.deepEqual(normalizeAppearance({...oldFive,importantText:invalid}),{...oldFive,importantText:null,memberText:'#000000'});
 assert.throws(()=>validateAppearance(oldFive),{code:'APPEARANCE_INVALID'});
});

test('explicit body color is never silently changed; low contrast warns while links remain readable',()=>{
 for(const [text,background] of [['#ffffff','#ffffff'],['#000000','#000000'],['#777777','#777777'],['#ff0000','#ff00ff']]){
  const selected={...defaultColors,importantText:text,importantBubble:background},theme=getAppearanceTheme(selected);
  assert.equal(theme.colors.importantText,text);assert.equal(theme.importantText,text);
  assert.ok(theme.warnings.some(warning=>warning.field==='importantText'&&warning.contrast<4.5));
  assert.ok(contrastRatio(theme.importantLink,background)>=4.5);assert.deepEqual(selected,{...defaultColors,importantText:text,importantBubble:background});
  const automatic=getAppearanceTheme({...selected,importantText:null});
  assert.ok(contrastRatio(automatic.importantText,background)>=4.5);assert.ok(!automatic.warnings.some(warning=>warning.field==='importantText'));
 }
});

test('browser UMD exports the same offline API without DOM, Node or network dependencies',()=>{
 const script=fs.readFileSync(path.join(__dirname,'../app/renderer/appearance.js'),'utf8'),context=vm.createContext({});
 vm.runInContext(script,context);
 const actual=JSON.parse(vm.runInContext('JSON.stringify(WeiyueAppearance.getAppearanceTheme({memberBubble:"#000"}))',context));
 assert.deepEqual(actual,getAppearanceTheme({memberBubble:'#000'}));
 assert.equal(vm.runInContext('WeiyueAppearance.normalizeHex("#AbC")',context),'#aabbcc');
 assert.equal(vm.runInContext('Object.isFrozen(WeiyueAppearance)',context),true);
});

test('six-field legacy colors gain black ordinary text in memory and preserve explicit or automatic important text',()=>{
 for(const importantText of ['#123456',null]){
  const oldSix={chatBackground:'#101010',memberName:'#abcdef',importantName:'#fedcba',memberBubble:'#222222',importantBubble:'#998877',importantText};
  const before=structuredClone(oldSix),normalized=normalizeAppearance(oldSix);
  assert.deepEqual(normalized,{...oldSix,memberText:'#000000'});assert.deepEqual(oldSix,before);
  assert.equal(getAppearanceTheme(oldSix).memberText,'#000000');
  assert.throws(()=>validateAppearance(oldSix),{code:'APPEARANCE_INVALID'});
 }
});

test('ordinary text is independent of important, nickname, system and link colors even at low contrast',()=>{
 for(const [text,background] of [['#ffffff','#ffffff'],['#000000','#000000'],['#777777','#777777'],['#ff0000','#ff00ff']]){
  const input={...defaultColors,memberText:text,memberBubble:background},theme=getAppearanceTheme(input);
  const baseline=getAppearanceTheme({...input,memberText:'#123456'});
  assert.equal(theme.memberText,text);assert.equal(theme.colors.memberText,text);
  assert.ok(theme.warnings.some(warning=>warning.field==='memberText'&&warning.contrast<MIN_CONTRAST));
  assert.ok(contrastRatio(theme.memberLink,background)>=MIN_CONTRAST);
  for(const field of ['chatText','chatLink','memberLink','importantText','importantLink'])assert.equal(theme[field],baseline[field]);
  for(const field of ['memberName','importantName','importantText','importantBubble','chatBackground'])assert.equal(theme.colors[field],baseline.colors[field]);
  assert.deepEqual(validateAppearance(input),input);
 }
});

test('invalid stored ordinary text falls back to black without evaluating accessors or altering valid colors',()=>{
 for(const invalid of [null,undefined,false,0,{},[],'red','var(--ink)','#ffffff80','#fff; color:red']){
  const input={...defaultColors,memberName:'#123456',importantText:null,memberText:invalid};
  assert.deepEqual(normalizeAppearance(input),{...defaultColors,memberName:'#123456',importantText:null,memberText:'#000000'});
  assert.throws(()=>validateAppearance(input),{code:'APPEARANCE_INVALID'});
 }
 let calls=0;const accessor={...defaultColors};Object.defineProperty(accessor,'memberText',{enumerable:true,get(){calls++;throw Error('must not execute');}});
 assert.deepEqual(normalizeAppearance(accessor),defaultColors);assert.equal(calls,0);
 assert.throws(()=>validateAppearance(accessor),{code:'APPEARANCE_INVALID'});assert.equal(calls,0);
 assert.equal(normalizeAppearance({...defaultColors,memberText:'#A3f'}).memberText,'#aa33ff');
});

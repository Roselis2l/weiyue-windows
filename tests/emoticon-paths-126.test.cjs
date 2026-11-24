'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const manifest=require('../app/renderer/emoticon-manifest.js'),source=require('../app/renderer/emoticons/extensions-source.json');
const {create}=require('../app/renderer/emoticons.js'),links=require('../app/renderer/linkify.js');
const {createEmoticonAssets}=require('../app/core/emoticon-assets.cjs');
const cases=[
 ['ee9095','E415','1F604',1113,'7eb8c1055f0124c787afc62964a811fbe638d6e0fc5c227178db07155c8bddae'],
 ['ee8cbe','E33E','1F35A',1060,'f29906390d86a7e449b8425d4a9cb428770c78676fa4f15a19aa526198a2d68e'],
 ['ee84bc','E13C','1F4A4',512,'50091d7fe5d3bfdab5e1ff32aceb5bba2c6a4fd57c71eb48bfb93ff5d316f443'],
 ['ee9094','E414','263A',1103,'2d41a3ace30bcd62e505a8e3875f35c87b731d7022e3c059117032ea2937e592'],
];
for(const [code,pua,unicode,bytes,sha256]of cases){
 test(code+' uses its exact verified official PNG and historical identity, not a named alias',()=>{
  const name='/'+code+'.png',entry=manifest[name],origin=source.pathCodes.entries.find(x=>x.name===name);
  assert.equal(entry.src,'app://local/emoticons/'+code+'.png');assert.equal(entry.sourceUrl,'https://img.t.sinajs.cn/t4/appstyle/expression/emimage/'+code+'.png');
  assert.equal(entry.bytes,bytes);assert.equal(entry.sha256,sha256);assert.equal(entry.width,20);assert.equal(entry.height,20);assert.equal(entry.animated,false);
  assert.equal(origin.sha256,sha256);assert.equal(origin.historicalEncoding.pua,pua);assert.equal(origin.historicalEncoding.unicode,unicode);
  assert.equal(Buffer.from(code,'hex').toString('utf8').codePointAt(0).toString(16).toUpperCase(),pua);
  assert.equal(origin.historicalEncoding.sourceSha256,'221369d8cabd3f6f217ba82cf25d41c0f97d283cefa6a9a66de1af69121418d3');
 });
 test(code+' is exact in mixed repeated fullwidth tokens and trailing variation selectors',()=>{
  const display=create({manifest,links}),token='[/'+code+'.png]',wide='【/'+code+'.png】';
  const text='中文，'+token+token+wide+'\ufe0f。'+token+'\ufe0e 链接 https://example.com/'+token+'?q='+wide+' 未知[/ee0000.png]';
  const parts=display.tokenize(text);assert.equal(parts.filter(x=>x.type==='emoticon').length,4);assert.equal(parts.filter(x=>x.type==='link').length,1);
  assert.equal(parts.map(x=>x.text).join(''),text);assert.equal(parts.filter(x=>x.type==='emoticon').every(x=>x.src===manifest['/'+code+'.png'].src),true);
  for(const bad of ['[/'+code+'.PNG]','[//'+code+'.png]','[/../'+code+'.png]','[/%'+code+'.png]','[[/'+code+'.png]]','[/'+code+'.png?x=1]'])assert.deepEqual(display.tokenize(bad),[{type:'text',text:bad}]);
 });
 test(code+' resource rejection leaves the exact token available for existing UI fallback',()=>{
  const entry=manifest['/'+code+'.png'],service=createEmoticonAssets({root:path.resolve(__dirname,'../app/renderer'),manifest,readFile(){throw Error('simulated missing file')}});
  assert.equal(service.serve({method:'GET',url:entry.src}).status,404);
  assert.equal(create({manifest,links}).tokenize('[/'+code+'.png]')[0].text,'[/'+code+'.png]');
 });
}

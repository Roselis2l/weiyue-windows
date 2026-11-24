'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app/decoder/video-worker.js'),'utf8');
async function run({extended=false,expectedDuration=253,progressTime=253000000,exit=0,bytes=new Uint8Array(32),output=new Uint8Array(32)}={}){
 const messages=[],calls={};let progress;
 const core={setLogger(){},setProgress(fn){progress=fn;},setTimeout(value){calls.timeout=value;},FS:{writeFile(name,value){calls.input=name;calls.inputBytes=value.length;},readFile(){return output;},unlink(){}},exec(...args){calls.args=args;progress({time:progressTime});return exit;}};
 const context=vm.createContext({Uint8Array,console:{},self:{postMessage(value){messages.push(value);},close(){calls.closed=true;}},importScripts(){},fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(32)}),createFFmpegCore:async()=>core});
 vm.runInContext(source,context);await context.self.onmessage({data:{bytes,extended,expectedDuration}});return {messages,calls};
}
const result=x=>x.messages.find(v=>v.type==='result'),error=x=>x.messages.find(v=>v.type==='error');
test('worker preserves original short quality, duration, frame, timeout and safe protocols',async()=>{
 const {calls,messages}=await run();assert.equal(calls.timeout,110000);assert.equal(calls.args[calls.args.indexOf('-vf')+1],'fps=24,scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p');
 for(const [flag,value] of [['-b:v','1200k'],['-frames:v','1440'],['-t','60'],['-max_pixels','12000000'],['-max_alloc','67108864'],['-protocol_whitelist','file'],['-c:a','libvorbis'],['-c:v','libvpx'],['-fs',String(64*1024*1024)]])assert.equal(calls.args[calls.args.indexOf(flag)+1],value);
 assert.ok(messages.some(x=>x.type==='result'));assert.equal(calls.closed,true);
});
test('manual long worker uses 360p15 VP8/Vorbis, 600k, bounded output and 290-second timeout',async()=>{
 const x=await run({extended:true});assert.ok(result(x));assert.equal(x.calls.timeout,290000);
 assert.equal(x.calls.args[x.calls.args.indexOf('-vf')+1],'fps=15,scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p');
 for(const [flag,value] of [['-b:v','600k'],['-frames:v','4500'],['-t','253'],['-fs',String(64*1024*1024)],['-c:v','libvpx'],['-c:a','libvorbis']])assert.equal(x.calls.args[x.calls.args.indexOf(flag)+1],value);
 assert.ok(!x.calls.args.includes('-shortest'));
});
test('long worker rejects incomplete progress, nonzero status, unbounded expected duration and output cap',async()=>{
 for(const options of [{progressTime:250000000},{progressTime:NaN},{exit:1},{expectedDuration:301},{expectedDuration:0},{expectedDuration:NaN},{output:new Uint8Array(64*1024*1024)}]){const x=await run({extended:true,...options});assert.ok(error(x));assert.ok(!result(x));assert.equal(x.calls.closed,true);}
 assert.ok(result(await run({extended:true,progressTime:252300000})));
});
test('worker only accepts explicit boolean true for extended quality and size envelope',async()=>{
 for(const extended of [false,undefined,1,'true']){const x=await run({extended});assert.equal(x.calls.timeout,110000);}
 for(const bytes of [new Uint8Array(0),new Uint16Array(3)])assert.ok(error(await run({extended:true,bytes})));
 const large=new Uint8Array(100*1024*1024+1);assert.equal(error(await run({bytes:large})).code,'VIDEO_LIMIT');assert.ok(result(await run({bytes:large,extended:true})));
});

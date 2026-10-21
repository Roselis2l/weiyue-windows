'use strict';
// Generate only a tiny artificial color-pattern HEVC clip. A separate Node
// worker is terminated at 30 seconds even if the encoder blocks internally.
const fs=require('node:fs'),path=require('node:path');
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
async function generate(appRoot){
 globalThis.self={location:{href:'app://video-decoder/video-worker.js'}};
 const create=require(path.join(appRoot,'decoder/ffmpeg/ffmpeg-core.js'));
 const core=await create({wasmBinary:fs.readFileSync(path.join(appRoot,'decoder/ffmpeg/ffmpeg-core.wasm'))});
 core.setLogger(()=>{});core.setProgress(()=>{});core.setTimeout(10000);
 const status=core.exec('-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=64x64:rate=4:duration=1',
  '-t','1','-an','-threads','1','-c:v','libx265','-preset','ultrafast',
  '-x265-params','pools=none:frame-threads=1:wpp=0:log-level=error','-pix_fmt','yuv420p','-tag:v','hvc1','-f','mp4','/synthetic.mp4');
 if(status!==0)throw new Error('SYNTHETIC_HEVC_GENERATION_FAILED');
 const bytes=Buffer.from(core.FS.readFile('/synthetic.mp4'));core.FS.unlink('/synthetic.mp4');return bytes;
}
function syntheticHevc(appRoot=path.resolve(__dirname,'../../app')){
 return new Promise((resolve,reject)=>{const worker=new Worker(__filename,{workerData:{syntheticHevc:true,appRoot}});let settled=false;
  const finish=(error,bytes)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(Buffer.from(bytes));};
  const timer=setTimeout(()=>finish(new Error('SYNTHETIC_HEVC_TIMEOUT')),30000);
  worker.once('message',value=>value.ok?finish(null,value.bytes):finish(new Error('SYNTHETIC_HEVC_GENERATION_FAILED')));
  worker.once('error',()=>finish(new Error('SYNTHETIC_HEVC_WORKER_FAILED')));worker.once('exit',()=>{if(!settled)finish(new Error('SYNTHETIC_HEVC_WORKER_EXIT'));});
 });
}
module.exports={syntheticHevc};
if(!isMainThread&&workerData?.syntheticHevc)generate(workerData.appRoot).then(bytes=>parentPort.postMessage({ok:true,bytes})).catch(()=>parentPort.postMessage({ok:false}));
else if(require.main===module)syntheticHevc().then(bytes=>{if(process.argv[2])fs.writeFileSync(path.resolve(process.argv[2]),bytes);console.log(JSON.stringify({bytes:bytes.length,info:require('../../app/core/video-decoder.cjs').inspectHevcMp4(bytes)}));}).catch(error=>{console.error(error.message);process.exitCode=1;});

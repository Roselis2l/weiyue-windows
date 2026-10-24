'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomBytes}=require('node:crypto'),{Worker}=require('node:worker_threads');
const mutationActions=new Set(['apply','purgeApply','restore']);
async function fileHash(file){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function stamp(s){return[s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}
async function runCleanupTask(store,accountId,action,payload,{onProgress=()=>{},jobId=randomBytes(16).toString('hex'),workerFactory,rename=fs.promises.rename}={}){
  const mutating=mutationActions.has(action),release=mutating?store._acquireWriteLock(accountId):()=>{},file=store._file(accountId);
  const expectedTemporary=file+'.cleanup-'+jobId+'.tmp';
  let prepared,commitState='not-committed';
  try{
    const reply=await new Promise((resolve,reject)=>{
      let outcome,failed=false;
      const make=workerFactory||((script,options)=>new Worker(script,options));
      const worker=make(path.join(__dirname,'message-cleanup-worker.cjs'),{workerData:{file,accountId,action,payload,jobId}});
      worker.on('message',message=>{
        if(message?.type==='progress'){onProgress(message);return;}
        if(['prepared','done','failure'].includes(message?.type))outcome=message;
      });
      worker.on('error',()=>{failed=true;reject(Error('本地数据处理线程失败；原账号文件未修改。'));});
      worker.on('exit',code=>{
        if(failed)return;
        if(code!==0||!outcome)return reject(Error('本地数据处理未完成；原账号文件未修改。'));
        if(outcome.type==='failure')return reject(Error(outcome.message));
        resolve(outcome);
      });
    });
    if(reply.type==='done')return reply.result;
    prepared=reply;
    if(!mutating||reply.temporary!==expectedTemporary||!/^[a-f0-9]{64}$/.test(reply.baseHash)||!/^[a-f0-9]{64}$/.test(reply.sha256))throw Error('清理准备结果无效；原账号文件未修改。');
    if(await fileHash(expectedTemporary)!==reply.sha256)throw Error('清理临时文件校验失败；原账号文件未修改。');
    const before=stamp(await fs.promises.stat(file,{bigint:true}));
    if(await fileHash(file)!==reply.baseHash||stamp(await fs.promises.stat(file,{bigint:true}))!==before)throw Error('账号数据在操作期间变化；原账号文件未覆盖，请重新预览。');
    onProgress({phase:'committing',processed:null,total:null});
    try{await rename(expectedTemporary,file);commitState='committed';}
    catch{
      let actual,tempPresent;try{actual=await fileHash(file);try{await fs.promises.stat(expectedTemporary);tempPresent=true;}catch(error){if(error.code!=='ENOENT')throw error;tempPresent=false;}}catch{commitState='uncertain';throw Error('提交结果暂时无法核实，请勿重复操作；请保留数据与备份后检查。');}
      if(actual===reply.sha256&&!tempPresent)commitState='committed';
      else if(actual===reply.baseHash&&tempPresent)throw Error('保存本地数据失败；原账号文件未修改，请检查磁盘空间或文件占用。');
      else{commitState='uncertain';throw Error('账号文件在提交时变化，结果待核实；请勿重复操作。');}
    }
    prepared=undefined;
    store._invalidateSnapshot(accountId);
    return {...reply.result,commitState};
  }catch(error){if(commitState==='uncertain')store._invalidateSnapshot(accountId);const failure=/^[\u4e00-\u9fff]/.test(error.message||'')?error:Error('本地数据处理失败；当前清理操作未提交。');failure.commitState=commitState;throw failure;}finally{
    // Prepared temp files contain private content, but deleting this disposable
    // file cannot delete user messages: the authoritative account is untouched.
    if(commitState!=='uncertain'&&prepared?.temporary===expectedTemporary)try{await fs.promises.unlink(expectedTemporary);}catch{}
    release();
  }
}
module.exports={runCleanupTask,fileHash};

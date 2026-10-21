'use strict';
const {createHash}=require('node:crypto');
const {AvatarDirectory,AvatarCache}=require('./avatar-cache.cjs');
const {safeAvatarUrl}=require('./avatar.cjs');
const {fetchImage}=require('./media.cjs');

const tokenFor=context=>createHash('sha256').update(context.owner+'|'+context.epoch).digest('hex').slice(0,32);
function abortable(promise,signal){
  if(signal.aborted)return Promise.reject(new Error('Canceled'));
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(new Error('Canceled'));};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
class AvatarService{
  constructor({getContext,getState,restoreSession,defaultSession,request,loadImage=fetchImage,timeoutMs=8000}){
    Object.assign(this,{getContext,getState,restoreSession,defaultSession,request,loadImage,timeoutMs});
    this.directory=new AvatarDirectory();this.cache=new AvatarCache();this.jobs=new Map();this.waiters=[];this.active=0;
  }
  clear(){
    for(const job of this.jobs.values())job.controller.abort();
    this.cache.clear();this.directory.reset();this.accountKind=null;
  }
  context(){
    const context=this.getContext();
    if(this.directory.owner!==context.owner||this.directory.revision!==context.revision){
      const state=context.state||this.getState(context.owner);
      this.directory.update(context.owner,context.revision,state);this.accountKind=state.account.kind;
    }
    return {...context,accountKind:this.accountKind};
  }
  source(kind,id){
    const context=this.context();
    return this.directory.source(tokenFor(context),kind,id);
  }
  async acquire(signal){
    if(this.active<4){this.active++;return;}
    if(this.waiters.length>=100)throw new Error('Queue full');
    await new Promise((resolve,reject)=>{
      const waiter={resolve:()=>{signal.removeEventListener('abort',abort);resolve();}};
      const abort=()=>{const index=this.waiters.indexOf(waiter);if(index>=0)this.waiters.splice(index,1);reject(new Error('Canceled'));};
      signal.addEventListener('abort',abort,{once:true});this.waiters.push(waiter);
      if(signal.aborted)abort();
    });
  }
  release(){
    const next=this.waiters.shift();
    if(next)next.resolve();else this.active--;
  }
  async serve(request,u){
    const context=this.context();let parts;
    try{parts=u.pathname.slice(1).split('/').map(decodeURIComponent);}catch{return new Response('',{status:400});}
    if(request.method!=='GET'||u.host!=='avatar'||u.search||u.hash||parts.length!==4||parts[0]!==tokenFor(context)||!['group','member'].includes(parts[1]))return new Response('',{status:404});
    const descriptor=this.directory.descriptor(parts[1],parts[2]);
    if(!descriptor||descriptor.version!==parts[3])return new Response('',{status:404});
    const key=parts[0]+'|'+descriptor.url;
    let entry=this.cache.get(key);
    const current=()=>{
      const now=this.getContext();
      return now.owner===context.owner&&now.epoch===context.epoch&&!now.closing;
    };
    if(!entry){
      let job=this.jobs.get(key);
      if(!job){
        const controller=new AbortController();job={controller};
        job.promise=(async()=>{
          let acquired=false,timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},this.timeoutMs);
          const check=()=>{if(controller.signal.aborted||!current())throw new Error('Canceled');};
          try{
            await this.acquire(controller.signal);acquired=true;check();
            const s=context.accountKind==='weibo'
              ?await abortable(this.restoreSession(context.owner,{check}),controller.signal)
              :this.defaultSession();
            check();
            const value=await this.loadImage({url:descriptor.url,signal:controller.signal,timeoutMs:this.timeoutMs,maxBytes:1024*1024,
              fetch:(target,options)=>{
                if(!safeAvatarUrl(target))throw new Error('Avatar destination unavailable');
                return this.request(s,target,options);
              }});
            check();this.cache.put(key,value);return value;
          }catch{
            if(current()&&(!controller.signal.aborted||timedOut))this.cache.put(key,null);
            return null;
          }finally{
            clearTimeout(timer);if(acquired)this.release();
            if(this.jobs.get(key)===job)this.jobs.delete(key);
          }
        })();this.jobs.set(key,job);
      }
      entry={value:await job.promise};
    }
    if(!current())return new Response('',{status:403});
    if(!entry.value)return new Response('',{status:404,headers:{'Cache-Control':'no-store'}});
    return new Response(entry.value.bytes,{headers:{'Content-Type':entry.value.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'app://local'}});
  }
}
module.exports={AvatarService,tokenFor};

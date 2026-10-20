'use strict';
function loginError(code,message){const e=new Error(message);e.code=code;return e;}
class LoginFlow{
  constructor({timeoutMs=60000}={}){this.timeoutMs=timeoutMs;this.controller=null;this.state={running:false,stage:'idle',message:'请在官方窗口完成登录后读取群聊。',timeoutMs};}
  status(){return {...this.state};}
  setStage(stage,message){this.state={...this.state,stage,message};}
  cancel(){if(!this.controller)return {...this.status(),canceled:false};this.controller.abort(loginError('LOGIN_CANCELED','已取消读取，官方登录会话仍保留。'));return {...this.status(),canceled:true};}
  async run({client,save}){
    if(this.state.running)throw loginError('LOGIN_BUSY','正在读取群聊，请等待或取消当前读取。');
    const controller=new AbortController();this.controller=controller;
    this.state={running:true,stage:'identity',message:'正在确认官方登录身份…',startedAt:Date.now(),timeoutMs:this.timeoutMs,error:null};
    const check=()=>{if(controller.signal.aborted)throw controller.signal.reason;};
    let timer,onAbort;
    const interrupted=new Promise((_,reject)=>{
      onAbort=()=>reject(controller.signal.reason);
      controller.signal.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>controller.abort(loginError('LOGIN_TIMEOUT','读取群聊超时，已停止本次请求。登录会话仍保留，请检查网络后重试。')),this.timeoutMs);
    });
    const task=(async()=>{
      const options={signal:controller.signal};
      const connection=typeof client==='function'?await client({signal:controller.signal,check}):client;check();
      const identity=await connection.identity(options);check();
      this.setStage('groups','身份已确认，正在读取可访问的群列表…');
      const groups=await connection.groups(options);check();
      this.setStage('verify',`已读取 ${groups.length} 个群，正在复核账号…`);
      const verified=await connection.identity(options);check();
      if(identity.id!==verified.id)throw loginError('LOGIN_CHANGED','登录账号发生变化，未保存群列表。请在官方页面确认账号后重试。');
      this.setStage('saving','正在保存账号和加密登录会话…');
      const result=await save({identity,groups,signal:controller.signal,check});check();
      return result;
    })();
    try{const result=await Promise.race([task,interrupted]);this.setStage('completed','群列表读取成功，可以选择要同步的群。');return result;}
    catch(error){const e=controller.signal.aborted?controller.signal.reason:error;this.state={...this.state,stage:e.code==='LOGIN_CANCELED'?'canceled':'error',message:e.message,error:e.message,code:e.code||'LOGIN_FAILED'};throw e;}
    finally{clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);this.state.running=false;this.controller=null;}
  }
}
module.exports={LoginFlow};

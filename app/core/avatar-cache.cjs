'use strict';

const {createHash}=require('node:crypto');
const {safeAvatarUrl}=require('./avatar.cjs');
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value);
const validOwner=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\u0000-\u001f\u007f]/.test(value);
const validKey=value=>typeof value==='string'&&value.length>0&&value.length<=8192&&!/[\u0000-\u001f\u007f]/.test(value);
const AVATAR_MIMES=new Set(['image/png','image/jpeg','image/gif','image/webp']);
const MAX_ENTRIES=512;
function invalid(){throw new Error('头像缓存参数无效。');}

// Avatars are independent of message media and summaries. Cache keys include
// the owning account; the browser receives only a local, versioned proxy URL.
class AvatarDirectory {
  constructor(){this.reset();}
  reset(){this.owner=null;this.revision=null;this.groups=new Map();this.members=new Map();}
  update(owner,revision,state){
    if(!validOwner(owner)||!state||typeof state!=='object'||Array.isArray(state)){this.reset();invalid();}
    if(owner===this.owner&&revision===this.revision)return;
    this.reset();this.owner=owner;this.revision=revision;
    for(const group of Array.isArray(state.groups)?state.groups:[]){
      if(!group||!validId(group.id))continue;
      const url=safeAvatarUrl(group.avatarUrl);
      if(url)this.groups.set(group.id,url);
    }
    const times=new Map();
    for(const message of Array.isArray(state.messages)?state.messages:[]){
      if(!message||!validId(message.senderId)||!Number.isSafeInteger(message.time)||message.time<0)continue;
      const id=message.senderId,url=safeAvatarUrl(message.senderAvatarUrl);
      if(!url||id.startsWith('unknown:'))continue;
      const time=message.time;
      if(!times.has(id)||time>=times.get(id)){times.set(id,time);this.members.set(id,url);}
    }
  }
  descriptor(kind,id){
    if(!validId(id))return null;
    const url=(kind==='group'?this.groups:kind==='member'?this.members:null)?.get(id);
    return url?{url,version:createHash('sha256').update(url).digest('hex').slice(0,20)}:null;
  }
  source(token,kind,id){
    if(!validOwner(token))return undefined;
    const descriptor=this.descriptor(kind,id);
    return descriptor?'app://avatar/'+[token,kind,id,descriptor.version].map(encodeURIComponent).join('/'):undefined;
  }
}

class AvatarCache {
  #entries=new Map();
  #bytes=0;
  constructor({maxBytes=16*1024*1024,ttlMs=15*60000,errorTtlMs=60000,now=Date.now}={}){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<0||!Number.isSafeInteger(ttlMs)||ttlMs<1||
      !Number.isSafeInteger(errorTtlMs)||errorTtlMs<1||typeof now!=='function')invalid();
    Object.defineProperties(this,Object.fromEntries(Object.entries({maxBytes,ttlMs,errorTtlMs,now})
      .map(([key,value])=>[key,{value,enumerable:true}])));
  }
  // Diagnostics expose snapshots, never mutable storage or shared buffers.
  get bytes(){return this.#bytes;}
  get entries(){return new Map([...this.#entries].map(([key,entry])=>[key,this.snapshot(entry)]));}
  snapshot(entry){return {value:entry.value?{bytes:Buffer.from(entry.value.bytes),mime:entry.value.mime}:null,expires:entry.expires};}
  clock(){const value=this.now();if(!Number.isSafeInteger(value)||value<0)invalid();return value;}
  clear(){this.#entries.clear();this.#bytes=0;}
  remove(key){const entry=this.#entries.get(key);if(entry){this.#bytes-=entry.size;this.#entries.delete(key);}}
  get(key){
    if(!validKey(key))return null;
    const entry=this.#entries.get(key);
    if(!entry)return null;
    if(entry.expires<=this.clock()){this.remove(key);return null;}
    this.#entries.delete(key);this.#entries.set(key,entry);return this.snapshot(entry);
  }
  put(key,value){
    if(!validKey(key))invalid();
    if(value!==null&&(!value||!(value.bytes instanceof Uint8Array)||!value.bytes.byteLength||!AVATAR_MIMES.has(value.mime)))invalid();
    const size=value===null?0:value.bytes.byteLength,now=this.clock(),expires=now+(value===null?this.errorTtlMs:this.ttlMs);
    if(!Number.isSafeInteger(expires))invalid();
    if(size>this.maxBytes)return false;
    const copy=value===null?null:{bytes:Buffer.from(value.bytes),mime:value.mime};
    // Expired entries cannot cause eviction of a still-live recently used item.
    for(const [oldKey,entry]of this.#entries)if(entry.expires<=now)this.remove(oldKey);
    this.remove(key);
    while(this.#bytes+size>this.maxBytes||this.#entries.size>=MAX_ENTRIES)this.remove(this.#entries.keys().next().value);
    this.#entries.set(key,{value:copy,expires,size});this.#bytes+=size;
    return true;
  }
}

module.exports={AvatarDirectory,AvatarCache};

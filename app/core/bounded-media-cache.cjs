'use strict';
// Validated originals only; process memory, never a new on-disk media archive.
class BoundedMediaCache {
  constructor(limit){if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid cache limit');this.limit=limit;this.bytes=0;this.items=new Map();}
  get(key){const value=this.items.get(key);if(value){this.items.delete(key);this.items.set(key,value);}return value;}
  set(key,value){
    if(typeof key!=='string'||!Buffer.isBuffer(value?.bytes))throw new Error('Invalid cached media');
    const old=this.items.get(key);if(old){this.bytes-=old.bytes.length;this.items.delete(key);}
    if(value.bytes.length>this.limit)return false;
    while(this.bytes+value.bytes.length>this.limit&&this.items.size){const first=this.items.keys().next().value;this.bytes-=this.items.get(first).bytes.length;this.items.delete(first);}
    this.items.set(key,value);this.bytes+=value.bytes.length;return true;
  }
  clear(){this.items.clear();this.bytes=0;}
}
module.exports={BoundedMediaCache};

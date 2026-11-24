'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function officialUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['weibo.com','weibo.cn','sina.com.cn'].some(d => u.hostname === d || u.hostname.endsWith('.'+d)); } catch { return false; }
}
function safeExternal(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && value.length < 2048; } catch { return false; }
}
function redact(value, secrets = []) {
  let s = String(value || '操作失败，请重试。');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length > 3) s = s.split(secret).join('[已隐藏]');
  return s.replace(/(bearer\s+)[^\s]+/gi,'$1[已隐藏]').replace(/(cookie|authorization|api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+/gi,'$1=[已隐藏]').slice(0,600);
}
class Vault {
  constructor(root, safeStorage) { this.root=root; this.safe=safeStorage; fs.mkdirSync(root,{recursive:true}); }
  file(id) { return path.join(this.root,crypto.createHash('sha256').update(String(id)).digest('hex')+'.bin'); }
  read(id) {
    const file=this.file(id); if (!fs.existsSync(file)) return {};
    if (!this.safe.isEncryptionAvailable()) throw new Error('Windows 凭据保护不可用，无法读取密钥。');
    try { return JSON.parse(this.safe.decryptString(fs.readFileSync(file))); } catch { throw new Error('凭据无法解密。请在原 Windows 用户下使用，或重新配置本账号凭据。'); }
  }
  write(id,value) {
    if (!this.safe.isEncryptionAvailable()) throw new Error('Windows 凭据保护不可用，未保存任何密钥。');
    const file=this.file(id), temp=file+'.tmp';
    fs.writeFileSync(temp,this.safe.encryptString(JSON.stringify(value)),{mode:0o600});
    fs.renameSync(temp,file);
  }
}
module.exports={officialUrl,safeExternal,redact,Vault};

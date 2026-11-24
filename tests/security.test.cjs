const {test}=require('node:test'); const assert=require('node:assert/strict');
const {officialUrl,safeExternal,redact,Vault}=require('../app/core/security.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('login host allowlist rejects spoofing, non-https, userinfo and ports',()=>{
  for(const u of ['https://api.weibo.com/chat','https://passport.weibo.cn/']) assert.equal(officialUrl(u),true);
  for(const u of ['https://weibo.com.evil.org','https://evilweibo.com','http://weibo.com','https://evil@weibo.com','file:///x','https://weibo.com:123']) assert.equal(officialUrl(u),false);
});
test('external schemes and secret redaction',()=>{
  assert.equal(safeExternal('javascript:alert(1)'),false); assert.equal(safeExternal('file:///a'),false);
  assert.equal(safeExternal('https://example.com'),true);
  assert.ok(!redact('bad secret-123 Cookie=hello Bearer abc',['secret-123']).includes('secret-123'));
  assert.ok(!redact('bad Cookie=hello Bearer abc').includes('hello'));
});
test('vault never writes plaintext and refuses unavailable OS encryption',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-vault-'));
  const safe={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from([...s].reverse().join('')),decryptString:b=>[...b.toString()].reverse().join('')};
  const vault=new Vault(dir,safe); vault.write('../account',{aiKey:'test-secret'});
  assert.deepEqual(vault.read('../account'),{aiKey:'test-secret'});
  assert.ok(!fs.readFileSync(vault.file('../account'),'utf8').includes('test-secret'));
  safe.isEncryptionAvailable=()=>false;
  assert.throws(()=>vault.write('other',{x:1}),/不可用/);
  fs.rmSync(dir,{recursive:true,force:true});
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AvatarService}=require('../app/core/avatar-service.cjs');
const valid='https://tvax1.sinaimg.cn/avatar/member.jpg';
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
function setup(extra={}){
  let context={owner:'account-a',epoch:1,revision:1,closing:false,state:{account:{kind:'weibo'},groups:[{id:'same/name',avatarUrl:valid}],messages:[{id:'1',senderId:'member-a',senderAvatarUrl:valid,time:100}]}};
  const calls=[];
  const service=new AvatarService({getContext:()=>context,restoreSession:async owner=>({owner}),defaultSession:()=>({default:true}),
    request:async(s,url,options)=>{calls.push({s,url,options});return new Response(png,{headers:{'content-type':'image/png'}});},...extra});
  return {service,calls,get context(){return context;},set context(next){context=next;}};
}
const serve=(service,src,method='GET')=>service.serve({method},new URL(src));
test('many visible messages read the account archive only once per revision',async()=>{
  let reads=0,revision=1;
  const service=new AvatarService({getContext:()=>({owner:'one',epoch:1,revision,closing:false}),
    getState:()=>{reads++;return {account:{kind:'demo'},groups:[],messages:[{senderId:'u',time:1,senderAvatarUrl:valid}]};},
    defaultSession:()=>({}),request:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
  for(let i=0;i<160;i++)service.source('member','u');
  assert.equal(reads,1);
  await serve(service,service.source('member','u'));assert.equal(reads,1);
  revision++;service.source('member','u');assert.equal(reads,2);
});
test('avatar proxy exposes versioned local URLs and shares bounded bytes without changing media',async()=>{
  const {service,calls}=setup();const source=service.source('group','same/name');
  assert.match(source,/^app:\/\/avatar\/[a-f0-9]{32}\/group\/same%2Fname\/[a-f0-9]{20}$/);
  const response=await serve(service,source);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  assert.equal((await serve(service,service.source('member','member-a'))).status,200);
  assert.equal(calls.length,1);assert.equal(calls[0].s.owner,'account-a');
  assert.equal(calls[0].options.credentials,'include');
});
test('proxy rejects obsolete versions, account tokens, methods and unknown identities before I/O',async()=>{
  const env=setup(),source=env.service.source('group','same/name');
  for(const bad of [source.replace('/group/','/other/'),source.replace(/.$/,'x'),source+'?url=https://evil.example/',source.replace('same%2Fname','missing')]){
    assert.equal((await serve(env.service,bad)).status,404);
  }
  assert.equal((await serve(env.service,source,'POST')).status,404);
  env.context={...env.context,owner:'account-b',epoch:2};
  assert.equal((await serve(env.service,source)).status,404);
  assert.equal(env.calls.length,0);
});
test('failed and oversize images use default fallback; failures are cached without response details',async()=>{
  let count=0;const env=setup({request:async()=>{count++;return new Response('Forbidden secret trace',{status:403});}});
  const src=env.service.source('member','member-a');
  const response=await serve(env.service,src);
  assert.equal(response.status,404);assert.equal(await response.text(),'');
  assert.equal((await serve(env.service,src)).status,404);assert.equal(count,1);
  const big=setup({request:async()=>new Response(png,{headers:{'content-type':'image/png','content-length':String(1024*1024+1)}})});
  assert.equal((await serve(big.service,big.service.source('member','member-a'))).status,404);
});
test('avatar redirects cannot send requests to the message attachment endpoint',async()=>{
  let count=0;const env=setup({request:async()=>{count++;return new Response(null,{status:302,headers:{location:'https://upload.api.weibo.com/2/mss/msget?fid=123&source=209678993&imageType=origin'}});}});
  assert.equal((await serve(env.service,env.service.source('member','member-a'))).status,404);assert.equal(count,1);
});
test('avatar restore timeout and account switch cancel hung restoration without caching another account',async()=>{
  const env=setup({timeoutMs:20,restoreSession:()=>new Promise(()=>{})});
  const result=await serve(env.service,env.service.source('member','member-a'));
  assert.equal(result.status,404);assert.equal(env.service.active,0);
  assert.equal(env.service.cache.entries.size,1);
  const pending=setup({restoreSession:()=>new Promise(()=>{})});
  const src=pending.service.source('member','member-a');
  const waiting=serve(pending.service,src);
  await new Promise(r=>setImmediate(r));
  pending.context={...pending.context,owner:'account-b',epoch:2};pending.service.clear();
  assert.equal((await waiting).status,403);assert.equal(pending.service.cache.bytes,0);
});
test('avatar requests are deduplicated and concurrency stays within four',async()=>{
  const releases=[];let active=0,max=0,total=0;
  const env=setup({loadImage:async options=>{
    assert.equal(options.maxBytes,1024*1024);active++;max=Math.max(max,active);total++;
    await new Promise(resolve=>releases.push(resolve));active--;return {bytes:png,mime:'image/png'};
  }});
  env.context.state.groups=Array.from({length:7},(_,i)=>({id:String(i),avatarUrl:`https://tvax1.sinaimg.cn/avatar/${i}.jpg`}));
  const sources=env.context.state.groups.map(g=>env.service.source('group',g.id));
  const requests=sources.map(src=>serve(env.service,src));requests.push(serve(env.service,sources[0]));
  await new Promise(r=>setImmediate(r));assert.equal(total,4);assert.equal(max,4);
  releases.splice(0).forEach(r=>r());
  await new Promise(r=>setImmediate(r));assert.equal(total,7);
  releases.splice(0).forEach(r=>r());
  const responses=await Promise.all(requests);assert.ok(responses.every(r=>r.status===200));
  assert.equal(max,4);assert.equal(env.service.active,0);assert.equal(env.service.waiters.length,0);
});

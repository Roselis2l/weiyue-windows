'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AvatarDirectory,AvatarCache}=require('../app/core/avatar-cache.cjs');

test('avatar directory binds explicit group and sender IDs, ignores unknown senders, and refreshes by revision/account',()=>{
  const directory=new AvatarDirectory();
  directory.update('one',1,{groups:[{id:'g/1',avatarUrl:'https://wx1.sinaimg.cn/group.png'}],messages:[
    {senderId:'u1',senderAvatarUrl:'https://wx1.sinaimg.cn/older.png',time:1},
    {senderId:'u1',senderAvatarUrl:'https://wx1.sinaimg.cn/newer.png',time:2},
    {senderId:'u2',senderAvatarUrl:'https://wx1.sinaimg.cn/second.png',time:1},
    {senderId:'unknown:1',senderAvatarUrl:'https://wx1.sinaimg.cn/unconfirmed.png',time:5}]});
  assert.equal(directory.descriptor('member','u1').url,'https://wx1.sinaimg.cn/newer.png');
  assert.equal(directory.descriptor('group','u1'),null);
  assert.equal(directory.descriptor('member','unknown:1'),null);
  assert.match(directory.source('account-epoch','group','g/1'),/^app:\/\/avatar\/account-epoch\/group\/g%2F1\/[a-f0-9]{20}$/);
  const first=directory.source('a','member','u1');
  directory.update('one',2,{groups:[],messages:[{senderId:'u1',senderAvatarUrl:'https://wx1.sinaimg.cn/changed.png',time:2}]});
  assert.notEqual(directory.source('a','member','u1'),first);
  directory.update('two',2,{groups:[],messages:[]});
  assert.equal(directory.descriptor('member','u1'),null);
});

test('avatar cache is bounded, expires success and failure, and eviction accounts for exact bytes',()=>{
  let now=0;const cache=new AvatarCache({maxBytes:6,ttlMs:100,errorTtlMs:10,now:()=>now});
  cache.put('account-a|x',{bytes:Buffer.alloc(4),mime:'image/png'});
  cache.put('account-a|bad',null);
  assert.equal(cache.get('account-a|bad').value,null);
  assert.equal(cache.get('account-b|x'),null);
  now=11;assert.equal(cache.get('account-a|bad'),null);
  cache.put('account-a|y',{bytes:Buffer.alloc(4),mime:'image/png'});
  assert.equal(cache.get('account-a|x'),null);assert.equal(cache.bytes,4);
  now=111;assert.equal(cache.get('account-a|y'),null);assert.equal(cache.bytes,0);
  cache.put('large',{bytes:Buffer.alloc(7),mime:'image/png'});assert.equal(cache.get('large'),null);
  cache.put('small',{bytes:Buffer.alloc(2),mime:'image/png'});cache.clear();assert.equal(cache.bytes,0);assert.equal(cache.entries.size,0);
});

test('directory drops unsafe IDs and times instead of deriving identities from coercion or nicknames',()=>{
  const directory=new AvatarDirectory(),url='https://wx1.sinaimg.cn/mock.png';
  const badIds=[undefined,null,{},[],1,Number.MAX_SAFE_INTEGER+1,'',' ','x'.repeat(257),'member\u0000id'];
  directory.update('account',1,{groups:[
    ...badIds.map(id=>({id,name:'相同群名',avatarUrl:url})),{id:'good-group',name:'相同群名',avatarUrl:url}
  ],messages:[
    ...badIds.map(senderId=>({senderId,senderName:'同名',senderAvatarUrl:url,time:1})),
    ...[undefined,null,'10',NaN,Infinity,-1,1.5].map(time=>({senderId:'bad-time',senderAvatarUrl:url,time})),
    {senderId:'good-member',senderName:'同名',senderAvatarUrl:url,time:1},
    {senderId:'other-member',senderName:'同名',time:2},
  ]});
  assert.equal(directory.groups.size,1);assert.equal(directory.members.size,1);
  assert.equal(directory.descriptor('member','other-member'),null);
  assert.equal(directory.descriptor('member','同名'),null);
  for(const id of badIds)assert.equal(directory.descriptor('group',id),null);
  assert.equal(directory.source('token','member','other-member'),undefined);
  assert.equal(directory.source('', 'group','good-group'),undefined);
  assert.equal(directory.source('token','unsupported','good-group'),undefined);
  assert.throws(()=>directory.update(null,2,{groups:[],messages:[]}),/参数无效/);
  assert.equal(directory.descriptor('group','good-group'),null,'Invalid context must not keep an old account directory');
});

test('directory caches only the documented account revision and preserves valid avatar when newer record omits one',()=>{
  const directory=new AvatarDirectory(),first='https://wx1.sinaimg.cn/first.png',second='https://wx1.sinaimg.cn/second.png';
  directory.update('account',1,{groups:[],messages:[
    {senderId:'u',senderAvatarUrl:first,time:1},{senderId:'u',time:2},
    {senderId:'u',senderAvatarUrl:'https://unapproved.example/portrait.png',time:3},
  ]});
  assert.equal(directory.descriptor('member','u').url,first);
  directory.update('account',1,{groups:[],messages:[{senderId:'u',senderAvatarUrl:second,time:4}]});
  assert.equal(directory.descriptor('member','u').url,first);
  directory.update('account',2,{groups:[],messages:[{senderId:'u',senderAvatarUrl:second,time:4}]});
  assert.equal(directory.descriptor('member','u').url,second);
  directory.update('new-account',2,{groups:[],messages:[]});
  assert.equal(directory.descriptor('member','u'),null);
});

test('cache copies input and returned bytes so mutation cannot cross accounts or bypass byte accounting',()=>{
  const cache=new AvatarCache({maxBytes:8});
  const first={bytes:Buffer.from([1,2,3]),mime:'image/png'};
  cache.put('account-a|url',first);
  first.bytes.fill(9);first.bytes=Buffer.alloc(1000);first.mime='image/svg+xml';
  const entry=cache.get('account-a|url');
  assert.deepEqual([...entry.value.bytes],[1,2,3]);assert.equal(entry.value.mime,'image/png');
  entry.value.bytes.fill(7);entry.value.bytes=Buffer.alloc(5000);entry.expires=0;
  const diagnostics=cache.entries;diagnostics.get('account-a|url').value.bytes.fill(8);diagnostics.clear();
  assert.equal(cache.bytes,3);assert.equal(cache.entries.size,1);
  assert.deepEqual([...cache.get('account-a|url').value.bytes],[1,2,3]);
  assert.equal(cache.get('account-b|url'),null);
  assert.throws(()=>{cache.maxBytes=-1;},TypeError);
});

test('success LRU and expired pruning never evict a live entry to retain expired bytes',()=>{
  let now=0;const cache=new AvatarCache({maxBytes:4,ttlMs:100,now:()=>now});
  const value={bytes:Buffer.from([1,2]),mime:'image/png'};
  cache.put('a',value);now=50;cache.put('b',value);
  cache.get('a'); // A is most recently used, but still expires before B.
  now=101;cache.put('c',value);
  assert.equal(cache.get('a'),null);
  assert.ok(cache.get('b'));assert.ok(cache.get('c'));assert.equal(cache.bytes,4);
  cache.get('b');cache.put('d',value);
  assert.equal(cache.get('c'),null);assert.ok(cache.get('b'));assert.ok(cache.get('d'));
  cache.put('b',{bytes:Buffer.from([3]),mime:'image/webp'});
  assert.equal(cache.bytes,3);assert.equal(cache.get('b').value.mime,'image/webp');
});

test('negative cache has an independent fixed expiry and is bounded even with zero payload bytes',()=>{
  let now=0;const cache=new AvatarCache({maxBytes:0,ttlMs:100,errorTtlMs:10,now:()=>now});
  for(let i=0;i<512;i++)cache.put('account|missing-'+i,null);
  assert.equal(cache.entries.size,512);assert.equal(cache.bytes,0);
  assert.equal(cache.get('account|missing-0').value,null);
  cache.put('account|missing-512',null);
  assert.ok(cache.get('account|missing-0'));assert.equal(cache.get('account|missing-1'),null);
  assert.equal(cache.put('positive',{bytes:Buffer.from([1]),mime:'image/png'}),false);
  assert.equal(cache.entries.size,512);
  now=10;assert.equal(cache.get('account|missing-0'),null);
  cache.put('later',null);assert.equal(cache.entries.size,1);
  now=19;assert.equal(cache.get('later').value,null);
  now=20;assert.equal(cache.get('later'),null);assert.equal(cache.bytes,0);
});

test('malformed config and values fail safely without poisoning existing cache entries',()=>{
  for(const options of [{maxBytes:-1},{maxBytes:NaN},{maxBytes:1.1},{ttlMs:0},{errorTtlMs:-1},{now:1}]){
    assert.throws(()=>new AvatarCache(options),/参数无效/);
  }
  const cache=new AvatarCache({maxBytes:4});
  cache.put('kept',{bytes:Buffer.from([1]),mime:'image/png'});
  for(const value of [undefined,{},false,{bytes:'123',mime:'image/png'},{bytes:Buffer.alloc(0),mime:'image/png'},
    {bytes:Buffer.alloc(2),mime:'image/svg+xml'},{bytes:Buffer.alloc(2),mime:'text/html'}]){
    assert.throws(()=>cache.put('kept',value),/参数无效/);
  }
  assert.deepEqual([...cache.get('kept').value.bytes],[1]);assert.equal(cache.bytes,1);
  assert.equal(cache.put('kept',{bytes:Buffer.alloc(5),mime:'image/png'}),false);
  assert.deepEqual([...cache.get('kept').value.bytes],[1]);
  for(const key of ['',{},null,'x'.repeat(8193),'bad\nkey']){
    assert.throws(()=>cache.put(key,null),/参数无效/);assert.equal(cache.get(key),null);
  }
  assert.throws(()=>new AvatarCache({now:()=>NaN}).put('test',null),/参数无效/);
});

test('directory proxy sources and cache bytes never enter selected chat summary data',()=>{
  const {prepareSummary,prepareAiSummary}=require('../app/core/summary.cjs');
  const {prepareSummaryContent}=require('../app/core/summary-content.cjs');
  const messages=[{id:'1',groupId:'g',senderId:'u',senderName:'模拟成员',time:1000,text:'模拟正文',senderAvatarUrl:'https://wx1.sinaimg.cn/portrait.png'}];
  const group={id:'g',name:'模拟群',avatarUrl:'https://wx1.sinaimg.cn/group.png'};
  const directory=new AvatarDirectory();directory.update('mock-account',1,{groups:[group],messages});
  assert.ok(directory.source('token','member','u'));
  const prepared=prepareSummary({messages,group,start:0,end:2000});
  return prepareSummaryContent(prepared,{messages,loadImage:()=>{throw new Error('An avatar must never trigger summary image loading');}}).then(resolved=>{
    const result=prepareAiSummary(prepared,{endpoint:'https://api.openai.com/v1',model:'gpt-6-astra',content:resolved.content});
    assert.equal(result.contentScope.imageCount,0);
    assert.equal(JSON.stringify(result).includes('app://avatar'),false);
    assert.equal(JSON.stringify(result).includes('sinaimg.cn'),false);
  });
});

'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {RefreshPlan, AUTOMATIC_INTERVAL_MS, BACKGROUND_HEAD_INTERVAL_MS, UNRESOLVED_RETRY_INTERVAL_MS,
  AUTOMATIC_TIME_BUDGET_MS, AUTOMATIC_DEADLINE_MS, AUTOMATIC_MAX_PAGES, AUTOMATIC_HEAD_EVERY_PAGES} = require('../app/core/refresh-plan.cjs');

const group = (id, extra = {}) => ({id, selected:true, ...extra});
function fixture() {
  let now = 1700000000000;
  return {planner:new RefreshPlan({now:() => now}), advance:ms => now += ms, set:value => now = value, time:() => now};
}

test('local successful scheduling is five seconds, with bounded batches and slower background heads', () => {
  assert.equal(AUTOMATIC_INTERVAL_MS, 5000);
  assert.equal(BACKGROUND_HEAD_INTERVAL_MS, 60000);
  assert.equal(UNRESOLVED_RETRY_INTERVAL_MS, 60000);
  assert.equal(AUTOMATIC_TIME_BUDGET_MS, 8000);
  assert.equal(AUTOMATIC_DEADLINE_MS, 20000);
  assert.equal(AUTOMATIC_MAX_PAGES, 8);
  assert.equal(AUTOMATIC_HEAD_EVERY_PAGES, 4);
});

test('current selected group is first while other unseen selected groups retain input order', () => {
  const f=fixture(), groups=[group('a'),group('b'),group('c')];
  assert.deepEqual(f.planner.plan(groups,'c'),{headGroupIds:['c','a','b'],retryUnresolvedGroupIds:[],hasWork:true});
  for (const item of groups) f.planner.recordHead(item.id);
  f.advance(5000);
  assert.deepEqual(f.planner.plan(groups,'c'),{headGroupIds:['c'],retryUnresolvedGroupIds:[],hasWork:true});
  assert.deepEqual(f.planner.plan(groups,null),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
});

test('background period starts at completed head, not planning time or attempt start', () => {
  const f=fixture(), groups=[group('a')];
  f.planner.plan(groups);f.advance(12000);f.planner.recordHead('a');
  f.advance(59999);assert.deepEqual(f.planner.plan(groups),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
  f.advance(1);assert.deepEqual(f.planner.plan(groups),{headGroupIds:['a'],retryUnresolvedGroupIds:[],hasWork:true});
});

test('planning and failed attempts do not consume a due group, oldest completed heads go first', () => {
  const f=fixture(), groups=[group('new'),group('middle'),group('old'),group('unseen')];
  f.planner.recordHead('old');f.advance(1000);f.planner.recordHead('middle');f.advance(1000);f.planner.recordHead('new');f.advance(60000);
  const expected={headGroupIds:['unseen','old','middle','new'],retryUnresolvedGroupIds:[],hasWork:true};
  assert.deepEqual(f.planner.plan(groups),expected);
  assert.deepEqual(f.planner.plan(groups),expected);
});

test('pending and unresolved gaps remain work before background heads are due', () => {
  const f=fixture();f.planner.recordHead('a');f.planner.recordHead('b');f.advance(5000);
  const range={cursor:'90',baselineId:'20',arrivalAfterId:'20',status:'pending'};
  assert.deepEqual(f.planner.plan([group('a',{latestPendingRanges:[range]})]),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:true});
  assert.deepEqual(f.planner.plan([group('b',{latestPending:{...range,status:'unresolved',cursor:null}})]),{headGroupIds:[],retryUnresolvedGroupIds:['b'],hasWork:true});
  assert.deepEqual(f.planner.plan([group('a',{latestPendingRanges:[],latestPending:range})]),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
});

test('older-history cursor alone never starts a new automatic historical crawl', () => {
  const f=fixture();f.planner.recordHead('a');
  assert.deepEqual(f.planner.plan([group('a',{nextCursor:'9007199254740993123',historyExhausted:false})]),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
});

test('only exact selected stable strings can be preferred; numeric and trimmed aliases never match', () => {
  const f=fixture(), groups=[group('9007199254740993123'),group('02'),group('hidden',{selected:false}),
    group('wrong',{selected:'true'}),group(9007199254740992),group(' space '),group('bad\n')];
  for (const id of ['9007199254740993123','02']) f.planner.recordHead(id);
  for (const preferred of [9007199254740992,'9007199254740993123 ','2','hidden','wrong','missing']) {
    assert.deepEqual(f.planner.plan(groups,preferred),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
  }
  assert.deepEqual(f.planner.plan(groups,'9007199254740993123'),{headGroupIds:['9007199254740993123'],retryUnresolvedGroupIds:[],hasWork:true});
});

test('deselected pending groups do not wake a plan and duplicate IDs produce one head', () => {
  const f=fixture(), pending={latestPending:{cursor:'9',baselineId:'1'}};
  assert.deepEqual(f.planner.plan([group('no',{...pending,selected:false})],'no'),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
  assert.deepEqual(f.planner.plan([group('one'),group('one')],'one'),{headGroupIds:['one'],retryUnresolvedGroupIds:[],hasWork:true});
  assert.deepEqual(f.planner.plan([],'one'),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
});

test('switching the foreground immediately prioritizes its head without resetting background completion', () => {
  const f=fixture(), groups=[group('a'),group('b')];
  f.planner.recordHead('a');f.planner.recordHead('b');f.advance(5000);
  assert.deepEqual(f.planner.plan(groups,'a').headGroupIds,['a']);
  f.planner.recordHead('a');
  assert.deepEqual(f.planner.plan(groups,'b').headGroupIds,['b']);
  assert.deepEqual(f.planner.plan(groups).headGroupIds,[]);
});

test('account planners never share completion times or selection state', () => {
  let now=100000;const first=new RefreshPlan({now:()=>now}),second=new RefreshPlan({now:()=>now});
  first.recordHead('same');now+=5000;
  assert.deepEqual(first.plan([group('same')]),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
  assert.deepEqual(second.plan([group('same')]),{headGroupIds:['same'],retryUnresolvedGroupIds:[],hasWork:true});
});

test('clock rollback cannot advance background work; normal scheduling resumes after catch-up', () => {
  const f=fixture(), groups=[group('a')],initial=f.time();
  f.planner.recordHead('a');f.advance(30000);f.planner.plan(groups);
  f.set(initial-3600000);
  assert.deepEqual(f.planner.plan(groups),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
  assert.deepEqual(f.planner.plan(groups,'a'),{headGroupIds:['a'],retryUnresolvedGroupIds:[],hasWork:true});
  f.planner.recordHead('a');
  f.set(initial+89999);assert.deepEqual(f.planner.plan(groups).headGroupIds,[]);
  f.advance(1);assert.deepEqual(f.planner.plan(groups).headGroupIds,['a']);
});

test('plan leaves groups, message-related metadata and previous result arrays unchanged', () => {
  const f=fixture(), groups=[group('a',{readThroughId:'10',unreadIds:['11'],latestPendingRanges:[]}),group('b')];
  const original=structuredClone(groups),result=f.planner.plan(groups,'b');
  result.headGroupIds.push('injected');f.planner.recordHead('b');
  assert.deepEqual(groups,original);
  assert.deepEqual(f.planner.plan(groups,'b').headGroupIds,['b','a']);
});

test('invalid clocks, inputs and unsupported background intervals fail without inventing work', () => {
  for (const ms of [59999,0,-1,NaN,Infinity,60000.5,86400001]) assert.throws(()=>new RefreshPlan({backgroundIntervalMs:ms}),TypeError);
  assert.throws(()=>new RefreshPlan({now:1}),TypeError);
  assert.throws(()=>new RefreshPlan({now:()=>Infinity}).plan([]),TypeError);
  assert.throws(()=>new RefreshPlan({now:()=>-1}).plan([]),TypeError);
  const f=fixture();assert.throws(()=>f.planner.plan(null),TypeError);
  for (const id of ['',1,' a','a\n',null,'x'.repeat(513)]) {
    assert.throws(()=>f.planner.recordHead(id),TypeError);
    assert.throws(()=>f.planner.recordUnresolvedAttempt(id),TypeError);
  }
  const slower=new RefreshPlan({now:()=>1000,backgroundIntervalMs:120000});
  slower.recordHead('a');assert.deepEqual(slower.plan([group('a')]).headGroupIds,[]);
});

test('unresolved pages retry at sixty seconds despite five-second foreground head completions', () => {
  const f=fixture(), groups=[group('a',{latestPendingRanges:[{cursor:null,baselineId:'10',status:'unresolved'}]})];
  f.planner.recordHead('a');
  assert.deepEqual(f.planner.plan(groups,'a').retryUnresolvedGroupIds,['a']);
  f.planner.recordUnresolvedAttempt('a');
  for(let i=0;i<11;i++) {
    f.advance(5000);f.planner.recordHead('a');
    assert.deepEqual(f.planner.plan(groups,'a'),{headGroupIds:['a'],retryUnresolvedGroupIds:[],hasWork:true});
    assert.deepEqual(f.planner.plan(groups),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
  }
  f.advance(4999);assert.deepEqual(f.planner.plan(groups,'a').retryUnresolvedGroupIds,[]);
  f.advance(1);f.planner.recordHead('a');
  assert.deepEqual(f.planner.plan(groups),{headGroupIds:[],retryUnresolvedGroupIds:['a'],hasWork:true});
  f.planner.recordUnresolvedAttempt('a');
  assert.deepEqual(f.planner.plan(groups),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
});

test('successful unresolved retry throttles only unresolved probes and never ordinary pending pages', () => {
  const f=fixture(), pending={cursor:'90',baselineId:'20',status:'pending'},unresolved={cursor:null,baselineId:'10',status:'unresolved'};
  f.planner.recordHead('a');f.planner.recordUnresolvedAttempt('a');
  assert.deepEqual(f.planner.plan([group('a',{latestPendingRanges:[pending,unresolved]})]),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:true});
  assert.deepEqual(f.planner.plan([group('a',{latestPendingRanges:[{cursor:'80',baselineId:'20'}]})]),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:true});
  assert.deepEqual(f.planner.plan([group('a',{latestPendingRanges:[],latestPending:unresolved})]),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
  f.advance(60000);f.planner.recordHead('a');
  assert.deepEqual(f.planner.plan([group('a',{latestPendingRanges:[]})]),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
});

test('unresolved due groups are stable, selected, independent per account and oldest completion first', () => {
  const f=fixture(), unresolved={cursor:null,baselineId:'10',status:'unresolved'};
  const groups=['recent','old','unseen','unselected'].map(id=>group(id,{latestPendingRanges:[unresolved],selected:id!=='unselected'}));
  groups.forEach(g=>f.planner.recordHead(g.id));
  f.planner.recordUnresolvedAttempt('old');f.advance(1000);f.planner.recordUnresolvedAttempt('recent');f.advance(60000);
  assert.deepEqual(f.planner.plan(groups).retryUnresolvedGroupIds,['unseen','old','recent']);
  const other=new RefreshPlan({now:f.time});other.recordHead('recent');
  f.planner.recordUnresolvedAttempt('recent');
  assert.deepEqual(f.planner.plan(groups).retryUnresolvedGroupIds,['unseen','old']);
  assert.deepEqual(other.plan([groups[0]]).retryUnresolvedGroupIds,['recent']);
});

test('clock rollback does not accelerate unresolved probes and failed planning does not record an attempt', () => {
  const f=fixture(), initial=f.time(), groups=[group('a',{latestPending:{cursor:null,baselineId:'10',status:'unresolved'}})];
  f.planner.recordUnresolvedAttempt('a');f.planner.recordHead('a');f.set(initial-10000);
  assert.deepEqual(f.planner.plan(groups),{headGroupIds:[],retryUnresolvedGroupIds:[],hasWork:false});
  f.set(initial+60000);f.planner.recordHead('a');
  assert.deepEqual(f.planner.plan(groups).retryUnresolvedGroupIds,['a']);
  assert.deepEqual(f.planner.plan(groups).retryUnresolvedGroupIds,['a']);
});

test('ordinary pending completions for 150 seconds cannot postpone an older unresolved range', () => {
  const f=fixture(), pending={cursor:'1000',baselineId:'200',status:'pending'},
    unresolved={cursor:'150',baselineId:'100',status:'unresolved'},
    groups=[group('a',{latestPendingRanges:[pending,unresolved]})];
  f.planner.recordHead('a');f.planner.recordUnresolvedAttempt('a');
  for(let elapsed=5000;elapsed<=150000;elapsed+=5000) {
    f.advance(5000);
    // A normal saved pending page advances its durable cursor. It is not an
    // unresolved retry, so it has no planner completion method to invoke.
    pending.cursor=String(BigInt(pending.cursor)-1n);
    f.planner.recordHead('a');
    const planned=f.planner.plan(groups,'a');
    assert.equal(planned.hasWork,true);
    assert.deepEqual(planned.retryUnresolvedGroupIds,elapsed>=60000?['a']:[]);
  }
  // Only the eventual successful retry consumes the unresolved turn.
  f.planner.recordUnresolvedAttempt('a');
  f.advance(59999);assert.deepEqual(f.planner.plan(groups).retryUnresolvedGroupIds,[]);
  f.advance(1);assert.deepEqual(f.planner.plan(groups).retryUnresolvedGroupIds,['a']);
});

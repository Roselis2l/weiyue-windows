'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {groupStatus,automaticStatus,manualResult}=require('../app/renderer/sync-status.js');
const pending={cursor:'9007199254741001',baselineId:'9007199254740001',arrivalAfterId:'9007199254740001'};

test('legacy pending is shown as unfinished without inventing totals or completed progress',()=>{
  const result=groupStatus({latestPending:pending});
  assert.equal(result.needsBackfill,true);assert.equal(result.actionLabel,'补齐离线消息');
  assert.match(result.text,/仍有 1 段待衔接/);assert.doesNotMatch(result.text,/已补入|已完成|%/);
});
test('backfill progress uses inserted count, multiple retained ranges and explicit China time',()=>{
  const result=groupStatus({latestPending:pending,latestPendingRanges:[pending,pending],syncProgress:{phase:'backfill',added:1200,pages:60,scannedUntil:Date.parse('2026-10-20T04:15:00Z')}});
  assert.match(result.text,/已补入 1,200 条/);assert.match(result.text,/10\/20 12:15（北京时间）/);assert.match(result.text,/仍有 2 段待衔接/);
  assert.doesNotMatch(result.text,/60 条|已完成|%/);
});
test('unresolved boundary remains a gap even if no cursor survived or stale phase says joined',()=>{
  const unresolved=groupStatus({latestPendingRanges:[],syncProgress:{phase:'unresolved',added:30,reason:'接口提前结束，尚未衔接。'}});
  assert.equal(unresolved.needsBackfill,true);assert.equal(unresolved.actionLabel,'检查并继续补扫');assert.equal(unresolved.tone,'warning');assert.match(unresolved.text,/仍有缺口/);
  const stale=groupStatus({latestPendingRanges:[pending],syncProgress:{phase:'joined',added:50}});
  assert.equal(stale.needsBackfill,true);assert.doesNotMatch(stale.text,/已与本机记录衔接/);
});
test('completion is limited to this scan and a canonical empty ranges array overrides a legacy mirror',()=>{
  const result=groupStatus({latestPending:pending,latestPendingRanges:[],syncProgress:{phase:'joined',added:50}});
  assert.equal(result.needsBackfill,false);assert.match(result.text,/本次离线消息已与本机记录衔接/);
  assert.doesNotMatch(result.text,/全部历史|所有消息|100%/);
  assert.match(groupStatus({}).text,/“更早历史”读取本机最早记录之前/);
});
test('invalid numbers never become progress or percentages',()=>{
  for(const added of [-1,Infinity,NaN,'100',Number.MAX_SAFE_INTEGER+1])assert.doesNotMatch(groupStatus({latestPending:pending,syncProgress:{added,scannedUntil:'2026-01-01'}}).text,/已补入|已回溯至/);
});
test('rate limit, security stop and user pause have distinct explicit states',()=>{
  const rate=automaticStatus({enabled:true,errorCode:'RATE_LIMIT',nextRunAt:100},{formatTime:()=> '12:30'});
  assert.match(rate.text,/限流.*暂停本轮读取.*下次尝试 12:30/);assert.equal(rate.tone,'warning');
  const stopped=automaticStatus({enabled:true,blocked:true,errorCode:'ACCESS_DENIED',pausedReason:'请在官方页面检查。'});
  assert.match(stopped.text,/已暂停.*官方页面/);assert.equal(stopped.toggleLabel,'恢复自动更新');assert.doesNotMatch(stopped.text,/下次尝试|稍后自动/);
  const paused=automaticStatus({enabled:false,pausedReason:'自动更新未启用。'});assert.match(paused.text,/已保存的补扫进度保留/);assert.equal(paused.toggleLabel,'恢复自动更新');
});
test('manual outcomes do not claim complete while pending or unresolved remains',()=>{
  for(const group of [{latestPending:pending},{syncProgress:{phase:'unresolved',added:30}}])assert.match(manualResult({added:60,group}),/本轮新增 60 条。离线消息仍未补齐/);
  assert.match(manualResult({added:0,group:{syncProgress:{phase:'joined'}}}),/本次离线消息已与本机记录衔接/);
  const history=manualResult({history:true,added:20,group:{latestPending:pending}});assert.match(history,/20 条更早历史记录/);assert.match(history,/只向本机最早记录之前读取/);assert.doesNotMatch(history,/同步完成/);
});

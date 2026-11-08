'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {completionDetail}=require('../app/renderer/cleanup-progress.js');
const plan={deleteCount:28,retainedCount:12,reasonCounts:{bookmark:1,unread:2,summary:10},reasonLabels:{bookmark:'收藏原文',unread:'未读消息',summary:'摘要引用原文'}};
test('completed permanent deletion distinguishes removed and retained messages without changing policy',()=>{
 const text=completionDetail(plan,'permanent');assert.match(text,/已永久删除 28 条/);assert.match(text,/另有 12 条按保留规则未被删除；保留消息仍按当前筛选条件显示/);assert.match(text,/收藏原文 1 条、未读消息 2 条、摘要引用原文 10 条/);assert.match(text,/原因可能重叠/);assert.match(text,/范围外消息不受影响/);assert.equal(plan.retainedCount,12);
});
test('recycling explains recovery and retained visible records',()=>{const text=completionDetail(plan,'recycle');assert.match(text,/移入本地回收区，可随时恢复/);assert.match(text,/12 条按保留规则未被删除/);assert.doesNotMatch(text,/已永久删除/);});
test('purge explains retained records stay in trash rather than returning to the reader',()=>{const text=completionDetail(plan,'purge');assert.match(text,/从回收区永久删除 28 条/);assert.match(text,/12 条按保留规则继续留在回收区/);assert.doesNotMatch(text,/继续显示/);assert.match(text,/未选批次和消息列表不受影响/);});
test('zero retained does not claim all account messages were deleted',()=>{const text=completionDetail({...plan,retainedCount:0,reasonCounts:{}},'permanent');assert.match(text,/所选范围内没有因保留规则留下的消息/);assert.match(text,/范围外消息不受影响/);assert.doesNotMatch(text,/保留原因/);});
test('invalid preview counts cannot produce an invented success description',()=>{for(const patch of [{deleteCount:-1},{retainedCount:NaN},{deleteCount:1.5},{retainedCount:undefined}])assert.throws(()=>completionDetail({...plan,...patch},'permanent'),/数量无效/);});
test('both confirmed cleanup paths use reviewed preview counts and labels',()=>{const source=fs.readFileSync(require.resolve('../app/renderer/message-cleanup.js'),'utf8');assert.equal(source.split('completionDetail(plan,').length-1,2);assert.match(source,/cleanup-retained-explanation/);});

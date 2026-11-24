'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {prepareSummary,localSummary}=require('../app/core/summary.cjs');
const {exportSummaryMarkdown}=require('../app/core/summary-export.cjs');
const {projectAccount}=require('../app/core/content-projection.cjs');
const {resolveNotionSource}=require('../app/core/notion.cjs');
const start=Date.parse('2026-11-21T00:00:00+08:00'),end=start+86400000;
const group={id:'sample-group',name:'Synthetic',coverage:{oldest:start,newest:end-1,complete:true}};
const msg=(id,time,more={})=>({id,groupId:group.id,time,senderId:'person',senderName:'Reader',text:'text '+id,...more});
const pre=messages=>prepareSummary({messages,group,start,end});
const gone=(id,time)=>msg(id,time,{recall:{originalAvailable:false},text:'must never be referenced'});
const view=(messages,summary)=>projectAccount({messages,summaries:[summary],bookmarks:[],exports:{}},x=>x);
test('mixed, half-open time, unique omitted count, groups, retention',()=>{
 const s=pre([msg('start',start),gone('gone',start+1),gone('gone',start+1),msg('gone',start+1),
  msg('kept',start+2,{recall:{originalAvailable:true}}),msg('deleted',start+3,{localDeletion:{}}),
  gone('outside',end),msg('exclusive',end),gone('before',start-1),{...gone('other',start+4),groupId:'other'}]);
 assert.deepEqual(s.messages.map(m=>[m.id,m.ref]),[['start','M1'],['kept','M2']]);
 assert.deepEqual(s.range,{start,end});assert.equal(s.omittedUnavailable,2);
 assert.match(s.warning,/2 条本地记录/);
 const summary=localSummary(s);
 assert.deepEqual(summary.refs.map(r=>r.id),['start','kept']);
 assert.match(summary.body,/记录：2 条/);assert.doesNotMatch(summary.body,/must never/);
 assert.equal(view([gone('gone',start+1)],summary).summaries[0].contentUnavailable,undefined);
});
test('all unavailable is distinct from no local records; normal coverage unchanged',()=>{
 const bad=pre([gone('gone',start)]), empty=pre([]), normal=pre([msg('valid',end-1)]);
 assert.equal(bad.messages.length,0);assert.equal(bad.chunks.length,0);
 assert.equal(bad.omittedUnavailable,1);assert.match(bad.warning,/原文不可用/);
 assert.equal(empty.omittedUnavailable,0);assert.match(empty.warning,/没有本地消息/);
 assert.equal(normal.warning,'');assert.equal(normal.messages.length,1);
});
test('old affected summary stays hidden, including the existing redacted Notion source',()=>{
 const source=msg('first',start), summary=localSummary(pre([source]));
 const state=view([gone('first',start)],summary);
 assert.equal(state.summaries[0].contentUnavailable,true);
 assert.deepEqual(state.summaries[0].refs,[]);assert.doesNotMatch(state.summaries[0].body,/text first/);
 assert.equal(resolveNotionSource(state,{summaryId:summary.id}).contentUnavailable,true);
 assert.doesNotMatch(JSON.stringify(resolveNotionSource(state,{summaryId:summary.id})),/text first/);
});
test('Markdown rejects both already-hidden and newly hidden before any write',async()=>{
 const source=msg('first',start), summary=localSummary(pre([source]));let current=summary,calls=0,writes=0;
 const args={summaryId:summary.id,getSummary:()=>current,stillCurrent:()=>true,
  choosePath:async()=>{calls++;current=view([gone('first',start)],summary).summaries[0];return {filePath:'fake.md'};},
  write:()=>writes++};
 await assert.rejects(exportSummaryMarkdown(args),/未导出/);
 await assert.rejects(exportSummaryMarkdown(args),/未导出/);
 assert.equal(calls,1);assert.equal(writes,0);
});
test('cancel, stale account, no path, and genuinely written Markdown',async()=>{
 const summary=localSummary(pre([msg('first',start)]));let current=true,writes=[];
 const args={summaryId:summary.id,getSummary:()=>summary,stillCurrent:()=>current,write:(...args)=>writes.push(args)};
 assert.deepEqual(await exportSummaryMarkdown({...args,choosePath:async()=>({canceled:true})}),{canceled:true});
 await assert.rejects(exportSummaryMarkdown({...args,choosePath:async()=>({})}),/路径/);
 await assert.rejects(exportSummaryMarkdown({...args,choosePath:async()=>{current=false;return {filePath:'fake.md'};}}),/账号/);
 assert.equal(writes.length,0);current=true;
 assert.deepEqual(await exportSummaryMarkdown({...args,choosePath:async()=>({filePath:'fake.md'})}),{path:'fake.md'});
 assert.equal(writes.length,1);assert.match(writes[0][1],/sample-group\/first/);
});

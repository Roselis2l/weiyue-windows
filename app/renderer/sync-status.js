(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.WeiyueSyncStatus = exported;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function validOfflineDate(value) {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'0001-01-01')return false;
    const time=Date.parse(value+'T00:00:00Z');
    return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;
  }
  function offlinePolicy(value) {
    if(value?.mode==='none')return {mode:'none'};
    if(value?.mode==='date'&&validOfflineDate(value.date))return {mode:'date',date:value.date};
    return {mode:'auto'};
  }
  function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  function ranges(group) {
    if (Array.isArray(group?.latestPendingRanges)) return group.latestPendingRanges;
    return group?.latestPending ? [group.latestPending] : [];
  }
  function finiteTime(value) { return typeof value === 'number' && Number.isFinite(value); }
  function chinaTime(value) { return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}); }
  function baseGroupStatus(group, {formatTime = chinaTime,offlineMessages} = {}) {
    const boundary=group?.historyBoundary;
    if(finiteTime(boundary?.start)){
      const policy=offlinePolicy(offlineMessages), dateCutoff=policy.mode==='date'?Date.parse(policy.date+'T00:00:00+08:00'):null;
      const cutoff=dateCutoff===null?boundary.start:Math.max(boundary.start,dateCutoff),scan=group?.offlineDateScan;
      const scanCutoff=finiteTime(scan?.cutoff)?scan.cutoff:validOfflineDate(scan?.date)?Date.parse(scan.date+'T00:00:00+08:00'):null;
      const matches=scanCutoff===cutoff,head=matches?scan?.headPending:null;
      const complete=matches&&scan.complete===true&&scan.reachedDate===true&&!head;
      const unresolved=matches&&(scan.unresolved===true||head?.status==='unresolved');
      const recovery=group?.historyRecovery,recovering=recovery&&recovery.complete!==true;
      const blocked=group?.syncProgress?.phase==='blocked';
      const parts=['保留起点 '+formatTime(boundary.start)+'（北京时间）'];
      if(policy.mode==='none')parts.push('不补离线消息，仅检查最新消息');
      else if(complete)parts.push('本次补齐范围已衔接');
      else if(unresolved)parts.push('范围内仍有待核实缺口');
      else parts.push('范围内待补齐');
      if(cutoff>boundary.start)parts.push('本次补至 '+formatTime(cutoff));
      if(recovering)parts.push(recovery.unresolved?'所选历史时段尚未取回':'正在重新获取所选历史时段');
      if(blocked)parts.push(group.syncProgress.reason||'本轮读取已暂停');
      return {needsBackfill:policy.mode!=='none'&&!complete||!!recovering,unresolved:!!unresolved||!!recovery?.unresolved,tone:unresolved||recovery?.unresolved||blocked?'warning':'normal',actionLabel:'同步最新',text:parts.join(' · ')};
    }
    const pending = ranges(group), progress = group?.syncProgress || {};
    const unresolved = progress.phase === 'unresolved' || (offlineMessages?.mode==='date'&&group?.offlineDateScan?.date===offlineMessages.date&&(group.offlineDateScan.unresolved===true||group.offlineDateScan.headPending?.status==='unresolved')) || pending.some(item => item.status === 'unresolved');
    const blocked = progress.phase === 'blocked';
    const needsBackfill = pending.length > 0 || unresolved || blocked;
    const policy=offlinePolicy(offlineMessages);
    if(policy.mode!=='auto'){
      const complete=policy.mode==='date'&&group?.offlineDateScan?.date===policy.date&&group.offlineDateScan.complete===true&&group.offlineDateScan.reachedDate===true&&!group.offlineDateScan.headPending;
      const parts=[policy.mode==='none'?'离线消息：不补齐，仅检查新消息':(complete?'本次已到选定日期 ':'离线消息：补齐至 ')+policy.date+' 00:00（北京时间，含）'];
      if(policy.mode==='date'&&group?.offlineDateScan?.date===policy.date&&group.offlineDateScan.headPending)parts.push('较新的离线时段仍待补齐');
      if(policy.mode==='date'&&group?.offlineDateScan?.date===policy.date&&(group.offlineDateScan.unresolved||group.offlineDateScan.headPending?.status==='unresolved')&&!complete)parts.push('平台未返回更早消息，无法确认已覆盖至选定日期');
      if(needsBackfill)parts.push(unresolved?'仍有未衔接的离线缺口':'保留'+(pending.length?' '+pending.length+' 段':'')+'未衔接记录');
      if(policy.mode==='date'&&blocked)parts.push(progress.reason||'本轮读取已暂停');
      return {needsBackfill,unresolved,tone:unresolved||blocked?'warning':'normal',actionLabel:'同步最新',text:parts.join(' · ')};
    }
    const added = count(progress.added), parts = [];
    if (needsBackfill) parts.push(unresolved ? '离线消息仍有缺口' : blocked ? '离线补扫已暂停' : '补齐离线消息');
    else if (progress.phase === 'joined') parts.push('本次离线消息已与本机记录衔接');
    else return {needsBackfill:false, unresolved:false, tone:'normal', actionLabel:'同步最新',
      text:'离线消息会分批补齐；“更早历史”读取本机最早记录之前。'};
    if (added !== null) parts.push(`已补入 ${added.toLocaleString('zh-CN')} 条`);
    if (needsBackfill && finiteTime(progress.scannedUntil)) parts.push(`已回溯至 ${formatTime(progress.scannedUntil)}（北京时间）`);
    if (unresolved) parts.push(progress.reason || '尚未与原有记录衔接，可手动检查并继续补扫');
    else if (blocked) parts.push(progress.reason || '已保存位置，等待恢复后续补');
    else if (pending.length) parts.push(`仍有 ${pending.length} 段待衔接`);
    return {needsBackfill, unresolved, tone:unresolved || blocked ? 'warning' : 'normal',
      actionLabel:unresolved ? '检查并继续补扫' : needsBackfill ? '补齐离线消息' : '同步最新',text:parts.join(' · ')};
  }

  function groupStatus(group, options={}) {
    const result=baseGroupStatus(group,options);
    if(finiteTime(group?.historyBoundary?.start))return result;
    const recovery=group?.historyRecovery,parts=[result.text];
    if(recovery&&recovery.complete!==true)parts.push(recovery.unresolved?'所选历史时段尚未取回':'正在重新获取所选历史时段');
    return {...result,needsBackfill:result.needsBackfill||!!(recovery&&recovery.complete!==true),unresolved:result.unresolved||!!recovery?.unresolved,tone:recovery?.unresolved?'warning':result.tone,text:parts.join(' · ')};
  }

  function automaticStatus(status, {formatTime = value => new Date(value).toLocaleTimeString('zh-CN')} = {}) {
    if (!status) return {text:'正在读取自动更新状态，阅读位置保持不变。',tone:'normal',toggleLabel:'暂停自动更新'};
    const toggleLabel = status.enabled === false || status.blocked ? '恢复自动更新' : '暂停自动更新';
    const next = finiteTime(status.nextRunAt) ? `；下次尝试 ${formatTime(status.nextRunAt)}` : '';
    let text, tone = 'normal';
    if (status.blocked) { text = `自动更新已暂停：${status.pausedReason || status.error || '请确认服务状态后手动恢复。'}`; tone = 'warning'; }
    else if (status.errorCode === 'RATE_LIMIT') {
      text = `微博暂时限流，已暂停本轮读取${status.enabled === false ? '；自动更新也已暂停。' : next || '，等待服务允许后续补。'}`;
      tone = 'warning';
    } else if (status.enabled === false) text = '自动更新已暂停；已保存的补扫进度保留，仍可手动同步。';
    else if (status.error) { text = `更新暂缓：${next ? status.error.replace(/[。；]+$/u, '') : status.error}${next}`; tone = 'warning'; }
    else if (status.pausedReason) text = `自动更新等待中：${status.pausedReason}`;
    else if (status.running) text = '正在后台分批更新群聊，阅读位置保持不变。';
    else text = `本轮完成后 ${Math.round((status.intervalMs || 5000) / 1000)} 秒再检查，当前群优先；其他群约 ${Math.round((status.backgroundIntervalMs || 60000) / 1000)} 秒轮转${finiteTime(status.lastSuccessAt) ? ` · 上次 ${formatTime(status.lastSuccessAt)}` : ''}`;
    return {text,tone,toggleLabel};
  }

  function manualResult({history = false, added, group,offlineMessages} = {}) {
    const amount = count(added), prefix = amount === null ? '本轮读取已保存' : `本轮新增 ${amount.toLocaleString('zh-CN')} 条`;
    if(finiteTime(group?.historyBoundary?.start))return prefix+'。'+groupStatus(group,{offlineMessages}).text+'。';
    if (history) return `${amount === null ? '本轮更早历史记录已保存' : `本轮新增 ${amount.toLocaleString('zh-CN')} 条更早历史记录`}。此操作只向本机最早记录之前读取。`;
    const policy=offlinePolicy(offlineMessages);
    if(policy.mode!=='auto')return prefix+'。'+groupStatus(group,{offlineMessages:policy}).text+'。阅读位置保持不变。';
    const current = groupStatus(group);
    if (current.needsBackfill) return `${prefix}。离线消息仍未补齐，已保存续补位置。`;
    if (group?.syncProgress?.phase === 'joined') return `${prefix}。本次离线消息已与本机记录衔接，阅读位置保持不变。`;
    return `${prefix}。阅读位置保持不变。`;
  }

  return {groupStatus,automaticStatus,manualResult,offlinePolicy,validOfflineDate};
});

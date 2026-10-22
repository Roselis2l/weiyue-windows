(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.WeiyueSyncStatus = exported;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  function ranges(group) {
    if (Array.isArray(group?.latestPendingRanges)) return group.latestPendingRanges;
    return group?.latestPending ? [group.latestPending] : [];
  }
  function finiteTime(value) { return typeof value === 'number' && Number.isFinite(value); }
  function chinaTime(value) { return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}); }
  function groupStatus(group, {formatTime = chinaTime} = {}) {
    const pending = ranges(group), progress = group?.syncProgress || {};
    const unresolved = progress.phase === 'unresolved' || pending.some(item => item.status === 'unresolved');
    const blocked = progress.phase === 'blocked';
    const needsBackfill = pending.length > 0 || unresolved || blocked;
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
    else if (status.error) { text = `更新暂缓：${status.error}${next}`; tone = 'warning'; }
    else if (status.pausedReason) text = `自动更新等待中：${status.pausedReason}`;
    else if (status.running) text = '正在后台分批更新群聊，阅读位置保持不变。';
    else text = `本轮完成后 ${Math.round((status.intervalMs || 5000) / 1000)} 秒再检查，当前群优先；其他群约 ${Math.round((status.backgroundIntervalMs || 60000) / 1000)} 秒轮转${finiteTime(status.lastSuccessAt) ? ` · 上次 ${formatTime(status.lastSuccessAt)}` : ''}`;
    return {text,tone,toggleLabel};
  }

  function manualResult({history = false, added, group} = {}) {
    const amount = count(added), prefix = amount === null ? '本轮读取已保存' : `本轮新增 ${amount.toLocaleString('zh-CN')} 条`;
    if (history) return `${amount === null ? '本轮更早历史记录已保存' : `本轮新增 ${amount.toLocaleString('zh-CN')} 条更早历史记录`}。此操作只向本机最早记录之前读取。`;
    const current = groupStatus(group);
    if (current.needsBackfill) return `${prefix}。离线消息仍未补齐，已保存续补位置。`;
    if (group?.syncProgress?.phase === 'joined') return `${prefix}。本次离线消息已与本机记录衔接，阅读位置保持不变。`;
    return `${prefix}。阅读位置保持不变。`;
  }

  return {groupStatus,automaticStatus,manualResult};
});

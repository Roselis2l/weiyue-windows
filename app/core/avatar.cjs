'use strict';

// Avatars are display metadata, never chat attachments or AI summary inputs.
// This helper performs no I/O. The main-process avatar proxy must validate the
// URL again and separately enforce response size, type and redirect limits.
const MAX_AVATAR_URL_LENGTH = 4096;

function safeAvatarUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_AVATAR_URL_LENGTH || /[\s\u0000-\u001f\u007f\\]/.test(value)) return null;
  const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (!authority || !/^[a-z0-9.-]+$/i.test(authority)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname;
    if (!/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))) return null;
    if (host !== 'sinaimg.cn' && !host.endsWith('.sinaimg.cn')) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function firstAvatarUrl(...values) {
  for (const value of values) {
    const url = safeAvatarUrl(value);
    if (url) return url;
  }
  return null;
}

function avatarGroupUpdates(existing,fresh,groupId){
  const allowed=new Map(existing.filter(g=>g.selected&&(!groupId||g.id===groupId)).map(g=>[g.id,g]));
  return fresh.flatMap(group=>{
    const previous=allowed.get(group.id),avatarUrl=safeAvatarUrl(group.avatarUrl);
    if(!previous||!avatarUrl||previous.avatarUrl===avatarUrl)return [];
    allowed.delete(group.id);
    return [{...previous,avatarUrl}];
  });
}

module.exports = { safeAvatarUrl, firstAvatarUrl, avatarGroupUpdates, MAX_AVATAR_URL_LENGTH };

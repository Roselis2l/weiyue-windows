'use strict';
const {safeImageUrl} = require('./media.cjs');
// Canonicalize only the merge key; signed transport URLs remain intact.
function imageIdentity(image) {
  const source = image?.originalUrl || image?.url;
  const safe = safeImageUrl(source);
  if (!safe) return source;
  const url = new URL(safe);
  // Only known CDN size aliases share an opaque photo filename. Fetch URLs stay intact.
  if (!url.search && /^wx[1-4]\.sinaimg\.cn$/.test(url.hostname) && /^\/(?:large|thumbnail|bmiddle|original|mw[0-9]+|orj[0-9]+)\/[a-zA-Z0-9]{20,}\.(?:jpe?g|png|gif|webp)$/.test(url.pathname))
    return 'weibo-photo:' + url.pathname.split('/').pop();
  if (url.hostname !== 'zzx.sinaimg.cn') return safe;
  url.searchParams.delete('Expires');
  url.searchParams.delete('ssig');
  url.searchParams.sort();
  return url.href;
}
module.exports = {imageIdentity};

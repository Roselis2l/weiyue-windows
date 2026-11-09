'use strict';
const {safeImageUrl} = require('./media.cjs');
// Canonicalize only the merge key; signed transport URLs remain intact.
function imageIdentity(image) {
  const source = image?.originalUrl || image?.url;
  const safe = safeImageUrl(source);
  if (!safe) return source;
  const url = new URL(safe);
  if (url.hostname !== 'zzx.sinaimg.cn') return safe;
  url.searchParams.delete('Expires');
  url.searchParams.delete('ssig');
  url.searchParams.sort();
  return url.href;
}
module.exports = {imageIdentity};

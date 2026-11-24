'use strict';
const { referenceWithIdentity, metadataLine } = require('./record-export.cjs');
function assertExportable(summary) {
  if (!summary) throw new Error('摘要不存在');
  if (summary.contentUnavailable) throw new Error('摘要引用的原文已不可用，未导出。请用当前可用消息重新生成。');
  return summary;
}
async function exportSummaryMarkdown({summaryId,getSummary,getMessage,stillCurrent,choosePath,write}) {
  const verify=()=>{
    if (!stillCurrent()) throw new Error('账号已变化，未导出摘要。');
    return assertExportable(getSummary(summaryId));
  };
  verify();
  const choice=await choosePath();
  if(choice?.canceled) return {canceled:true};
  if(typeof choice?.filePath!=='string'||!choice.filePath) throw new Error('未选择有效导出路径。');
  const summary=verify();
  const refs=summary.refs.map(ref=>{
    const r=referenceWithIdentity(ref,getMessage?.(ref.groupId,ref.id));
    return '['+(r.label||r.id)+'] '+r.groupId+'/'+r.id+' '+new Date(r.time).toISOString()+'\n'+metadataLine(r)+'\n'+r.text;
  }).join('\n\n');
  write(choice.filePath,summary.body+'\n\n'+refs);
  return {path:choice.filePath};
}
module.exports={exportSummaryMarkdown};

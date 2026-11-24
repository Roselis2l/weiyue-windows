'use strict';
// Build-owned metadata only; settings, environment variables and IPC cannot
// change the edition of an installed package.
function validateBuildIdentity(metadata,version) {
  const labels={github:'GitHub 版',retained:'防撤回版'};
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata)||Object.keys(metadata).sort().join(',')!=='id,label'||!Object.hasOwn(labels,metadata.id)||metadata.label!==labels[metadata.id])throw new Error('应用版本标识无效，请使用完整的发行包。');
  if(typeof version!=='string'||!/^\d+\.\d+\.\d+$/.test(version))throw new Error('应用版本号无效。');
  return Object.freeze({id:metadata.id,label:metadata.label,version});
}
module.exports={validateBuildIdentity};

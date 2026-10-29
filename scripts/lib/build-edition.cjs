'use strict';
// Fixed build-time source identity. No runtime switch, private module discovery,
// network access or file copying. Importing this module has no side effects.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const LABELS=Object.freeze({github:'GitHub 版',retained:'防撤回版'});
function fail(code){const error=Error(code);error.code=code;throw error;}
function validateEdition(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('INVALID_EDITION_OBJECT');
 if(Object.keys(value).sort().join(',')!=='id,label')fail('UNEXPECTED_EDITION_FIELDS');
 if(typeof value.id!=='string'||typeof value.label!=='string'||!Object.hasOwn(LABELS,value.id)||value.label!==LABELS[value.id])fail('UNRECOGNIZED_EDITION_IDENTITY');
 return Object.freeze({id:value.id,label:value.label});
}
function readEdition(file){
 const full=path.resolve(file);let stat,bytes,value;
 try{stat=fs.lstatSync(full);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024||fs.realpathSync.native(full).toLowerCase()!==full.toLowerCase())fail('INVALID_EDITION_FILE');bytes=fs.readFileSync(full);if(bytes.length>1024)fail('INVALID_EDITION_FILE');value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}
 catch(error){if(error.code==='INVALID_EDITION_FILE')throw error;fail('EDITION_READ_OR_JSON_FAILED');}
 return{...validateEdition(value),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
// Native-command output can be decoded using a legacy Windows console code
// page. ASCII JSON escapes preserve exact Chinese labels in either host.
function main(args){if(args.length!==1)fail('EXPECTED_EDITION_SOURCE_FILE');process.stdout.write(JSON.stringify(readEdition(args[0])).replace(/[\u0080-\uffff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'))+'\n');}
module.exports={validateEdition,readEdition};
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(JSON.stringify({ok:false,code:error.code||'EDITION_VALIDATION_FAILED'}));process.exitCode=1;}}

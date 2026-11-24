'use strict';
const {parentPort,workerData}=require('node:worker_threads');
try{const {parseDocument}=require('./document-preview.cjs');parentPort.postMessage({ok:true,value:parseDocument(Buffer.from(workerData.bytes),workerData.mime)});}catch(e){parentPort.postMessage({ok:false,error:e?.message==='DOCUMENT_LIMIT'?'DOCUMENT_LIMIT':'DOCUMENT_FORMAT'});}

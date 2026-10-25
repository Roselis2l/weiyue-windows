'use strict';
// OOXML and text are data only. ZIP entries are never written to disk, and XML
// entities, formulas, hyperlinks, HTML, macros and external relationships are
// never evaluated. Parse work runs in a terminable worker (document-preview-job).
const zlib=require('node:zlib'),path=require('node:path');
const sax=require('../third-party/sax/sax.cjs');
const MIME=Object.freeze({xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',md:'text/markdown',csv:'text/csv'});
const LIMITS=Object.freeze({xlsxBytes:20*1024*1024,textBytes:5*1024*1024,entries:2048,entryBytes:16*1024*1024,totalBytes:40*1024*1024,
 xmlNodes:1000000,depth:64,sheets:10,rows:500,columns:50,cells:10000,cellChars:1000,sharedStrings:100000,textChars:200000});
const fail=()=>{throw new Error('DOCUMENT_FORMAT');};
const bounded=()=>{throw new Error('DOCUMENT_LIMIT');};
function decodeText(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>LIMITS.textBytes)bounded();
 let encoding='UTF-8',data=bytes,label='utf-8',declared=false;
 if(bytes.subarray(0,3).equals(Buffer.from([239,187,191]))){data=bytes.subarray(3);declared=true;}
 else if(bytes.subarray(0,2).equals(Buffer.from([255,254]))){label='utf-16le';encoding='UTF-16 LE';data=bytes.subarray(2);}
 else if(bytes.subarray(0,2).equals(Buffer.from([254,255]))){label='utf-16be';encoding='UTF-16 BE';data=bytes.subarray(2);}
 let text;try{text=new TextDecoder(label,{fatal:true}).decode(data);}catch{
  if(label!=='utf-8'||declared)fail();try{text=new TextDecoder('gb18030',{fatal:true}).decode(data);encoding='GB18030（兼容识别）';}catch{fail();}
 }
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))fail();
 return {text,encoding};
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let j=0;j<8;j++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(b){let n=0xffffffff;for(const x of b)n=crcTable[(n^x)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function zipDirectory(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<22||bytes.length>LIMITS.xlsxBytes)bounded();
 if(bytes.readUInt32LE(0)!==0x04034b50)fail();
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}}
 if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))fail();
 const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
 if(count!==bytes.readUInt16LE(end+8)||count<1||count>LIMITS.entries||offset+size!==end)fail();
 const entries=new Map(),ranges=[];let p=offset,total=0;
 for(let i=0;i<count;i++){
  if(p+46>end||bytes.readUInt32LE(p)!==0x02014b50)fail();
  const flags=bytes.readUInt16LE(p+8),method=bytes.readUInt16LE(p+10),crc=bytes.readUInt32LE(p+16),compressed=bytes.readUInt32LE(p+20),length=bytes.readUInt32LE(p+24),nameLength=bytes.readUInt16LE(p+28),extra=bytes.readUInt16LE(p+30),comment=bytes.readUInt16LE(p+32),local=bytes.readUInt32LE(p+42);
  if(flags&1||flags&64||![0,8].includes(method)||bytes.readUInt16LE(p+34)||p+46+nameLength+extra+comment>end||nameLength>512||nameLength<1)fail();
  if(length>LIMITS.entryBytes||(total+=length)>LIMITS.totalBytes||length>Math.max(1024*1024,compressed*200))bounded();
  let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(p+46,p+46+nameLength));}catch{fail();}
  if(name.includes('\\')||name.startsWith('/')||name.split('/').some(x=>x==='..'||x==='.')||/[\u0000-\u001f:]/.test(name)||entries.has(name))fail();
  if(local+30>offset||bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)fail();
  const nl=bytes.readUInt16LE(local+26),el=bytes.readUInt16LE(local+28),start=local+30+nl+el;
  if(nl!==nameLength||start+compressed>offset||!bytes.subarray(local+30,local+30+nl).equals(bytes.subarray(p+46,p+46+nl)))fail();
  if(!(flags&8)&&(bytes.readUInt32LE(local+14)!==crc||bytes.readUInt32LE(local+18)!==compressed||bytes.readUInt32LE(local+22)!==length))fail();
  ranges.push([local,start+compressed]);entries.set(name,{start,compressed,length,method,crc});p+=46+nameLength+extra+comment;
 }
 if(p!==end)fail();ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])fail();
 if(!entries.has('[Content_Types].xml')||!entries.has('xl/workbook.xml')||!entries.has('xl/_rels/workbook.xml.rels'))fail();
 return {entries,read(name){const e=entries.get(name);if(!e)fail();let b;try{b=e.method===0?bytes.subarray(e.start,e.start+e.compressed):zlib.inflateRawSync(bytes.subarray(e.start,e.start+e.compressed),{maxOutputLength:LIMITS.entryBytes});}catch{fail();}if(b.length!==e.length||crc32(b)!==e.crc)fail();return b;}};
}
function isDocumentBytes(bytes,mime){
 if(!Object.values(MIME).includes(mime)||!Buffer.isBuffer(bytes))return false;
 try{if(mime===MIME.xlsx)zipDirectory(bytes);else decodeText(bytes);return true;}catch{return false;}
}
function parseXml(bytes,handlers){
 if(bytes.length>LIMITS.entryBytes)bounded();
 let xml;try{xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail();}
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))fail();
 const parser=sax.parser(true,{xmlns:true,strictEntities:true,trim:false,normalize:false}),stack=[];let nodes=0;
 parser.onerror=fail;parser.ondoctype=fail;parser.onopentag=node=>{if(++nodes>LIMITS.xmlNodes||stack.length>=LIMITS.depth)bounded();stack.push(node);handlers.open?.(node,stack);};
 parser.ontext=parser.oncdata=value=>handlers.text?.(value,stack);
 parser.onclosetag=()=>{handlers.close?.(stack.at(-1),stack);stack.pop();};
 parser.write(xml).close();
}
const attr=(node,name)=>{const a=node.attributes[name];return a?String(a.value):'';};
const local=node=>node?.local||'';
const trimCell=(value,state)=>{value=String(value??'');if(value.length>LIMITS.cellChars){state.truncated=true;return value.slice(0,LIMITS.cellChars)+'…';}return value;};
function parseXlsx(bytes){
 const zip=zipDirectory(bytes),state={truncated:false},sheets=[],relations=new Map(),shared=[];let currentString=null,stringChars=0;
 let contentType=false;parseXml(zip.read('[Content_Types].xml'),{open:n=>{if(local(n)==='Override'&&attr(n,'PartName')==='/xl/workbook.xml'&&attr(n,'ContentType')==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')contentType=true;}});if(!contentType)fail();
 parseXml(zip.read('xl/_rels/workbook.xml.rels'),{open:n=>{if(local(n)!=='Relationship'||attr(n,'TargetMode')==='External')return;const target=attr(n,'Target'),id=attr(n,'Id'),type=attr(n,'Type');if(!id||relations.has(id))fail();
  if(!/\/worksheet$/.test(type)||!target||target.includes('\\')||/[?#:%]/.test(target))return;
  const name=target.startsWith('/')?target.slice(1):path.posix.normalize('xl/'+target);if(!name.startsWith('xl/worksheets/')||!name.endsWith('.xml'))return;relations.set(id,name);
 }});
 parseXml(zip.read('xl/workbook.xml'),{open:n=>{if(local(n)!=='sheet')return;if(sheets.length>=LIMITS.sheets){state.truncated=true;return;}const rel=attr(n,'r:id')||Object.values(n.attributes).find(x=>x.local==='id'&&/relationships$/.test(x.uri))?.value;const name=relations.get(rel);if(!name||!zip.entries.has(name))return;sheets.push({name:attr(n,'name').slice(0,120)||'工作表',file:name,rows:[]});}});if(!sheets.length)fail();
 if(zip.entries.has('xl/sharedStrings.xml'))parseXml(zip.read('xl/sharedStrings.xml'),{open:n=>{if(local(n)==='si'){if(shared.length>=LIMITS.sharedStrings)bounded();currentString='';}},text:(v,s)=>{if(currentString!==null&&local(s.at(-1))==='t'&&!s.some(n=>local(n)==='rPh')){stringChars+=v.length;if(stringChars>8*1024*1024)bounded();currentString+=v;}},close:n=>{if(local(n)==='si'){shared.push(currentString);currentString=null;}}});
 let totalCells=0,formulas=0;
 for(const sheet of sheets){let row=null,cell=null,currentValue='',inline='';
  parseXml(zip.read(sheet.file),{open:(n,stack)=>{
   if(local(n)==='row'){const number=Number(attr(n,'r'))||sheet.rows.length+1;row={number,cells:[]};}
   else if(local(n)==='c'&&row){const ref=attr(n,'r'),m=ref.match(/^([A-Z]{1,3})([1-9]\d{0,6})$/);let col=0;if(m)for(const c of m[1])col=col*26+c.charCodeAt(0)-64;else col=row.cells.length+1;cell={col,type:attr(n,'t'),formula:false};currentValue='';inline='';}
   else if(local(n)==='f'&&cell){cell.formula=true;formulas++;}
  },text:(v,s)=>{if(!cell)return;const name=local(s.at(-1));if(name==='v')currentValue+=v;else if(name==='t'&&s.some(n=>local(n)==='is')&&!s.some(n=>local(n)==='rPh'))inline+=v;if(currentValue.length+inline.length>1024*1024)bounded();},close:n=>{
   if(local(n)==='c'&&cell&&row){if(sheet.rows.length>=LIMITS.rows||cell.col>LIMITS.columns||totalCells>=LIMITS.cells){state.truncated=true;}else{
    let value=cell.type==='inlineStr'?inline:cell.type==='s'?shared[Number(currentValue)]:cell.type==='b'?(currentValue==='1'?'TRUE':'FALSE'):currentValue;
    if(cell.type==='s'&&(!/^\d+$/.test(currentValue)||Number(currentValue)>=shared.length))fail();
    if(cell.formula&&!currentValue)value='[公式无缓存值]';
    row.cells.push({column:cell.col,value:trimCell(value,state),formula:cell.formula});totalCells++;
   }cell=null;}
   else if(local(n)==='row'&&row){if(sheet.rows.length<LIMITS.rows&&row.cells.length)sheet.rows.push(row);else if(sheet.rows.length>=LIMITS.rows)state.truncated=true;row=null;}
  }});delete sheet.file;
 }
 return {format:'xlsx',sheets,rows:sheets.reduce((n,s)=>n+s.rows.length,0),cells:totalCells,truncated:state.truncated,
  notices:['只读单元格值预览，不保留完整排版；日期可能显示原始数值。','未执行公式、宏或外部链接；公式仅显示已有缓存值。',...(state.truncated?['内容已截取：最多 10 个工作表、每表 500 行/50 列、合计 10,000 个单元格。请另存原文件查看完整内容。']:[])]};
}
function parseCsv(text){
 const rows=[],state={truncated:false};let cells=[],value='',quoted=false,afterQuote=false,total=0,i=0;
 const addCell=()=>{if(cells.length<LIMITS.columns&&total<LIMITS.cells){cells.push({column:cells.length+1,value:trimCell(value,state)});total++;}else state.truncated=true;value='';afterQuote=false;};
 const addRow=()=>{addCell();rows.push({number:rows.length+1,cells});cells=[];};
 for(;i<text.length;i++){
  const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;afterQuote=true;}}else value+=c;}
  else if(c==='"'&&!value&&!afterQuote)quoted=true;
  else if(c===',')addCell();
  else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;addRow();if(rows.length>=LIMITS.rows||total>=LIMITS.cells){state.truncated ||= i<text.length-1;break;}}
  else{if(afterQuote&&c!==' '&&c!=='\t')fail();if(!afterQuote)value+=c;}
  if(value.length>LIMITS.cellChars*4){value=value.slice(0,LIMITS.cellChars);state.truncated=true;}
 }
 if(quoted)fail();if(i>=text.length&&(value||cells.length||afterQuote))addRow();
 return {format:'csv',sheets:[{name:'CSV',rows}],rows:rows.length,cells:total,truncated:state.truncated,notices:['CSV 内容按逗号及双引号解析；以 =、+、-、@ 开头的单元格仅作为文字显示，不执行公式。',...(state.truncated?['内容已截取：最多 500 行/50 列、10,000 个单元格。请另存原文件查看完整内容。']:[])]};
}
function parseDocument(bytes,mime){
 if(mime===MIME.xlsx)return parseXlsx(bytes);
 if(![MIME.md,MIME.csv].includes(mime))fail();const decoded=decodeText(bytes);
 if(mime===MIME.csv)return {...parseCsv(decoded.text),encoding:decoded.encoding};
 return {format:'md',encoding:decoded.encoding,text:decoded.text.slice(0,LIMITS.textChars),truncated:decoded.text.length>LIMITS.textChars,
 notices:['Markdown 以纯文本预览，保留原始语法；不执行 HTML、不访问图片或链接。',...(decoded.text.length>LIMITS.textChars?['内容已截取前 200,000 字符；请另存原文件查看完整内容。']:[])]};
}
module.exports={MIME,LIMITS,decodeText,zipDirectory,isDocumentBytes,parseDocument,crc32};

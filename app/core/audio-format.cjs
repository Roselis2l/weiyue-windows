'use strict';
const MAX_AUDIO_BYTES=20*1024*1024;
const AUDIO_FORMATS=Object.freeze({
 mp3:Object.freeze({mime:'audio/mpeg',aliases:Object.freeze(['audio/mp3','audio/x-mp3'])}),
 wav:Object.freeze({mime:'audio/wav',aliases:Object.freeze(['audio/wave','audio/x-wav'])}),
 ogg:Object.freeze({mime:'audio/ogg',aliases:Object.freeze(['application/ogg'])}),
 m4a:Object.freeze({mime:'audio/mp4',aliases:Object.freeze(['audio/x-m4a'])}),
 amr:Object.freeze({mime:'audio/amr',aliases:Object.freeze(['audio/amr-wb'])}),
});
const audioFormat=mime=>Object.values(AUDIO_FORMATS).find(x=>x.mime===mime);
function detectedAudioMime(bytes,expectedMime){
 if(!Buffer.isBuffer(bytes)||bytes.length<6||bytes.length>MAX_AUDIO_BYTES||!audioFormat(expectedMime))return null;
 if(expectedMime==='audio/amr')return bytes.subarray(0,6).toString()==='#!AMR\n'||bytes.subarray(0,9).toString()==='#!AMR-WB\n'?expectedMime:null;
 if(expectedMime==='audio/wav'){
  if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)+8!==bytes.length)return null;
  let fmt=false,data=false;for(let p=12;p+8<=bytes.length;){const id=bytes.toString('ascii',p,p+4),size=bytes.readUInt32LE(p+4),end=p+8+size;if(end>bytes.length)return null;if(id==='fmt '&&size>=16)fmt=true;if(id==='data'&&size>0)data=true;p=end+(size&1);}return fmt&&data?expectedMime:null;
 }
 if(expectedMime==='audio/ogg'){
  if(bytes.length<35||bytes.toString('ascii',0,4)!=='OggS'||bytes[4]!==0)return null;const count=bytes[26],head=27+count;if(head>bytes.length)return null;const sample=bytes.subarray(head,head+8);return sample.toString('ascii')==='OpusHead'||sample.subarray(0,7).equals(Buffer.from([1,118,111,114,98,105,115]))?expectedMime:null;
 }
 if(expectedMime==='audio/mp4'){
  if(bytes.length<16||bytes.toString('ascii',4,8)!=='ftyp')return null;const n=bytes.readUInt32BE(0);if(n<16||n>4096||n>bytes.length||(n-16)%4)return null;const brands=[bytes.toString('ascii',8,12)];for(let i=16;i<n;i+=4)brands.push(bytes.toString('ascii',i,i+4));return brands.some(x=>['M4A ','M4B '].includes(x))?expectedMime:null;
 }
 let p=0;if(bytes.toString('ascii',0,3)==='ID3'){
  if(bytes.length<14||![2,3,4].includes(bytes[3])||bytes.subarray(6,10).some(x=>x&128))return null;
  p=10+((bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9])+(bytes[3]===4&&bytes[5]&16?10:0);
 }
 if(p+4>bytes.length)return null;const a=bytes[p],b=bytes[p+1],c=bytes[p+2];
 return a===255&&(b&224)===224&&(b&24)!==8&&(b&6)!==0&&(c&240)!==0&&(c&240)!==240&&(c&12)!==12?expectedMime:null;
}
module.exports={MAX_AUDIO_BYTES,AUDIO_FORMATS,audioFormat,detectedAudioMime};

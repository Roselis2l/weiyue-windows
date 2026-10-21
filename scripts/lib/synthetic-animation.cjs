'use strict';
// Two-color, two-frame images generated entirely from test pixels.
const zlib = require('node:zlib');
const WIDTH = 16, HEIGHT = 16;
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, payload) {
  const body = Buffer.concat([Buffer.from(type), payload]);
  return Buffer.concat([u32(payload.length), body, u32(crc32(body))]);
}
function rgba(color) {
  const bytes = Buffer.alloc(HEIGHT * (1 + WIDTH * 4));
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const at = y * (WIDTH * 4 + 1) + 1 + x * 4;
    bytes[at] = color === 0 ? 255 : 0; bytes[at + 2] = color === 1 ? 255 : 0; bytes[at + 3] = 255;
  }
  return zlib.deflateSync(bytes);
}
function frameControl(sequence) {
  const bytes = Buffer.alloc(26); bytes.writeUInt32BE(sequence); bytes.writeUInt32BE(WIDTH, 4); bytes.writeUInt32BE(HEIGHT, 8);
  bytes.writeUInt16BE(1, 20); bytes.writeUInt16BE(10, 22); return bytes;
}
function animatedPng() {
  const header = Buffer.alloc(13); header.writeUInt32BE(WIDTH); header.writeUInt32BE(HEIGHT, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
    chunk('acTL', Buffer.concat([u32(2), u32(0)])), chunk('fcTL', frameControl(0)), chunk('IDAT', rgba(0)),
    chunk('fcTL', frameControl(1)), chunk('fdAT', Buffer.concat([u32(2), rgba(1)])), chunk('IEND', Buffer.alloc(0))]);
}
function gifFrame(color) {
  // A clear code before every pixel keeps all LZW codes at exactly 3 bits.
  const codes = Array.from({length: WIDTH * HEIGHT}, () => [4, color]).flat(); codes.push(5);
  const packed = Buffer.alloc(Math.ceil(codes.length * 3 / 8));
  codes.forEach((value, i) => { const bit = i * 3; packed[bit >>> 3] |= value << (bit & 7); if ((bit & 7) > 5) packed[(bit >>> 3) + 1] |= value >>> (8 - (bit & 7)); });
  const blocks=[]; for(let at=0;at<packed.length;at+=255){const b=packed.subarray(at,at+255);blocks.push(Buffer.from([b.length]),b);}
  const descriptor=Buffer.alloc(10);descriptor[0]=0x2c;descriptor.writeUInt16LE(WIDTH,5);descriptor.writeUInt16LE(HEIGHT,7);
  return Buffer.concat([Buffer.from([0x21,0xf9,4,0,10,0,0,0]), descriptor, Buffer.from([2]), ...blocks, Buffer.from([0])]);
}
function animatedGif() {
  const screen=Buffer.alloc(7);screen.writeUInt16LE(WIDTH);screen.writeUInt16LE(HEIGHT,2);screen[4]=0x80;
  return Buffer.concat([Buffer.from('GIF89a'),screen,Buffer.from([255,0,0,0,0,255]),
    Buffer.from([0x21,0xff,11]),Buffer.from('NETSCAPE2.0'),Buffer.from([3,1,0,0,0]),gifFrame(0),gifFrame(1),Buffer.from([0x3b])]);
}
module.exports={animatedPng,animatedGif,WIDTH,HEIGHT};

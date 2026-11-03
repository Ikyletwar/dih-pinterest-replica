#!/usr/bin/env node
// Encoder cloaking (opsional) — membungkus halaman supaya SERVER tidak menampilkan
// konten asli pada HTTP response (hanya deretan zero-width chars), konten baru
// muncul di browser setelah JS runtime mendecode. Sama persis teknik orisinalnya.
//
// Catatan: teknik ini dipakai situs asli untuk menyamarkan halaman dari crawler/
// scanner. Memakainya = ikut menyamarkan halaman Anda. Ada trade-off: halaman
// tanpa-JS / SEO / accessibility jadi kosong, dan sebagian platform review
// menganggapnya cloaking. Pertimbangkan sebelum dipakai di produksi.
//
// Usage:  node cloak/encode.mjs <real.html> > index.html
// Output: index.html berisi skrip decode-sendiri (lihat template di bawah).

import fs from "node:fs";

const ZWSP = "\u200B";
const ZWNJ = "\u200C";

if (process.argv.length < 3) {
  console.error("usage: node cloak/encode.mjs <real.html>");
  process.exit(1);
}

const src = fs.readFileSync(process.argv[2], "utf8");
const b64 = Buffer.from(src, "utf8").toString("base64");

let bin = "";
for (let i = 0; i < b64.length; i++) {
  const byte = b64.charCodeAt(i); // 0..255
  for (let b = 7; b >= 0; b--) bin += (byte >> b) & 1 ? "1" : "0";
}

let encoded = "";
for (const bit of bin) encoded += bit === "1" ? ZWNJ : ZWSP;

const out = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Rapwy is Here</title></head><body><script>(()=>{const ZWSP="\\u200B",ZWNJ="\\u200C",encoded=\`${encoded}\`;function zwToBinary(s){let b="";for(let i=0;i<s.length;i++){if(s[i]===ZWSP)b+="0";else if(s[i]===ZWNJ)b+="1";}return b;}function binaryToBase64(b){let r="";for(let i=0;i<b.length;i+=8){const byte=b.slice(i,i+8);if(byte.length===8)r+=String.fromCharCode(parseInt(byte,2));}return r;}try{const decoded=atob(binaryToBase64(zwToBinary(encoded)));document.open();document.write(decoded);document.close();}catch(err){document.body.innerHTML="<section style='font-family:monospace;padding:16px;border:1px solid #ddd;border-radius:8px'>Decode Error: "+err.message+"</section>";}})();</script></body></html>`;

process.stdout.write(out);
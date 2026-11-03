#!/usr/bin/env node
// Dekoder cloaking ala searchpinterest.vercel.app
//
// Teknik orisinal: halaman HTML asli di-encode menjadi biner (ZWSP=0, ZWNJ=1),
// lalu tiap 8 bit jadi 1 byte → string base64 → di-embed di template literal,
// dan di-decode runtime via atob()+document.write().
//
// Usage:  node cloak/decode.mjs <file_with_encoded_template.html>
// Output: tulis HTML hasil decode ke stdout.

import fs from "node:fs";

const ZWSP = "\u200B";
const ZWNJ = "\u200C";

if (process.argv.length < 3) {
  console.error("usage: node cloak/decode.mjs <input.html>");
  process.exit(1);
}

const html = fs.readFileSync(process.argv[2], "utf8");
const m = html.match(/encoded=`([\s\S]*?)`/);
if (!m) {
  console.error("tidak menemukan blok encoded=`. String ini bukan output dari encoder ini.");
  process.exit(1);
}
const enc = m[1];

let bin = "";
for (const ch of enc) {
  if (ch === ZWSP) bin += "0";
  else if (ch === ZWNJ) bin += "1";
}

let b64 = "";
for (let i = 0; i < bin.length; i += 8) {
  const byte = bin.slice(i, i + 8);
  if (byte.length === 8) b64 += String.fromCharCode(parseInt(byte, 2));
}

const decoded = Buffer.from(b64, "base64").toString("utf8");
process.stdout.write(decoded);
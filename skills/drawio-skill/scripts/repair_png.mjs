#!/usr/bin/env node
// Repair truncated IEND chunk in draw.io -e PNG exports (issue #8).
//
// draw.io's CLI emits -e PNGs with the 4-byte IEND length field but missing
// the 8 bytes of "IEND" type + CRC. Strict PNG decoders and vision APIs
// (Anthropic included) reject the file with 400 "Could not process image".
// SVG/PDF are unaffected.
//
// Usage: repair_png.mjs <path/to/diagram.drawio.png>
//
// Idempotent: the endswith(IEND) guard makes this a no-op once draw.io
// fixes the bug upstream, so it's safe to run unconditionally after every
// -e PNG export.
import fs from "node:fs";

const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export function repair(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.subarray(data.length - IEND.length).equals(IEND)) {
    return false;
  }
  let trimmed = data;
  const zeroTail = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  if (data.subarray(data.length - 4).equals(zeroTail)) {
    trimmed = data.subarray(0, data.length - 4);
  }
  fs.writeFileSync(filePath, Buffer.concat([trimmed, IEND]));
  return true;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: repair_png.mjs <path/to/diagram.drawio.png>");
    process.exit(0);
  }
  if (argv.length !== 1) {
    process.stderr.write("usage: repair_png.mjs <path>\n");
    process.exit(2);
  }
  if (repair(argv[0])) {
    console.log(`repaired ${argv[0]}`);
  }
}

import path from "node:path";
import { fileURLToPath } from "node:url";
function isMainModule() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}
if (isMainModule()) {
  main();
}

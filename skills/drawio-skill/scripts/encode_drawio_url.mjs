#!/usr/bin/env node
// Encode a .drawio XML file into a diagrams.net browser URL.
//
// Used as the browser fallback when the draw.io desktop CLI is unavailable.
// The diagram XML is carried in the URL fragment (after `#`), so nothing is
// uploaded to any server.
//
// Two modes:
//   (default)  read-only viewer  -> https://viewer.diagrams.net/...#R<payload>
//   --edit     editable editor   -> https://app.diagrams.net/...#create=<payload>
//
// Usage: node encode_drawio_url.mjs [--edit] <path/to/input.drawio>
import fs from "node:fs";
import zlib from "node:zlib";

// draw.io's loader runs JS decodeURIComponent on the inflated string, so the
// XML MUST be percent-encoded (encodeURIComponent) BEFORE deflate — otherwise
// a literal `%` or any non-ASCII (e.g. CJK) label makes the browser throw
// "URI malformed" and the diagram never opens. JS's built-in encodeURIComponent
// leaves exactly A-Za-z0-9 -_.!~*'() unescaped, matching Python's
// quote(xml, safe="!~*'()") here.
function deflateB64(xml) {
  const pre = encodeURIComponent(xml);
  const compressed = zlib.deflateRawSync(Buffer.from(pre, "utf8"), { level: 9 });
  // Standard base64 (atob rejects url-safe -/_); strip newlines (base64 output
  // from Buffer.toString never contains newlines, but keep this symmetric with Python).
  return compressed.toString("base64").replace(/\n/g, "");
}

// Read-only viewer URL (mxGraph `#R` raw-inflate format).
function encode(xml) {
  return (
    "https://viewer.diagrams.net/?tags=%7B%7D&lightbox=1&edit=_blank#R" +
    encodeURIComponent(deflateB64(xml))
  );
}

// Editable editor URL — opens directly in the draw.io editor.
function editUrl(xml) {
  const payload = JSON.stringify({ type: "xml", compressed: true, data: deflateB64(xml) });
  return (
    "https://app.diagrams.net/?grid=0&pv=0&border=10&edit=_blank#create=" +
    encodeURIComponent(payload)
  );
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: encode_drawio_url.mjs [--edit] <path/to/input.drawio>");
  process.exit(0);
}
const args = argv.filter((a) => a !== "--edit");
if (args.length !== 1) {
  process.stderr.write("usage: encode_drawio_url.mjs [--edit] <path>\n");
  process.exit(2);
}
const xml = fs.readFileSync(args[0], "utf8");
console.log(argv.includes("--edit") ? editUrl(xml) : encode(xml));

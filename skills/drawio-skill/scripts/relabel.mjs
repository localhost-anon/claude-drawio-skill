#!/usr/bin/env node
// Swap every label in a .drawio via a mapping — layout, styles, ids untouched.
//
// Usage: relabel.mjs <file.drawio> (--extract | --map <labels.json>) [-o <out>]
import fs from "node:fs";
import path from "node:path";
import { parseArgs, die } from "./lib/args.mjs";
import { parse, serialize, find, findAll } from "./lib/xml.mjs";
import { walkCells } from "./lib/drawio.mjs";

const a = parseArgs({
  name: "relabel",
  usage: "Usage: relabel.mjs <file.drawio> (--extract | --map <labels.json>) [-o <out>]",
  flags: {
    extract: {},
    map: { takesValue: true },
    out: { short: "-o", takesValue: true },
  },
}, process.argv.slice(2));

if (a._.length !== 1) die("need exactly one <file.drawio>");
if (!a.extract && a.map === null) die("need --extract or --map <labels.json>");
if (a.extract && a.map !== null) die("--extract and --map are mutually exclusive");

const file = a._[0];
if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
  process.stderr.write(`error: ${file} not found\n`);
  process.exit(1);
}
const root = parse(fs.readFileSync(file, "utf8"));

// Yield {el, attr} for every label-bearing slot in the file.
function* labelSlots() {
  for (const diagram of findAll(root, "diagram")) {
    if (diagram.attrs.name) yield { el: diagram, attr: "name" };
    const model = find(diagram, "mxGraphModel");
    const r = model ? find(model, "root") : null;
    if (!r) {
      process.stderr.write(
        `warning: skipping compressed page '${diagram.attrs.name || "?"}' (open+save in draw.io to decompress)\n`
      );
      continue;
    }
    for (const { cell, wrapper } of walkCells(model)) {
      if (!wrapper) {
        if (cell.attrs.value) yield { el: cell, attr: "value" };
      } else {
        if (wrapper.attrs.label) yield { el: wrapper, attr: "label" };
        if (cell.attrs.value) yield { el: cell, attr: "value" };
      }
    }
  }
}

function dumpsOrdered(map) {
  const entries = [...map.entries()];
  if (entries.length === 0) return "{}";
  const lines = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return "{\n" + lines.join(",\n") + "\n}";
}

if (a.extract) {
  const seen = new Map();
  for (const { el, attr } of labelSlots()) {
    const v = el.attrs[attr];
    if (!seen.has(v)) seen.set(v, v);
  }
  const out = dumpsOrdered(seen);
  if (a.out) {
    fs.writeFileSync(a.out, out + "\n", "utf8");
    process.stderr.write(`wrote ${a.out} (${seen.size} labels)\n`);
  } else {
    console.log(out);
  }
  process.exit(0);
}

let mapping;
try {
  mapping = JSON.parse(fs.readFileSync(a.map, "utf8"));
} catch (e) {
  if (e.code === "ENOENT") {
    process.stderr.write(
      `Traceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory: '${a.map}'\n`
    );
    process.exit(1);
  }
  throw e;
}
if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
  die("map file must be a JSON object {old: new}");
}

let matched = 0;
const used = new Set();
for (const { el, attr } of labelSlots()) {
  const old = el.attrs[attr];
  if (Object.prototype.hasOwnProperty.call(mapping, old)) {
    el.attrs[attr] = String(mapping[old]);
    matched++;
    used.add(old);
  }
}

const ext = path.extname(file);
const stem = file.slice(0, file.length - ext.length);
const out = a.out || `${stem}-relabel.drawio`;
fs.writeFileSync(out, serialize(root, { indent: 2 }), "utf8");

const unused = Object.keys(mapping).filter((k) => !used.has(k));
if (unused.length) {
  const shown = unused.slice(0, 10).map((k) => JSON.stringify(k).slice(0, 60));
  process.stderr.write(`warning: ${unused.length} map key(s) matched no label: ${shown.join(", ")}\n`);
}
process.stderr.write(`wrote ${out} (${matched} labels replaced)\n`);

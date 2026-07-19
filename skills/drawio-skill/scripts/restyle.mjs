#!/usr/bin/env node
// Re-theme an EXISTING .drawio with a style preset — layout and shapes untouched.
//
// Usage: restyle.mjs <file.drawio> --preset <name|path.json> [-o <out.drawio>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, die } from "./lib/args.mjs";
import { parse, serialize, find, findAll } from "./lib/xml.mjs";

const SKILL_DIR = path.dirname(import.meta.dirname);

// Canonical hue (degrees) of each palette slot in the built-in conventions.
const SLOT_HUES = { primary: 210, success: 120, warning: 50, accent: 30, danger: 0, secondary: 280 };
const SLOT_ORDER = ["primary", "success", "warning", "accent", "danger", "neutral", "secondary"];

function findPreset(name) {
  const candidates = name.endsWith(".json")
    ? [name]
    : [
        path.join(os.homedir(), ".drawio-skill", "styles", `${name.toLowerCase()}.json`),
        path.join(SKILL_DIR, "styles", "built-in", `${name.toLowerCase()}.json`),
      ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  const builtin = path.join(SKILL_DIR, "styles", "built-in");
  const known = fs
    .readdirSync(builtin)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
  process.stderr.write(`error: preset '${name}' not found (built-ins: ${known.join(", ")})\n`);
  process.exit(1);
}

// rgb_to_hls equivalent (Python colorsys.rgb_to_hls) -> returns [h, l, s], h/l/s in [0,1)
function rgbToHls(r, g, b) {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const l = (minc + maxc) / 2;
  if (minc === maxc) return [0, l, 0];
  const delta = maxc - minc;
  const s = l <= 0.5 ? delta / (maxc + minc) : delta / (2 - maxc - minc);
  const rc = (maxc - r) / delta;
  const gc = (maxc - g) / delta;
  const bc = (maxc - b) / delta;
  let h;
  if (r === maxc) h = bc - gc;
  else if (g === maxc) h = 2 + rc - bc;
  else h = 4 + gc - rc;
  h = (h / 6) % 1;
  if (h < 0) h += 1;
  return [h, l, s];
}

function hueSlot(hexcolor, palette) {
  const r = parseInt(hexcolor.slice(1, 3), 16) / 255;
  const g = parseInt(hexcolor.slice(3, 5), 16) / 255;
  const b = parseInt(hexcolor.slice(5, 7), 16) / 255;
  const [h, l, s] = rgbToHls(r, g, b);
  let slot;
  if (s < 0.15 || l > 0.97 || l < 0.03) {
    slot = "neutral";
  } else {
    const deg = h * 360;
    slot = Object.keys(SLOT_HUES).reduce((best, k) => {
      const d = Math.min(Math.abs(deg - SLOT_HUES[k]), 360 - Math.abs(deg - SLOT_HUES[k]));
      const bd = Math.min(Math.abs(deg - SLOT_HUES[best]), 360 - Math.abs(deg - SLOT_HUES[best]));
      return d < bd ? k : best;
    });
  }
  if (palette[slot]) return slot;
  for (const k of SLOT_ORDER) {
    if (palette[k]) return k;
  }
  process.stderr.write("error: preset palette has no non-null slots\n");
  process.exit(1);
}

function getKey(style, key) {
  const m = style.match(new RegExp(`(?:^|;)${key}=([^;]*)`));
  return m ? m[1] : null;
}

// Replace/insert style keys, dropping existing occurrences first.
function setKeys(style, kv) {
  for (const key of Object.keys(kv)) {
    style = style.replace(new RegExp(`(?:^|;)${key}=[^;]*`, "g"), "");
  }
  style = style.replace(/^[;\s]+|[;\s]+$/g, "");
  const tail = Object.entries(kv)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  return (style ? style + ";" : "") + tail + ";";
}

const a = parseArgs({
  name: "restyle",
  usage: "Usage: restyle.mjs <file.drawio> --preset <name|path.json> [-o <out.drawio>]",
  flags: {
    preset: { takesValue: true },
    out: { short: "-o", takesValue: true },
  },
}, process.argv.slice(2));

if (a._.length !== 1) die("need exactly one <file.drawio>");
if (!a.preset) die("the following arguments are required: --preset");

const file = a._[0];
if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
  process.stderr.write(`error: ${file} not found\n`);
  process.exit(1);
}

const preset = findPreset(a.preset);
const palette = preset.palette;
const extras = preset.extras || {};
const font = preset.font;

const vertexExtra = { fontFamily: font.fontFamily };
if (extras.fontColor) vertexExtra.fontColor = extras.fontColor;
if (extras.sketch) vertexExtra.sketch = "1";
if (extras.globalStrokeWidth !== null && extras.globalStrokeWidth !== undefined && extras.globalStrokeWidth !== 1) {
  vertexExtra.strokeWidth = String(extras.globalStrokeWidth);
}

const root = parse(fs.readFileSync(file, "utf8"));
const slotMap = {};
let nVert = 0;
let nEdge = 0;

for (const diagram of findAll(root, "diagram")) {
  const model = find(diagram, "mxGraphModel");
  const r = model ? find(model, "root") : null;
  if (!r) {
    process.stderr.write(`warning: skipping compressed page '${diagram.attrs.name || "?"}'\n`);
    continue;
  }
  if (extras.background) model.attrs.background = extras.background;

  for (const child of r.children) {
    const cell = child.tag === "mxCell" ? child : find(child, "mxCell");
    if (!cell) continue;
    const style = cell.attrs.style || "";
    if (cell.attrs.edge === "1") {
      const kv = {};
      if (extras.edgeColor) {
        kv.strokeColor = extras.edgeColor;
        kv.fontColor = extras.edgeColor;
        kv.labelBackgroundColor = "none";
      }
      if (extras.sketch) kv.sketch = "1";
      if (extras.globalStrokeWidth !== null && extras.globalStrokeWidth !== undefined && extras.globalStrokeWidth !== 1) {
        kv.strokeWidth = String(extras.globalStrokeWidth);
      }
      if (Object.keys(kv).length) {
        cell.attrs.style = setKeys(style, kv);
        nEdge++;
      }
      continue;
    }
    if (cell.attrs.vertex !== "1") continue;
    const kv = { ...vertexExtra };
    const fill = getKey(style, "fillColor");
    if (fill && /^#[0-9A-Fa-f]{6}$/.test(fill)) {
      const key = fill.toLowerCase();
      if (!(key in slotMap)) slotMap[key] = hueSlot(key, palette);
      const slot = slotMap[key];
      const pair = palette[slot];
      kv.fillColor = pair.fillColor;
      kv.strokeColor = pair.strokeColor;
    } else if (fill === null) {
      delete kv.fontColor;
    }
    cell.attrs.style = setKeys(style, kv);
    nVert++;
  }
}

const ext = path.extname(file);
const stem = file.slice(0, file.length - ext.length);
const out = a.out || `${stem}-${preset.name || "restyled"}.drawio`;
fs.writeFileSync(out, serialize(root, { indent: 2 }), "utf8");

const remap = Object.entries(slotMap)
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([c, s]) => `${c}->${s}`)
  .join(", ");
process.stderr.write(
  `wrote ${out} (${nVert} vertices, ${nEdge} edges restyled` + (remap ? `; colors: ${remap}` : "") + ")\n"
);

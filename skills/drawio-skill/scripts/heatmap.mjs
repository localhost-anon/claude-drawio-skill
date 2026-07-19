#!/usr/bin/env node
// Colour a diagram by data — turn a .drawio into a metric heatmap.
//
// Usage: heatmap.mjs <file.drawio> --metrics <file.csv|json> [-o out.drawio]
//        [--palette heat|cool|warm] [--reverse] [--size] [--no-legend]
import fs from "node:fs";
import path from "node:path";
import { parseArgs, die } from "./lib/args.mjs";
import { parse, serialize, find, findAll } from "./lib/xml.mjs";

// Sequential ramps as (low, mid, high) anchor colours; value is lerped across them.
const PALETTES = {
  heat: ["#57bb8a", "#ffd666", "#e67c73"], // green -> yellow -> red
  cool: ["#deebf7", "#6baed6", "#08519c"], // light -> deep blue
  warm: ["#fff7bc", "#fec44f", "#d95f0e"], // pale -> deep amber
};

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function htmlUnescape(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent] : m;
  });
}

// Strip the HTML tags/entities draw.io stores in labels; collapse whitespace.
function clean(text) {
  if (!text) return "";
  text = text.replace(/<br\s*\/?>/gi, " ");
  text = text.replace(/<[^>]+>/g, "");
  return htmlUnescape(text).replace(/\s+/g, " ").trim();
}

function num(x) {
  if (x === null || x === undefined) return null;
  const v = parseFloat(x);
  return Number.isFinite(v) && String(x).trim() !== "" && !Number.isNaN(v) ? v : null;
}

// Parse a simple CSV/TSV line, honoring double-quoted fields (matches Python csv.reader closely enough).
function parseCsvLine(line, delim) {
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      inQuotes = true;
    } else if (c === delim) {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

// {key: float} from a JSON object/list or a CSV/TSV (first col key, last numeric col value).
function loadMetrics(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  if (filePath.toLowerCase().endsWith(".json")) {
    const data = JSON.parse(text);
    const out = {};
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) {
        const n = num(v);
        if (n !== null) out[String(k)] = n;
      }
      return out;
    }
    for (const row of data) {
      const key = row.id ?? row.key ?? row.name ?? row.label;
      const val = num(row.value ?? row.val ?? row.metric);
      if (key !== undefined && key !== null && val !== null) out[String(key)] = val;
    }
    return out;
  }
  const lines = text.split(/\r\n|\r|\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const delim = lines.length && lines[0].includes("\t") ? "\t" : ",";
  const out = {};
  for (const line of lines) {
    if (line === "") continue;
    const row = parseCsvLine(line, delim);
    if (row.length < 2) continue;
    const v = num(row[row.length - 1]);
    if (v !== null) out[row[0].trim()] = v; // skip header / non-numeric rows
  }
  return out;
}

function rgb(c) {
  c = c.replace(/^#/, "");
  return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
}

// t in [0,1] -> #rrggbb across a 3-stop (low, mid, high) ramp.
function ramp(anchors, t) {
  const [lo, mid, hi] = anchors.map(rgb);
  const [a, b, u] = t < 0.5 ? [lo, mid, t * 2] : [mid, hi, (t - 0.5) * 2];
  const hex = [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * u).toString(16).padStart(2, "0"));
  return "#" + hex.join("");
}

function darker(hexcolor, f = 0.6) {
  const hex = rgb(hexcolor).map((c) => Math.round(c * f).toString(16).padStart(2, "0"));
  return "#" + hex.join("");
}

// Replace/insert fillColor & strokeColor in a draw.io style string.
function setStyle(style, fill, stroke) {
  let s = (style || "").replace(/(fillColor|strokeColor)=[^;]*;?/g, "").replace(/^[;\s]+|[;\s]+$/g, "");
  return (s ? s + ";" : "") + `fillColor=${fill};strokeColor=${stroke};`;
}

// [{cell, id, label}] for every vertex, unwrapping UserObject/object wrappers.
function vertices(root) {
  const out = [];
  for (const child of root.children) {
    if (child.tag === "mxCell" && child.attrs.vertex === "1") {
      out.push({ cell: child, id: child.attrs.id, label: clean(child.attrs.value) });
    } else if (child.tag === "UserObject" || child.tag === "object") {
      const inner = find(child, "mxCell");
      if (inner && inner.attrs.vertex === "1") {
        out.push({ cell: inner, id: child.attrs.id, label: clean(child.attrs.label ?? child.attrs.value) });
      }
    }
  }
  return out;
}

// Grow/shrink a cell about its centre by `factor`.
function scaleGeom(cell, factor) {
  const g = find(cell, "mxGeometry");
  if (!g) return;
  const w = num(g.attrs.width), h = num(g.attrs.height);
  if (w === null || h === null) return;
  const nw = w * factor, nh = h * factor;
  g.attrs.width = fmt(nw);
  g.attrs.height = fmt(nh);
  for (const [attr, delta] of [["x", (nw - w) / 2], ["y", (nh - h) / 2]]) {
    const v = num(g.attrs[attr]);
    if (v !== null) g.attrs[attr] = fmt(v - delta);
  }
}

// Python "%g" formatting.
function fmt(n) {
  if (Number.isInteger(n)) return String(n);
  let s = n.toPrecision(6);
  if (s.includes(".") && !s.includes("e") && !s.includes("E")) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

function colorFor(val, lo, hi, anchors, reverse) {
  const t = hi > lo ? (val - lo) / (hi - lo) : 0.5;
  const fill = ramp(anchors, reverse ? 1 - t : t);
  return [fill, darker(fill), t];
}

// (min_x, min_y) of the page's top-level cells, so the legend sits clear of them.
function contentBounds(root) {
  const xs = [], ys = [];
  for (const child of root.children) {
    const cell = child.tag === "mxCell" ? child : find(child, "mxCell");
    if (!cell || cell.attrs.parent !== "1") continue; // skip nested (relative-coord) cells
    const g = find(cell, "mxGeometry");
    const x = g ? num(g.attrs.x) : null;
    const y = g ? num(g.attrs.y) : null;
    if (x !== null && y !== null) {
      xs.push(x);
      ys.push(y);
    }
  }
  return [xs.length ? Math.min(...xs) : 20, ys.length ? Math.min(...ys) : 20];
}

// Drop a small min/mid/max swatch legend just left of the page's content.
function addLegend(root, anchors, lo, hi, reverse) {
  const w = 90, h = 26;
  const [cx, cy] = contentBounds(root);
  const x0 = cx - w - 40, y0 = cy; // to the left of the diagram

  function cell(cid, value, style, gy, gh) {
    const c = { tag: "mxCell", attrs: { id: cid, value, style, vertex: "1", parent: "1" }, children: [], text: "" };
    c.children.push({
      tag: "mxGeometry",
      attrs: { x: fmt(x0), y: fmt(gy), width: fmt(w), height: fmt(gh), as: "geometry" },
      children: [],
      text: "",
    });
    root.children.push(c);
  }

  cell("hm-title", "Heatmap", "text;html=1;fontStyle=1;align=left;verticalAlign=middle;", y0, 20);
  const stops = [hi, (lo + hi) / 2, lo];
  stops.forEach((val, i) => {
    const [fill, stroke] = colorFor(val, lo, hi, anchors, reverse);
    cell(
      `hm-${i}`,
      fmt(val),
      setStyle("rounded=0;whiteSpace=wrap;html=1;", fill, stroke),
      y0 + 24 + i * (h + 4),
      h
    );
  });
}

const a = parseArgs(
  {
    name: "heatmap",
    usage: "Usage: heatmap.mjs <file.drawio> --metrics <file.csv|json> [-o out.drawio]\n" +
      "       [--palette heat|cool|warm] [--reverse] [--size] [--no-legend]",
    flags: {
      metrics: { short: "-m", takesValue: true, required: true },
      output: { short: "-o", takesValue: true },
      palette: { takesValue: true, default: "heat" },
      reverse: {},
      size: {},
      "no-legend": {},
    },
  },
  process.argv.slice(2)
);

if (a._.length !== 1) die("need exactly one <file.drawio>");
const file = a._[0];

if (!a.metrics) die("the following arguments are required: -m/--metrics");
if (!Object.prototype.hasOwnProperty.call(PALETTES, a.palette)) {
  process.stderr.write(
    `usage: heatmap.mjs [-h] -m METRICS [-o OUTPUT] [--palette {heat,cool,warm}]\n` +
      `                    [--reverse] [--size] [--no-legend]\n` +
      `                    file\n` +
      `heatmap.mjs: error: argument --palette: invalid choice: '${a.palette}' (choose from 'heat', 'cool', 'warm')\n`
  );
  process.exit(2);
}

if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die(`${file} not found`);
if (!fs.existsSync(a.metrics) || !fs.statSync(a.metrics).isFile()) die(`${a.metrics} not found`);

const metrics = loadMetrics(a.metrics);
if (!Object.keys(metrics).length) die(`no numeric metrics parsed from ${a.metrics}`);
const lowMap = {};
for (const [k, v] of Object.entries(metrics)) lowMap[k.toLowerCase()] = v;
const anchors = PALETTES[a.palette];
const values = Object.values(metrics);
const lo = Math.min(...values), hi = Math.max(...values);

const root = parse(fs.readFileSync(file, "utf8"));
let matched = 0;
let firstRoot = null;
for (const diagram of findAll(root, "diagram")) {
  const model = find(diagram, "mxGraphModel");
  const r = model ? find(model, "root") : null;
  if (!r) continue; // compressed / empty page
  if (firstRoot === null) firstRoot = r;
  for (const { cell, id: cid, label } of vertices(r)) {
    let val = Object.prototype.hasOwnProperty.call(metrics, cid) ? metrics[cid] : null;
    if (val === null && label) {
      val = Object.prototype.hasOwnProperty.call(metrics, label)
        ? metrics[label]
        : Object.prototype.hasOwnProperty.call(lowMap, label.toLowerCase())
          ? lowMap[label.toLowerCase()]
          : null;
    }
    if (val === null) continue;
    const [fill, stroke, t] = colorFor(val, lo, hi, anchors, a.reverse);
    cell.attrs.style = setStyle(cell.attrs.style, fill, stroke);
    if (a.size && hi > lo) scaleGeom(cell, 0.7 + 0.8 * t);
    matched++;
  }
}

if (!a["no-legend"] && firstRoot !== null && matched) {
  addLegend(firstRoot, anchors, lo, hi, a.reverse);
}

const out = a.output || file.replace(/\.[^./]+$/, "") + "-heat.drawio";
fs.writeFileSync(out, serialize(root), "utf8");
if (matched === 0) {
  process.stderr.write("warning: no nodes matched any metric key (check ids/labels)\n");
}
process.stderr.write(`wrote ${out} (${matched}/${Object.keys(metrics).length} metrics matched)\n`);

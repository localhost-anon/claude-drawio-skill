#!/usr/bin/env node
// Deterministic structural linter for .drawio files.
//
// Usage: validate.mjs <file.drawio> [--strict] [--score]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";
import { parse, find, findAll } from "./lib/xml.mjs";

const RESERVED = new Set(["0", "1"]);

// Approximate Python's repr() for the plain strings used as ids/keys here.
function pyRepr(s) {
  if (s === null || s === undefined) return "None";
  return `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// Approximate Python's "{x:g}" general float format.
function pyG(x) {
  if (Number.isInteger(x)) return String(x);
  let s = x.toPrecision(6);
  if (s.includes("e") || s.includes("E")) return String(x);
  if (s.includes(".")) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

function attr(el, name, dflt) {
  const v = el.attrs[name];
  return v === undefined ? dflt : v;
}

// Parse a numeric string the way Python's float() does: returns NaN only for
// the literal "nan"/"inf" spellings; any other unparseable string is a hard
// failure (Python raises ValueError -> rect() returns None).
function pyFloat(s) {
  if (/^[+-]?(nan)$/i.test(s)) return NaN;
  if (/^[+-]?(inf(inity)?)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (s.trim() === "" || Number.isNaN(Number(s))) return undefined; // parse failure
  return Number(s);
}

function rect(cell) {
  const g = find(cell, "mxGeometry");
  if (!g) return null;
  const xs = attr(g, "x", "0");
  const ys = attr(g, "y", "0");
  const ws = attr(g, "width", "nan");
  const hs = attr(g, "height", "nan");
  const x = pyFloat(String(xs));
  const y = pyFloat(String(ys));
  const w = pyFloat(String(ws));
  const h = pyFloat(String(hs));
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return [x, y, w, h];
}

function isEdgeLabel(cell) {
  if ((attr(cell, "style", "") || "").includes("edgeLabel")) return true;
  const g = find(cell, "mxGeometry");
  return !!g && attr(g, "relative", null) === "1";
}

function overlap(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

function styleNum(style, key) {
  for (const part of (style || "").split(";")) {
    if (part.startsWith(key + "=")) {
      const v = parseFloat(part.slice(key.length + 1));
      return isNaN(v) ? null : v;
    }
  }
  return null;
}

function absRect(cell, byId) {
  const r = rect(cell);
  if (r === null || r.some((v) => Number.isNaN(v))) return null;
  let [x, y, w, h] = r;
  let parent = cell.attrs.parent;
  const seen = new Set();
  while (parent && byId.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    const p = byId.get(parent);
    if (p.attrs.vertex === "1") {
      const pr = rect(p);
      if (pr && !pr.some((v) => Number.isNaN(v))) {
        x += pr[0];
        y += pr[1];
      }
    }
    parent = p.attrs.parent;
  }
  return [x, y, w, h];
}

function endpoint(edge, end, byId) {
  const vid = edge.attrs[end];
  if (!vid || !byId.has(vid)) return null;
  const box = absRect(byId.get(vid), byId);
  if (box === null) return null;
  const [x, y, w, h] = box;
  const style = edge.attrs.style || "";
  const fx = styleNum(style, end === "source" ? "exitX" : "entryX");
  const fy = styleNum(style, end === "source" ? "exitY" : "entryY");
  return [x + (fx !== null ? fx : 0.5) * w, y + (fy !== null ? fy : 0.5) * h];
}

function edgeWaypoints(edge) {
  const g = find(edge, "mxGeometry");
  if (!g) return [];
  const arr = find(g, "Array");
  if (!arr) return [];
  const pts = [];
  for (const pt of arr.children) {
    if (pt.tag !== "mxPoint") continue;
    const px = pt.attrs.x;
    const py = pt.attrs.y;
    if (px !== undefined && py !== undefined) {
      const fx = parseFloat(px);
      const fy = parseFloat(py);
      if (!Number.isNaN(fx) && !Number.isNaN(fy)) pts.push([fx, fy]);
    }
  }
  return pts;
}

function edgeRoute(edge, byId) {
  const waypoints = edgeWaypoints(edge);
  if (waypoints.length === 0) return null;
  const s = endpoint(edge, "source", byId);
  const t = endpoint(edge, "target", byId);
  if (s === null || t === null) return null;
  return [s, ...waypoints, t];
}

function orient(a, b, c) {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1;
}

function segmentsCross(p1, p2, p3, p4) {
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);
  return o1 !== o2 && o3 !== o4 && ![o1, o2, o3, o4].includes(0);
}

function pointInRect(p, box, eps = 1e-6) {
  const [x, y, w, h] = box;
  return x + eps < p[0] && p[0] < x + w - eps && y + eps < p[1] && p[1] < y + h - eps;
}

function routeHitsRect(points, box) {
  const [x, y, w, h] = box;
  const corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const borders = corners.map((c, i) => [c, corners[(i + 1) % corners.length]]);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (pointInRect(a, box) || pointInRect(b, box)) return true;
    if (borders.some(([c, d]) => segmentsCross(a, b, c, d))) return true;
  }
  return false;
}

function routesCross(pa, pb) {
  for (let i = 0; i < pa.length - 1; i++) {
    for (let j = 0; j < pb.length - 1; j++) {
      if (segmentsCross(pa[i], pa[i + 1], pb[j], pb[j + 1])) return true;
    }
  }
  return false;
}

function geometryWarnings(cells, ids, parents) {
  const warns = [];
  const routed = [];
  for (const c of cells) {
    if (c.attrs.edge === "1") {
      const pts = edgeRoute(c, ids);
      if (pts) routed.push([c.attrs.id, pts, new Set([c.attrs.source, c.attrs.target])]);
    }
  }
  let leaves = cells
    .filter((c) => c.attrs.vertex === "1" && !parents.has(c.attrs.id) && !isEdgeLabel(c))
    .map((c) => [c.attrs.id, absRect(c, ids)]);
  leaves = leaves.filter(([, box]) => box);

  for (const [eid, pts, ends] of routed) {
    for (const [vid, box] of leaves) {
      if (!ends.has(vid) && routeHitsRect(pts, box)) {
        warns.push(`edge ${pyRepr(eid)} routes through vertex ${pyRepr(vid)}`);
      }
    }
  }
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      const [ia, pa] = routed[i];
      const [ib, pb] = routed[j];
      if (routesCross(pa, pb)) {
        warns.push(`edges ${pyRepr(ia)} and ${pyRepr(ib)} cross`);
      }
    }
  }
  return warns;
}

function checkPage(diagram) {
  const name = attr(diagram, "name", "?");
  const model = find(diagram, "mxGraphModel");
  if (!model) {
    if ((diagram.text || "").trim()) {
      return [[], [`page ${pyRepr(name)}: compressed, skipped (cannot lint)`]];
    }
    return [[`page ${pyRepr(name)}: no <mxGraphModel>`], []];
  }
  const root = find(model, "root");

  const cells = [];
  for (const child of root ? root.children : []) {
    if (child.tag === "mxCell") {
      cells.push(child);
    } else if (child.tag === "UserObject" || child.tag === "object") {
      const inner = find(child, "mxCell");
      if (inner) {
        inner.attrs.id = child.attrs.id || "";
        cells.push(inner);
      }
    }
  }

  const errors = [];
  const warns = [];
  const ids = new Map();
  for (const c of cells) {
    const cid = c.attrs.id;
    if (ids.has(cid)) errors.push(`duplicate id ${pyRepr(cid)}`);
    ids.set(cid, c);
  }
  const parents = new Set(cells.map((c) => c.attrs.parent));

  for (const c of cells) {
    const cid = c.attrs.id;
    const parent = c.attrs.parent;
    const isV = c.attrs.vertex === "1";
    const isE = c.attrs.edge === "1";
    if (parent !== undefined && parent !== null && !ids.has(parent)) {
      errors.push(`cell ${pyRepr(cid)} parent ${pyRepr(parent)} does not exist`);
    }
    for (const end of ["source", "target"]) {
      const ref = c.attrs[end];
      if (ref && !ids.has(ref)) {
        errors.push(`edge ${pyRepr(cid)} ${end} ${pyRepr(ref)} does not exist`);
      }
    }
    if ((isV || isE) && RESERVED.has(cid)) {
      errors.push(`cell ${pyRepr(cid)} reuses reserved id 0/1`);
    }
    if (isV && !isEdgeLabel(c)) {
      const r = rect(c);
      if (r === null || r.some((v) => Number.isNaN(v))) {
        errors.push(`vertex ${pyRepr(cid)} has missing/invalid geometry`);
      } else {
        const [x, y, w, h] = r;
        if (w <= 0 || h <= 0) {
          warns.push(`vertex ${pyRepr(cid)} non-positive size ${pyG(w)}x${pyG(h)}`);
        }
        if (x < 0 || y < 0) {
          warns.push(`vertex ${pyRepr(cid)} negative position (${pyG(x)},${pyG(y)})`);
        }
      }
    }
  }

  const boxes = cells
    .filter((c) => c.attrs.vertex === "1" && !parents.has(c.attrs.id))
    .map((c) => [c.attrs.id, c.attrs.parent, rect(c)])
    .filter(([, , r]) => r && !r.some((v) => Number.isNaN(v)));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [ia, pa, ra] = boxes[i];
      const [ib, pb, rb] = boxes[j];
      if (pa === pb && overlap(ra, rb)) {
        warns.push(`vertices ${pyRepr(ia)} and ${pyRepr(ib)} overlap`);
      }
    }
  }

  for (const w of geometryWarnings(cells, ids, parents)) warns.push(w);
  return [errors, warns];
}

const a = parseArgs({
  name: "validate",
  usage: "Usage: validate.mjs <file.drawio> [--strict] [--score]",
  flags: {
    strict: {},
    score: {},
  },
}, process.argv.slice(2));

if (a._.length !== 1) die("need exactly one <file.drawio>");
const file = a._[0];

let root;
try {
  const text = fs.readFileSync(file, "utf8");
  root = parse(text);
} catch (exc) {
  const msg = exc && exc.code === "ENOENT"
    ? `[Errno 2] No such file or directory: '${file}'`
    : String(exc.message || exc);
  process.stderr.write(`error: cannot parse ${file}: ${msg}\n`);
  process.exit(1);
}

const topDiagrams = root.children.filter((c) => c.tag === "diagram");
const pages = topDiagrams.length ? topDiagrams : [root];

let errors = [];
let warns = [];
for (const page of pages) {
  const [e, w] = checkPage(page);
  errors = errors.concat(e);
  warns = warns.concat(w);
}

for (const w of warns) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
console.log(`${errors.length} error(s), ${warns.length} warning(s)`);

if (a.score) {
  const through = warns.filter((w) => w.includes("routes through")).length;
  const cross = warns.filter((w) => w.includes(" cross")).length;
  const olap = warns.filter((w) => w.includes(" overlap")).length;
  console.log(
    `score: ${20 * through + 10 * cross + 5 * olap} (${through} through-vertex, ${cross} crossings, ${olap} overlaps)`
  );
}

if (errors.length || (a.strict && warns.length)) {
  process.exit(1);
}

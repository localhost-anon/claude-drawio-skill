#!/usr/bin/env node
// Diff two .drawio diagrams into a colour-coded autolayout graph JSON.
//
// Usage: drawiodiff.mjs <old.drawio> <new.drawio> [-o diff.json]
//        [--direction TB|LR] [--by-label]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";
import { parse as parseXml, find } from "./lib/xml.mjs";

const STYLE = {
  added: "rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;",
  removed: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;dashed=1;",
  changed: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;",
  same: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#999999;",
};
const EDGE_STYLE = {
  added: "endArrow=classic;html=1;strokeColor=#82b366;strokeWidth=2;",
  removed: "endArrow=classic;html=1;strokeColor=#b85450;strokeWidth=2;dashed=1;",
  same: "endArrow=classic;html=1;strokeColor=#999999;",
};

// Return {nodes: Map(id -> [label, style]), edges: Set(\0-joined "source\0target")} for
// a .drawio: nodes are leaf vertices, edges are (source_id, target_id) pairs.
// Cells are flattened across pages; UserObject/object wrappers are unwrapped.
function parseFile(filePath) {
  let root;
  try {
    root = parseXml(fs.readFileSync(filePath, "utf8"));
  } catch (exc) {
    const msg = exc && exc.code === "ENOENT"
      ? `[Errno 2] No such file or directory: '${filePath}'`
      : String(exc.message || exc);
    process.stderr.write(`error: cannot parse ${filePath}: ${msg}\n`);
    process.exit(1);
  }
  const topDiagrams = root.children.filter((c) => c.tag === "diagram");
  const pages = topDiagrams.length ? topDiagrams : [root];

  const cells = [];
  const labels = new Map();
  for (const page of pages) {
    const model = find(page, "mxGraphModel");
    const r = model ? find(model, "root") : null;
    if (!r) {
      if ((page.text || "").trim()) {
        process.stderr.write(`warning: ${filePath}: a page is compressed, skipped\n`);
      }
      continue;
    }
    for (const child of r.children) {
      if (child.tag === "mxCell") {
        cells.push(child);
        labels.set(child.attrs.id, child.attrs.value || "");
      } else if (child.tag === "UserObject" || child.tag === "object") {
        const inner = find(child, "mxCell");
        if (inner) {
          inner.attrs.id = child.attrs.id || "";
          cells.push(inner);
          labels.set(child.attrs.id, child.attrs.label || child.attrs.value || "");
        }
      }
    }
  }

  const parents = new Set(cells.map((c) => c.attrs.parent));
  const nodes = new Map();
  const edges = new Set();
  for (const c of cells) {
    const cid = c.attrs.id;
    if (c.attrs.edge === "1") {
      const s = c.attrs.source;
      const t = c.attrs.target;
      if (s && t) edges.add(`${s}\0${t}`);
    } else if (c.attrs.vertex === "1" && !parents.has(cid)) {
      if ((c.attrs.style || "").includes("edgeLabel")) continue;
      const g = find(c, "mxGeometry");
      if (g && g.attrs.relative === "1") continue;
      nodes.set(cid, [labels.get(cid) || "", c.attrs.style || ""]);
    }
  }
  return { nodes, edges };
}

const a = parseArgs({
  name: "drawiodiff",
  usage: "Usage: drawiodiff.mjs <old.drawio> <new.drawio> [-o diff.json] [--direction TB|LR] [--by-label]",
  flags: {
    output: { short: "-o", takesValue: true },
    direction: { takesValue: true },
    "by-label": {},
  },
}, process.argv.slice(2));

if (a._.length !== 2) die("need <old.drawio> and <new.drawio>");
const direction = a.direction || "TB";
if (direction !== "TB" && direction !== "LR") die(`argument --direction: invalid choice: '${direction}' (choose from 'TB', 'LR')`);

const [oldPath, newPath] = a._;
const { nodes: oldN, edges: oldE } = parseFile(oldPath);
const { nodes: newN, edges: newE } = parseFile(newPath);

// keyed(nodes) -> [keys: Map(key -> label), id2key: Map(id -> key)]
// By id (default) the key is the cell id and the value is its label; by
// label the key *is* the label.
function keyed(nodes) {
  if (a["by-label"]) {
    const keys = new Map();
    for (const [lbl] of nodes.values()) keys.set(lbl, lbl);
    const id2key = new Map();
    for (const [id, [lbl]] of nodes) id2key.set(id, lbl);
    return [keys, id2key];
  }
  const keys = new Map();
  for (const [id, [lbl]] of nodes) keys.set(id, lbl);
  const id2key = new Map();
  for (const id of nodes.keys()) id2key.set(id, id);
  return [keys, id2key];
}

const [oldKeys, oldId2key] = keyed(oldN);
const [newKeys, newId2key] = keyed(newN);

const allKeys = [...new Set([...oldKeys.keys(), ...newKeys.keys()])].sort();
const nodes = [];
const counts = { added: 0, removed: 0, changed: 0, same: 0 };
for (const key of allKeys) {
  let status, label;
  const inOld = oldKeys.has(key);
  const inNew = newKeys.has(key);
  if (inOld && !inNew) {
    status = "removed";
    label = oldKeys.get(key);
  } else if (inNew && !inOld) {
    status = "added";
    label = newKeys.get(key);
  } else if (oldKeys.get(key) !== newKeys.get(key)) {
    status = "changed";
    label = newKeys.get(key);
  } else {
    status = "same";
    label = newKeys.get(key);
  }
  counts[status]++;
  nodes.push({ id: key, label: label || key, style: STYLE[status], width: 160, height: 60 });
}

// edgeKeys(edges, id2key) -> Set(\0-joined "skey\0tkey")
function edgeKeys(edges, id2key) {
  const out = new Set();
  for (const pair of edges) {
    const [s, t] = pair.split("\0");
    if (id2key.has(s) && id2key.has(t)) out.add(`${id2key.get(s)}\0${id2key.get(t)}`);
  }
  return out;
}

const oldEk = edgeKeys(oldE, oldId2key);
const newEk = edgeKeys(newE, newId2key);
const nodeKeys = new Set(nodes.map((n) => n.id));
const edges = [];
for (const pair of [...new Set([...oldEk, ...newEk])].sort()) {
  const [s, t] = pair.split("\0");
  if (!nodeKeys.has(s) || !nodeKeys.has(t)) continue;
  const inOld = oldEk.has(pair);
  const inNew = newEk.has(pair);
  const status = inOld && inNew ? "same" : inNew ? "added" : "removed";
  edges.push({ source: s, target: t, style: EDGE_STYLE[status] });
}

const graph = { direction, nodes, edges };
const text = JSON.stringify(graph, null, 2);
if (a.output) {
  fs.writeFileSync(a.output, text, "utf8");
  process.stderr.write(`wrote ${a.output}\n`);
} else {
  process.stdout.write(text);
}
process.stderr.write(
  `+${counts.added} added, -${counts.removed} removed, ~${counts.changed} changed, =${counts.same} unchanged\n`
);

#!/usr/bin/env node
// Extract a JS/TS project's module-import graph as autolayout graph JSON.
// Direct port of jsimports.py — the Python original was already regex-based
// (not `ast`), so this is a faithful line-for-line transliteration.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, die } from "./lib/args.mjs";

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const SPEC = new RegExp(
  "(?:import|export)\\b[^'\";]*?\\bfrom\\s*['\"]([^'\"]+)['\"]" +
    "|import\\s*['\"]([^'\"]+)['\"]" +
    "|require\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)" +
    "|import\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)",
  "g"
);

function modid(p, root) {
  let rel = path.relative(root, p);
  for (const ext of EXTS) {
    if (rel.endsWith(ext)) { rel = rel.slice(0, -ext.length); break; }
  }
  return rel.split(path.sep).join("/");
}

function discover(root) {
  root = path.resolve(root);
  const modules = {};
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const fn of entries) {
      if (fn.isDirectory()) {
        if (fn.name === "node_modules" || fn.name.startsWith(".")) continue;
        walk(path.join(dir, fn.name));
        continue;
      }
      if (EXTS.some((e) => fn.name.endsWith(e)) && !fn.name.endsWith(".d.ts")) {
        const full = path.join(dir, fn.name);
        modules[modid(full, root)] = full;
      }
    }
  };
  walk(root);
  return { modules, root };
}

function resolveSpec(spec, importer, root, modules) {
  if (!spec.startsWith(".")) return null;
  const base = path.normalize(path.join(path.dirname(importer), spec));
  const candidates = [
    ...EXTS.map((e) => base + e),
    ...EXTS.map((e) => path.join(base, "index" + e)),
    base,
  ];
  for (const cand of candidates) {
    const mid = modid(cand, root);
    if (Object.prototype.hasOwnProperty.call(modules, mid) && modules[mid] !== importer) return mid;
  }
  return null;
}

function edgesOf(mid, filePath, root, modules) {
  const found = new Set();
  let src;
  try { src = fs.readFileSync(filePath, "utf8"); } catch { return found; }
  for (const m of src.matchAll(SPEC)) {
    const spec = m[1] || m[2] || m[3] || m[4];
    const target = resolveSpec(spec, filePath, root, modules);
    if (target && target !== mid) found.add(target);
  }
  return found;
}

function transitiveReduce(nodes, edges) {
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const dot = "digraph{" + edges.map(([s, t]) => `${idx.get(s)}->${idx.get(t)};`).join("") + "}";
  let res;
  try { res = spawnSync("tred", { input: dot, encoding: "utf8" }); } catch (e) {
    process.stderr.write(`warning: tred unavailable, keeping all edges (${e.message})\n`);
    return edges;
  }
  if (!res || res.error || res.status !== 0) {
    const msg = res && res.error ? res.error.message : "tred not found";
    process.stderr.write(`warning: tred unavailable, keeping all edges (${msg})\n`);
    return edges;
  }
  const rev = new Map(nodes.map((n, i) => [i, n]));
  const out = [];
  for (const m of res.stdout.matchAll(/(\d+)\s*->\s*(\d+)/g)) out.push([rev.get(Number(m[1])), rev.get(Number(m[2]))]);
  return out;
}

function commonDir(ids) {
  const split = ids.map((m) => m.split("/"));
  const minLen = Math.min(...split.map((s) => s.length));
  const common = [];
  for (let i = 0; i < minLen; i++) {
    const seg = split[0][i];
    if (split.every((s) => s[i] === seg)) common.push(seg);
    else break;
  }
  return common.length ? common.join("/") + "/" : "";
}

function main() {
  const a = parseArgs(
    {
      name: "jsimports",
      usage: "Usage: jsimports.mjs <src_dir> [-o graph.json] [--direction TB|LR] [--group] [--no-reduce]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "TB" },
        group: {},
        "no-reduce": {},
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("the following arguments are required: src");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const { modules, root } = discover(a._[0]);
  if (Object.keys(modules).length === 0) {
    process.stderr.write(`error: no JS/TS modules found under ${a._[0]}\n`);
    process.exit(1);
  }
  const edgeSet = new Set();
  const pairs = [];
  for (const [m, p] of Object.entries(modules)) {
    for (const t of edgesOf(m, p, root, modules)) {
      const key = `${m} ${t}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); pairs.push([m, t]); }
    }
  }
  pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const raw = pairs.length;
  let edges = pairs;
  if (!a["no-reduce"]) edges = transitiveReduce(Object.keys(modules), pairs);

  const strip = commonDir(Object.keys(modules));
  const label = (m) => (strip && m.startsWith(strip) ? m.slice(strip.length) : m) || m;

  const node = (m) => {
    const d = { id: m, label: label(m) };
    if (a.group) {
      const rest = label(m).split("/");
      if (rest.length > 1) d.group = rest.slice(0, -1).join("/");
    }
    return d;
  };

  const graph = {
    direction: a.direction,
    nodes: Object.keys(modules).map(node),
    edges: edges.map(([s, t]) => ({ source: s, target: t })),
  };
  const text = JSON.stringify(graph, null, 2);
  if (a.output) {
    fs.writeFileSync(a.output, text, "utf8");
    process.stderr.write(`wrote ${a.output}\n`);
  } else {
    process.stdout.write(text);
  }
  const note = a["no-reduce"] ? "" : ` (reduced from ${raw})`;
  process.stderr.write(`${Object.keys(modules).length} modules, ${edges.length} edges${note}\n`);
}

main();

#!/usr/bin/env node
// Extract a Go module's package-import graph as autolayout graph JSON.
// Direct port of goimports.py — the Python original was already regex-based.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, die } from "./lib/args.mjs";

const MODULE_RE = /^module\s+(\S+)/m;
const BLOCK_RE = /import\s*\(([\s\S]*?)\)/g;
const SINGLE_RE = /import\s+(?:[\w.]+\s+|_\s+)?"([^"]+)"/g;
const QUOTED_RE = /"([^"]+)"/g;

function modulePath(root) {
  const gomod = path.join(root, "go.mod");
  if (!fs.existsSync(gomod)) return null;
  const text = fs.readFileSync(gomod, "utf8");
  const m = text.match(MODULE_RE);
  return m ? m[1] : null;
}

function discover(root, modpath) {
  root = path.resolve(root);
  const pkgs = {};
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dirs = entries.filter((e) => e.isDirectory() && e.name !== "vendor" && e.name !== "testdata" && !e.name.startsWith("."));
    const files = entries.filter((e) => e.isFile());
    const gofiles = files.filter((f) => f.name.endsWith(".go") && !f.name.endsWith("_test.go")).map((f) => path.join(dir, f.name));
    if (gofiles.length) {
      const rel = path.relative(root, dir).split(path.sep).join("/");
      const ip = rel === "" ? modpath : `${modpath}/${rel}`;
      pkgs[ip] = gofiles;
    }
    for (const d of dirs) walk(path.join(dir, d.name));
  };
  walk(root);
  return pkgs;
}

function importsOf(files, modpath, pkgs) {
  const found = new Set();
  for (const filePath of files) {
    let src;
    try { src = fs.readFileSync(filePath, "utf8"); } catch { continue; }
    const specs = [];
    for (const m of src.matchAll(BLOCK_RE)) {
      for (const q of m[1].matchAll(QUOTED_RE)) specs.push(q[1]);
    }
    for (const m of src.matchAll(SINGLE_RE)) specs.push(m[1]);
    for (const spec of specs) {
      if ((spec === modpath || spec.startsWith(modpath + "/")) && Object.prototype.hasOwnProperty.call(pkgs, spec)) {
        found.add(spec);
      }
    }
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

function main() {
  const a = parseArgs(
    {
      name: "goimports",
      usage: "Usage: goimports.mjs <module_dir> [-o graph.json] [--direction TB|LR] [--group] [--no-reduce]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "TB" },
        group: {},
        "no-reduce": {},
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("the following arguments are required: module");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const modpath = modulePath(a._[0]);
  if (!modpath) {
    process.stderr.write(`error: no go.mod with a module path found in ${a._[0]}\n`);
    process.exit(1);
  }
  const pkgs = discover(a._[0], modpath);
  if (Object.keys(pkgs).length === 0) {
    process.stderr.write(`error: no Go packages found under ${a._[0]}\n`);
    process.exit(1);
  }
  const edgeSet = new Set();
  const pairs = [];
  for (const [ip, files] of Object.entries(pkgs)) {
    for (const t of importsOf(files, modpath, pkgs)) {
      if (t === ip) continue;
      const key = `${ip} ${t}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); pairs.push([ip, t]); }
    }
  }
  pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const raw = pairs.length;
  let edges = pairs;
  if (!a["no-reduce"]) edges = transitiveReduce(Object.keys(pkgs), pairs);

  const strip = modpath + "/";
  const label = (ip) => (ip.startsWith(strip) ? ip.slice(strip.length) : path.basename(ip));

  const node = (ip) => {
    const d = { id: ip, label: label(ip) };
    if (a.group) {
      const rest = label(ip).split("/");
      if (rest.length > 1) d.group = rest.slice(0, -1).join("/");
    }
    return d;
  };

  const graph = {
    direction: a.direction,
    nodes: Object.keys(pkgs).map(node),
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
  process.stderr.write(`${Object.keys(pkgs).length} packages, ${edges.length} edges${note}\n`);
}

main();

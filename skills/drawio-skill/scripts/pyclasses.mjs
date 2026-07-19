#!/usr/bin/env node
// Extract a Python project's class-inheritance graph as autolayout graph JSON.
//
// Node port of pyclasses.py. Python original used `ast` to find top-level
// ClassDef nodes and their base-class expressions exactly; this port scans
// each .py file line-by-line with a regex instead:
//   /^class\s+(\w+)\s*(?:\(([^)]*)\))?:/
// This only matches classes defined at column 0 (top-level, un-indented),
// mirroring `tree.body` (top-level statements only) in the Python original.
// Decorated classes are still captured since the decorator line itself
// doesn't match and is simply skipped; a `@decorator` immediately preceding
// a `class Foo:` line has no effect on this regex. String-literal false
// positives (e.g. a string containing the text "class Foo:") are not
// filtered out.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, die } from "./lib/args.mjs";

function discover(root) {
  root = path.resolve(root);
  const base = fs.existsSync(path.join(root, "__init__.py")) ? path.basename(root) : "";
  const modules = {};
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const fn of entries) {
      const full = path.join(dir, fn.name);
      if (fn.isDirectory()) { walk(full); continue; }
      if (!fn.name.endsWith(".py")) continue;
      let rel = path.relative(root, full).slice(0, -3);
      let parts = rel.split(path.sep);
      if (parts[parts.length - 1] === "__init__") parts = parts.slice(0, -1);
      if (base) parts = [base, ...parts];
      if (parts.length) modules[parts.join(".")] = full;
    }
  };
  walk(root);
  return { modules, base };
}

// Simple name of a base-class expression: `Foo` -> "Foo", `pkg.mod.Foo` -> "Foo".
function baseName(expr) {
  const t = expr.trim();
  if (!t) return null;
  // strip keyword-argument bases (metaclass=Foo) — ast.ClassDef.bases excludes
  // keywords entirely, so drop anything with "=" at top level.
  if (t.includes("=")) return null;
  const dotted = t.split(".").pop().trim();
  const m = dotted.match(/^\w+$/);
  return m ? dotted : null;
}

const CLASS_RE = /^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/;

function classesIn(module, filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "");
    const m = line.match(CLASS_RE);
    if (!m) continue;
    const name = m[1];
    const basesExpr = m[2] || "";
    const bases = basesExpr
      .split(",")
      .map((b) => baseName(b))
      .filter((b) => b);
    out.push([`${module}.${name}`, name, bases]);
  }
  return out;
}

function transitiveReduce(nodes, edges) {
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const dot = "digraph{" + edges.map(([s, t]) => `${idx.get(s)}->${idx.get(t)};`).join("") + "}";
  let res;
  try {
    res = spawnSync("tred", { input: dot, encoding: "utf8" });
  } catch (e) {
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
  for (const m of res.stdout.matchAll(/(\d+)\s*->\s*(\d+)/g)) {
    out.push([rev.get(Number(m[1])), rev.get(Number(m[2]))]);
  }
  return out;
}

function main() {
  const a = parseArgs(
    {
      name: "pyclasses",
      usage: "Usage: pyclasses.mjs <project_dir> [-o graph.json] [--direction TB|LR] [--group] [--no-reduce]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "TB" },
        group: {},
        "no-reduce": {},
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("the following arguments are required: project");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const { modules, base } = discover(a._[0]);
  const classes = new Map(); // cid -> { mod, bases }
  const byName = new Map(); // simple name -> [cid]
  for (const [mod, p] of Object.entries(modules)) {
    for (const [cid, name, bases] of classesIn(mod, p)) {
      classes.set(cid, { mod, bases });
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(cid);
    }
  }
  if (classes.size === 0) {
    process.stderr.write(`error: no classes found under ${a._[0]}\n`);
    process.exit(1);
  }

  const resolve = (name, mod) => {
    const cands = byName.get(name) || [];
    const same = cands.filter((c) => classes.get(c).mod === mod);
    if (same.length) return same[0];
    return cands.length === 1 ? cands[0] : null;
  };

  const edgeSet = new Set();
  const pairs = [];
  for (const [cid, { mod, bases }] of classes) {
    for (const b of bases) {
      const target = resolve(b, mod);
      if (target && target !== cid) {
        const key = `${cid} ${target}`;
        if (!edgeSet.has(key)) { edgeSet.add(key); pairs.push([cid, target]); }
      }
    }
  }
  pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const raw = pairs.length;
  let edges = pairs;
  if (!a["no-reduce"]) edges = transitiveReduce([...classes.keys()], pairs);

  const strip = base ? base + "." : "";
  const short = (m) => (strip && m.startsWith(strip) ? m.slice(strip.length) : m);

  const node = (cid) => {
    const d = { id: cid, label: cid.slice(cid.lastIndexOf(".") + 1) };
    if (a.group) {
      const mod = classes.get(cid).mod;
      const p = short(mod).replace(/\./g, "/");
      if (p) d.group = p;
    }
    return d;
  };

  const graph = {
    direction: a.direction,
    nodes: [...classes.keys()].map(node),
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
  process.stderr.write(`${classes.size} classes, ${edges.length} inheritance edges${note}\n`);
}

main();

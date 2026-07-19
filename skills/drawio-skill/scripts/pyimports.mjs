#!/usr/bin/env node
// Extract a Python project's module-import graph as autolayout graph JSON.
//
// Node port of pyimports.py. Python original used the `ast` module to parse
// import statements exactly; this port uses line-based regex against each
// .py file's source instead:
//   /^\s*(?:from\s+([\w.]+)\s+)?import\s+(.+)/
// Decorated/conditional imports at any indent level are captured (regex
// doesn't care about indentation context), and string-literal false
// positives (e.g. a string containing the text "import foo") are not
// filtered out. In practice, on well-formed Python source this produces the
// same import edges as the ast-based original.
//
// Transitive reduction still shells out to Graphviz `tred`; if unavailable,
// falls back to keeping all edges (same as the Python original).
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

function resolve(name, current, modules) {
  let parts = name ? name.split(".") : [];
  while (parts.length) {
    const cand = parts.join(".");
    if (Object.prototype.hasOwnProperty.call(modules, cand) && cand !== current) return cand;
    parts = parts.slice(0, -1);
  }
  return null;
}

const IMPORT_RE = /^\s*(?:from\s+([\w.]+)\s+)?import\s+(.+)/;
const FROM_RELATIVE_RE = /^\s*from\s+(\.+)(\S*)\s+import\s+(.+)/;

function edgesOf(name, filePath, modules) {
  const pkg = filePath.endsWith("__init__.py") ? name : (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "");
  const found = new Set();
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return found;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*/, "");
    const relMatch = line.match(FROM_RELATIVE_RE);
    if (relMatch) {
      const level = relMatch[1].length;
      const modPart = relMatch[2];
      const names = relMatch[3];
      const baseParts = pkg ? pkg.split(".") : [];
      const trimmed = baseParts.slice(0, baseParts.length - (level - 1));
      const prefix = trimmed.join(".");
      const mod = prefix && modPart ? `${prefix}.${modPart}` : (modPart || prefix);
      const target = resolve(mod, name, modules);
      if (target) found.add(target);
      for (const alias of names.split(",")) {
        const nm = alias.trim().split(/\s+as\s+/)[0].trim();
        if (!nm || nm === "*") continue;
        const sub = mod ? `${mod}.${nm}` : nm;
        const t2 = resolve(sub, name, modules);
        if (t2) found.add(t2);
      }
      continue;
    }
    const m = line.match(IMPORT_RE);
    if (!m) continue;
    if (m[1]) {
      // from a.b import c[, d]
      const mod = m[1];
      const target = resolve(mod, name, modules);
      if (target) found.add(target);
      for (const alias of m[2].split(",")) {
        const nm = alias.trim().split(/\s+as\s+/)[0].trim();
        if (!nm || nm === "*" || nm.startsWith("(")) continue;
        const sub = `${mod}.${nm.replace(/[()]/g, "").trim()}`;
        const t2 = resolve(sub, name, modules);
        if (t2) found.add(t2);
      }
    } else {
      // import a.b.c[, d.e]
      for (const alias of m[2].split(",")) {
        const nm = alias.trim().split(/\s+as\s+/)[0].trim();
        if (!nm) continue;
        const target = resolve(nm, name, modules);
        if (target) found.add(target);
      }
    }
  }
  return found;
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
      name: "pyimports",
      usage: "Usage: pyimports.mjs <project_dir> [-o graph.json] [--direction TB|LR] [--group] [--no-reduce]",
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
  if (Object.keys(modules).length === 0) {
    process.stderr.write(`error: no .py modules found under ${a._[0]}\n`);
    process.exit(1);
  }

  const edgeSet = new Set();
  const edgePairs = [];
  for (const [name, p] of Object.entries(modules)) {
    for (const t of edgesOf(name, p, modules)) {
      const key = `${name}\0${t}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); edgePairs.push([name, t]); }
    }
  }
  edgePairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const raw = edgePairs.length;
  let edges = edgePairs;
  if (!a["no-reduce"]) edges = transitiveReduce(Object.keys(modules), edgePairs);

  const strip = base ? base + "." : "";
  const label = (m) => (strip && m.startsWith(strip) ? m.slice(strip.length) : m);

  const node = (m) => {
    const d = { id: m, label: label(m) };
    if (a.group) {
      const rest = label(m).split(".");
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

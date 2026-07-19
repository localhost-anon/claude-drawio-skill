#!/usr/bin/env node
// Extract a Rust crate's module-use graph as autolayout graph JSON.
// Direct port of rustimports.py — the Python original was already
// regex-based, this is a faithful transliteration.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, die } from "./lib/args.mjs";

const USE_RE = /\buse\s+([^;]+);/g;
const NAME_RE = /(?:^|\s)name\s*=\s*"([^"]+)"/m;

function crateName(root) {
  const cargo = path.join(root, "Cargo.toml");
  if (fs.existsSync(cargo)) {
    const text = fs.readFileSync(cargo, "utf8");
    const m = text.match(NAME_RE);
    if (m) return m[1];
  }
  return "crate";
}

function discover(root) {
  root = path.resolve(root);
  const src = fs.existsSync(path.join(root, "src")) && fs.statSync(path.join(root, "src")).isDirectory()
    ? path.join(root, "src")
    : root;
  const modules = new Map(); // key = parts.join("::") ; value = {parts, file}
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const fn of entries) {
      if (fn.isDirectory()) {
        if (fn.name === "target" || fn.name.startsWith(".")) continue;
        walk(path.join(dir, fn.name));
        continue;
      }
      if (!fn.name.endsWith(".rs")) continue;
      const full = path.join(dir, fn.name);
      let rel = path.relative(src, full).slice(0, -3);
      let parts = rel.split(path.sep);
      if (parts[parts.length - 1] === "mod") parts = parts.slice(0, -1);
      if (parts.length === 1 && (parts[0] === "main" || parts[0] === "lib")) parts = [];
      modules.set(parts.join("::"), { parts, file: full });
    }
  };
  walk(src);
  return modules;
}

function splitTop(inner) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function baseSegments(prefix, current) {
  const segs = prefix.split("::").map((s) => s.trim()).filter((s) => s);
  if (segs.length === 0) return null;
  if (segs[0] === "crate") return segs.slice(1);
  if (segs[0] === "self") return [...current, ...segs.slice(1)];
  if (segs[0] === "super") {
    let n = 0;
    let rest = segs;
    while (rest.length && rest[0] === "super") { n++; rest = rest.slice(1); }
    if (n > current.length) return null;
    return [...current.slice(0, current.length - n), ...rest];
  }
  return null;
}

function resolveParts(parts, modules, current) {
  const currentKey = current.join("::");
  if (parts.length === 0) {
    return modules.has("") && "" !== currentKey ? [] : null;
  }
  let p = [...parts];
  while (p.length) {
    const key = p.join("::");
    if (modules.has(key) && key !== currentKey) return p;
    p = p.slice(0, -1);
  }
  return null;
}

function edgesOf(current, filePath, modules) {
  const found = new Set();
  let src;
  try { src = fs.readFileSync(filePath, "utf8"); } catch { return found; }
  for (const m of src.matchAll(USE_RE)) {
    const stmt = m[1];
    let prefix, leaves;
    if (stmt.includes("{")) {
      prefix = stmt.slice(0, stmt.indexOf("{"));
      const inner = stmt.includes("}") ? stmt.slice(stmt.indexOf("{") + 1, stmt.lastIndexOf("}")) : "";
      leaves = splitTop(inner);
    } else {
      prefix = stmt;
      leaves = [null];
    }
    const base = baseSegments(prefix, current);
    if (base === null) continue;
    for (const leaf of leaves) {
      const segs = [...base];
      if (leaf) {
        const first = leaf.trim().split("::")[0].split(/\s+/)[0];
        if (first && first !== "self" && first !== "*") segs.push(first);
      }
      const target = resolveParts(segs, modules, current);
      if (target !== null && target.join("::") !== current.join("::")) found.add(target.join("::"));
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
      name: "rustimports",
      usage: "Usage: rustimports.mjs <crate_dir> [-o graph.json] [--direction TB|LR] [--group] [--no-reduce]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "TB" },
        group: {},
        "no-reduce": {},
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("the following arguments are required: crate");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const modules = discover(a._[0]); // key(::) -> {parts, file}
  if (modules.size === 0) {
    process.stderr.write(`error: no .rs modules found under ${a._[0]}\n`);
    process.exit(1);
  }
  const name = crateName(a._[0]);
  const mid = (parts) => (parts.length === 0 ? name : parts.join("::"));

  const edgeSet = new Set();
  const pairs = [];
  for (const [, { parts, file }] of modules) {
    for (const t of edgesOf(parts, file, modules)) {
      const targetParts = t === "" ? [] : t.split("::");
      const s = mid(parts), tg = mid(targetParts);
      const key = `${s} ${tg}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); pairs.push([s, tg]); }
    }
  }
  pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const raw = pairs.length;
  const allIds = [...modules.values()].map((v) => mid(v.parts));
  let edges = pairs;
  if (!a["no-reduce"]) edges = transitiveReduce(allIds, pairs);

  const node = (parts) => {
    const d = { id: mid(parts), label: parts.length === 0 ? name : parts[parts.length - 1] };
    if (a.group && parts.length > 1) d.group = parts.slice(0, -1).join("/");
    return d;
  };

  const graph = {
    direction: a.direction,
    nodes: [...modules.values()].map((v) => node(v.parts)),
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
  process.stderr.write(`${modules.size} modules, ${edges.length} edges${note}\n`);
}

main();

#!/usr/bin/env node
// Collapse a big .drawio into a boardroom-friendly executive summary.
//
// Node port of compress.py. Detects clusters with a deterministic pure-JS
// label propagation pass (mirrors the Python: no graph library), replaces
// each cluster with ONE labeled group node, keeps aggregated inter-cluster
// edges, and emits a 2-page .drawio: page 1 is the executive view (laid out
// via autolayoutModel — elkjs, not Graphviz dot, so page-1 coordinates will
// differ from the Python output), page 2 is the original diagram copied
// verbatim. Each executive node links to page 2 via a drill-down UserObject.
//
// Usage: compress.mjs <diagram.drawio> [-o out.drawio] [--clusters N]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";
import { parse, find, findAll, serialize } from "./lib/xml.mjs";
import { autolayoutModel, wrapPage } from "./autolayout.mjs";

/**
 * Parse a .drawio file into (nodes, edges): nodes is a Map id -> [label, style]
 * for leaf vertices, edges is a Set of "source-target" pairs. Cells are
 * flattened across pages; UserObject/object wrappers are unwrapped (id on the
 * wrapper, cell inside). Mirrors drawiodiff.parse() — see SHARED CONVENTIONS.
 */
export function parseDrawio(path) {
  let root;
  try {
    root = parse(fs.readFileSync(path, "utf8"));
  } catch (exc) {
    if (exc.code === "ENOENT") die(`cannot parse ${path}: [Errno 2] No such file or directory: '${path}'`);
    die(`cannot parse ${path}: ${exc.message || exc}`);
  }
  const pages = root.children.filter((c) => c.tag === "diagram");
  const effectivePages = pages.length ? pages : [root];
  const cells = [];
  const labels = new Map();
  for (const page of effectivePages) {
    const model = find(page, "mxGraphModel");
    const r = model ? find(model, "root") : null;
    if (!r) {
      if ((page.text || "").trim()) {
        process.stderr.write(`warning: ${path}: a page is compressed, skipped\n`);
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
      const s = c.attrs.source, t = c.attrs.target;
      if (s && t) edges.add(s + SEP + t);
    } else if (c.attrs.vertex === "1" && !parents.has(cid)) {
      if ((c.attrs.style || "").includes("edgeLabel")) continue;
      const g = find(c, "mxGeometry");
      if (g && g.attrs.relative === "1") continue;
      nodes.set(cid, [labels.get(cid) || "", c.attrs.style || ""]);
    }
  }
  return { nodes, edges };
}

const SEP = "\u0000";
export function edgeKey(s, t) {
  return s + SEP + t;
}
export function edgePair(key) {
  return key.split(SEP);
}

/**
 * Deterministic pure-JS label propagation for community detection.
 * Edges are undirected. Each pass computes every node's new label
 * synchronously from the PREVIOUS pass's labels (most frequent label among
 * neighbours, ties -> smallest label), applied all at once. Stops early once
 * no label changes, else after maxPasses. Returns Map id -> community label.
 */
export function labelPropagation(nodeIds, edges, maxPasses = 20) {
  const nodes = [...new Set(nodeIds)].sort();
  const neighbours = new Map(nodes.map((n) => [n, new Set()]));
  for (const key of edges) {
    const [s, t] = edgePair(key);
    if (neighbours.has(s) && neighbours.has(t) && s !== t) {
      neighbours.get(s).add(t);
      neighbours.get(t).add(s);
    }
  }
  let labels = new Map(nodes.map((n) => [n, n]));
  for (let pass = 0; pass < maxPasses; pass++) {
    const newLabels = new Map();
    for (const n of nodes) {
      const nbs = neighbours.get(n);
      if (nbs.size === 0) {
        newLabels.set(n, labels.get(n));
        continue;
      }
      const counts = new Map();
      for (const nb of nbs) {
        const lbl = labels.get(nb);
        counts.set(lbl, (counts.get(lbl) || 0) + 1);
      }
      const best = Math.max(...counts.values());
      let winner = null;
      for (const [lbl, c] of counts) {
        if (c === best && (winner === null || lbl < winner)) winner = lbl;
      }
      newLabels.set(n, winner);
    }
    let changed = false;
    for (const n of nodes) {
      if (newLabels.get(n) !== labels.get(n)) {
        changed = true;
        break;
      }
    }
    labels = newLabels;
    if (!changed) break;
  }
  return labels;
}

/** Undirected degree per node (used as the naming tiebreak). */
export function computeDegree(nodeIds, edges) {
  const degree = new Map([...nodeIds].map((n) => [n, 0]));
  for (const key of edges) {
    const [s, t] = edgePair(key);
    if (degree.has(s)) degree.set(s, degree.get(s) + 1);
    if (degree.has(t)) degree.set(t, degree.get(t) + 1);
  }
  return degree;
}

/**
 * Roll original edges up to inter-community edges: for every edge whose
 * endpoints fall in two different communities, count crossings by
 * (source_community, target_community) and dedupe into one entry per pair.
 * Same-community (internal) edges are dropped. Returns Map "cs-ct" -> count.
 */
export function aggregateEdges(edges, communityOf) {
  const counts = new Map();
  for (const key of edges) {
    const [s, t] = edgePair(key);
    const cs = communityOf.get(s), ct = communityOf.get(t);
    if (cs === undefined || ct === undefined || cs === ct) continue;
    const k = edgeKey(cs, ct);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

/**
 * Heuristic community name: the longest common leading token shared by every
 * member's label (split on whitespace), else the highest-degree member's
 * label. The member count is appended, e.g. "Auth (5)".
 */
export function clusterName(memberIds, nodeLabels, degree) {
  const tokenLists = memberIds.map((m) => String(nodeLabels.get(m) ?? m).split(/\s+/).filter((s) => s !== ""));
  const common = [];
  if (tokenLists.length && tokenLists.every((t) => t.length > 0)) {
    const minLen = Math.min(...tokenLists.map((t) => t.length));
    for (let i = 0; i < minLen; i++) {
      const tok = tokenLists[0][i];
      if (tokenLists.every((t) => t[i] === tok)) common.push(tok);
      else break;
    }
  }
  let base;
  if (common.length) {
    base = common.join(" ");
  } else {
    let top = null;
    for (const m of memberIds) {
      const key = [degree.get(m) ?? 0, m];
      if (top === null || key[0] > top[0] || (key[0] === top[0] && key[1] > top[1])) top = [key[0], key[1], m];
    }
    base = nodeLabels.get(top[2]) || top[2];
  }
  return `${base} (${memberIds.length})`;
}

/**
 * Lay out the executive nodes via autolayoutModel (elkjs); return the
 * rendered <diagram>...</diagram> page, renamed to a friendlier id/title.
 */
async function layoutExecPage(graph) {
  const cells = await autolayoutModel(graph, { color: true });
  const page = wrapPage(cells, { pageId: "exec-view", name: "Executive View" });
  return page;
}

/**
 * Copy the source's first page verbatim (cells untouched) into a new
 * <diagram> with id=page2Id, so exec-node drill-down links resolve to it.
 */
function copyOriginalPage(path, page2Id) {
  let root;
  try {
    root = parse(fs.readFileSync(path, "utf8"));
  } catch (exc) {
    die(`cannot parse ${path}: ${exc.message || exc}`);
  }
  const pages = root.children.filter((c) => c.tag === "diagram");
  const effectivePages = pages.length ? pages : [root];
  const page = JSON.parse(JSON.stringify(effectivePages[0]));
  const model = find(page, "mxGraphModel");
  if (!model || !find(model, "root")) {
    die(`${path}: page is compressed (no <root>), cannot copy verbatim`);
  }
  page.attrs.id = page2Id;
  page.attrs.name = "Full Diagram";
  return serialize(page) + "\n";
}

async function main() {
  const a = parseArgs(
    {
      name: "compress",
      usage: "Usage: compress.mjs <diagram.drawio> [-o out.drawio] [--clusters N]",
      flags: {
        output: { short: "-o", takesValue: true },
        clusters: { takesValue: true },
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("need exactly one <diagram.drawio>");

  if (a.clusters) {
    process.stderr.write(
      "note: --clusters is a soft hint; label propagation determines the actual cluster count automatically\n"
    );
  }

  const { nodes, edges } = parseDrawio(a._[0]);
  if (nodes.size === 0) die(`no leaf vertices found in ${a._[0]}`);

  const nodeIds = [...nodes.keys()];
  const communityOf = labelPropagation(nodeIds, edges);
  const communities = new Map(); // community -> [ids] in first-appearance order over sorted nid
  for (const nid of [...nodes.keys()].sort()) {
    const c = communityOf.get(nid);
    if (!communities.has(c)) communities.set(c, []);
    communities.get(c).push(nid);
  }

  const degree = computeDegree(nodeIds, edges);
  const nodeLabels = new Map([...nodes.entries()].map(([nid, [label]]) => [nid, label]));
  const names = new Map();
  for (const [c, members] of communities) names.set(c, clusterName(members, nodeLabels, degree));

  const crossings = aggregateEdges(edges, communityOf);

  const page2Id = "full-diagram";
  const execNodes = [...communities.keys()].map((c) => ({
    id: `c_${c}`,
    label: names.get(c),
    link: `data:page/id,${page2Id}`,
  }));
  const sortedCrossingKeys = [...crossings.keys()].sort();
  const execEdges = sortedCrossingKeys.map((k) => {
    const [s, t] = edgePair(k);
    const n = crossings.get(k);
    return { source: `c_${s}`, target: `c_${t}`, label: n > 1 ? String(n) : "" };
  });
  const execGraph = { direction: "TB", nodes: execNodes, edges: execEdges };

  const page1 = await layoutExecPage(execGraph);
  const page2 = copyOriginalPage(a._[0], page2Id);
  const xml = "<mxfile>\n" + page1 + page2 + "</mxfile>\n";

  if (a.output) {
    fs.writeFileSync(a.output, xml, "utf8");
    process.stderr.write(`wrote ${a.output} (${nodes.size} nodes -> ${communities.size} clusters)\n`);
  } else {
    process.stdout.write(xml);
    process.stderr.write(`${nodes.size} nodes -> ${communities.size} clusters\n`);
  }
}

import path from "node:path";
import { fileURLToPath } from "node:url";
function isMainModule() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}
if (isMainModule()) {
  await main();
}

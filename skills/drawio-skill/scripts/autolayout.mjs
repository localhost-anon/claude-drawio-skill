#!/usr/bin/env node
// Auto-layout a logical graph into draw.io XML.
//
// Node port of autolayout.py. The Python original shelled out to Graphviz
// `dot` for node placement; this port uses lib/layout.mjs (elkjs, layered)
// instead, so node coordinates differ from the Python output (byte-parity is
// not expected). Everything else — the graph JSON schema, group/cluster
// boxes, palette tinting, UserObject links, CLI flags — is preserved.
//
// Input JSON:
//   {
//     "direction": "TB",          # TB (top-bottom, default) or LR (left-right)
//     "nodes": [
//       {"id": "a", "label": "Service A", "style": "rounded=1;...",
//        "width": 120, "height": 60}
//     ],
//     "edges": [ {"source": "a", "target": "b", "label": "calls"} ]
//   }
//
// Exports autolayoutModel(graph, opts) so c4.mjs and compress.mjs can place
// nodes without spawning a subprocess.
//
// Usage: autolayout.mjs graph.json [-o diagram.drawio] [--mono] [--tune]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "./lib/args.mjs";
import { layout } from "./lib/layout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_W = 120;
const DEFAULT_H = 60;
const NODE_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;";
const EDGE_STYLE = "html=1;rounded=0;";
const GROUP_STYLE =
  "rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#999999;" +
  "verticalAlign=top;fontStyle=2;dashed=1;";

const _PALETTE_ORDER = ["primary", "success", "accent", "secondary", "warning", "danger", "neutral"];
const _PALETTE_FILE = path.join(HERE, "..", "styles", "built-in", "default.json");
const _FALLBACK_PALETTE = [
  ["#dae8fc", "#6c8ebf"], ["#d5e8d4", "#82b366"], ["#ffe6cc", "#d79b00"],
  ["#e1d5e7", "#9673a6"], ["#fff2cc", "#d6b656"], ["#f8cecc", "#b85450"],
];

function loadPalette() {
  try {
    const pal = JSON.parse(fs.readFileSync(_PALETTE_FILE, "utf8")).palette;
    const colors = [];
    for (const r of _PALETTE_ORDER) {
      if (pal && Object.prototype.hasOwnProperty.call(pal, r)) {
        colors.push([pal[r].fillColor, pal[r].strokeColor]);
      }
    }
    if (colors.length) return colors;
  } catch {
    /* fall through */
  }
  return _FALLBACK_PALETTE;
}

const PALETTE = loadPalette();
const GROUP_PAD = 24;

function attr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#xa;");
}

function snap(value, grid = 10) {
  return Math.round(value / grid) * grid;
}

// --- group tree -----------------------------------------------------------
const K = (arr) => arr.join("\0");

// Lexicographic tuple compare (Python tuple ordering: element-wise, shorter
// prefix first).
function cmpPath(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function groupTree(nodes) {
  const gpath = new Map(); // id -> path array
  const direct = new Map(); // K(path) -> [ids]
  const pathSet = new Map(); // K(path) -> path array (dedup)
  for (const node of nodes) {
    let g = node.group;
    if (g === undefined || g === null || String(g).replace(/^\/+|\/+$/g, "") === "") continue;
    const t = String(g).replace(/^\/+|\/+$/g, "").split("/");
    gpath.set(node.id, t);
    const dk = K(t);
    if (!direct.has(dk)) direct.set(dk, []);
    direct.get(dk).push(node.id);
    for (let k = 1; k <= t.length; k++) {
      const p = t.slice(0, k);
      pathSet.set(K(p), p);
    }
  }
  const allPaths = [...pathSet.values()];
  const sortedPaths = [...allPaths].sort(cmpPath);
  const children = new Map(); // K(parent) -> [child path]
  for (const p of sortedPaths) {
    if (p.length > 1) {
      const parent = p.slice(0, -1);
      const pk = K(parent);
      if (!children.has(pk)) children.set(pk, []);
      children.get(pk).push(p);
    }
  }
  // ordered: sorted by (len, path)
  const ordered = [...allPaths].sort((a, b) => a.length - b.length || cmpPath(a, b));
  return { gpath, direct, children, ordered };
}

function groupStyle(stroke) {
  return (
    `rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=${stroke};` +
    `fontColor=${stroke};verticalAlign=top;fontStyle=2;dashed=1;`
  );
}

// Render the <root> child cells for one laid-out graph, given absolute snapped
// rects {id -> [x, y, w, h]}. Mirrors autolayout.py page_cells(), minus dot
// edge-waypoint replay (elk edge routes are not exposed; draw.io routes edges).
function renderCells(graph, rects, color = true) {
  const nodes = graph.nodes;
  const { gpath, direct, children, ordered } = groupTree(nodes);

  // Top-level group colour order (first appearance).
  const topOrder = [];
  for (const node of nodes) {
    const t = gpath.get(node.id);
    if (t && !topOrder.includes(t[0])) topOrder.push(t[0]);
  }
  const gcolor = (seg) => PALETTE[topOrder.indexOf(seg) % PALETTE.length];

  const used = new Set(nodes.map((n) => n.id));
  const labelOverride = new Map();
  for (const node of nodes) {
    if (gpath.has(node.id) && Object.prototype.hasOwnProperty.call(node, "groupLabel")) {
      const k = K(gpath.get(node.id));
      if (!labelOverride.has(k)) labelOverride.set(k, String(node.groupLabel));
    }
  }
  const gid = new Map();
  const glabel = new Map();
  ordered.forEach((p, i) => {
    let cid = `group_${i}`;
    while (used.has(cid)) cid += "_";
    used.add(cid);
    gid.set(K(p), cid);
    const k = K(p);
    glabel.set(k, labelOverride.has(k) ? labelOverride.get(k) : p[p.length - 1]);
  });

  // Container boxes, deepest-first.
  const gbox = new Map();
  const byLenDesc = [...ordered].sort((a, b) => b.length - a.length);
  for (const p of byLenDesc) {
    const xs = [];
    for (const m of direct.get(K(p)) || []) {
      if (rects.has(m)) {
        const r = rects.get(m);
        xs.push([r[0], r[1], r[0] + r[2], r[1] + r[3]]);
      }
    }
    for (const c of children.get(K(p)) || []) {
      if (gbox.has(K(c))) {
        const b = gbox.get(K(c));
        xs.push([b[0], b[1], b[0] + b[2], b[1] + b[3]]);
      }
    }
    if (xs.length === 0) continue;
    const x0 = Math.min(...xs.map((b) => b[0])) - GROUP_PAD;
    const y0 = Math.min(...xs.map((b) => b[1])) - GROUP_PAD;
    const x1 = Math.max(...xs.map((b) => b[2])) + GROUP_PAD;
    const y1 = Math.max(...xs.map((b) => b[3])) + GROUP_PAD;
    gbox.set(K(p), [x0, y0, x1 - x0, y1 - y0]);
  }

  // Shift everything positive.
  const absx = [...rects.values()].map((r) => r[0]).concat([...gbox.values()].map((b) => b[0]));
  const absy = [...rects.values()].map((r) => r[1]).concat([...gbox.values()].map((b) => b[1]));
  const dx = absx.length && Math.min(...absx) < 0 ? GROUP_PAD - Math.min(...absx) : 0;
  const dy = absy.length && Math.min(...absy) < 0 ? GROUP_PAD - Math.min(...absy) : 0;

  function rebase(x, y, parentPath) {
    if (parentPath === null) return [x + dx, y + dy, "1"];
    const [px, py] = gbox.get(K(parentPath));
    return [x - px, y - py, gid.get(K(parentPath))];
  }

  const cells = [];
  // Containers shallow-first.
  for (const p of ordered) {
    if (!gbox.has(K(p))) continue;
    const [gx, gy, gw, gh] = gbox.get(K(p));
    const [x, y, parent] = rebase(gx, gy, p.length > 1 ? p.slice(0, -1) : null);
    const gstyle = color ? groupStyle(gcolor(p[0])[1]) : GROUP_STYLE;
    cells.push(
      `        <mxCell id="${attr(gid.get(K(p)))}" value="${attr(glabel.get(K(p)))}" ` +
        `style="${gstyle}" vertex="1" parent="${attr(parent)}">\n` +
        `          <mxGeometry x="${x}" y="${y}" width="${gw}" height="${gh}" as="geometry"/>\n` +
        `        </mxCell>`
    );
  }
  for (const node of nodes) {
    const nid = node.id;
    if (!rects.has(nid)) continue;
    const [rx, ry, w, h] = rects.get(nid);
    const gp = gpath.get(nid);
    const parentPath = gp && gbox.has(K(gp)) ? gp : null;
    const [x, y, parent] = rebase(rx, ry, parentPath);
    let style;
    if (node.style) {
      style = node.style;
    } else if (color && gpath.has(nid)) {
      const [fill, stroke] = gcolor(gpath.get(nid)[0]);
      style = `rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};`;
    } else {
      style = NODE_STYLE;
    }
    const body =
      `style="${attr(style)}" vertex="1" parent="${attr(parent)}">\n` +
      `          <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>\n` +
      `        </mxCell>`;
    if (node.link) {
      cells.push(
        `        <UserObject label="${attr(node.label ?? nid)}" ` +
          `link="${attr(node.link)}" id="${attr(nid)}">\n` +
          `          <mxCell ` + body + "\n        </UserObject>"
      );
    } else {
      cells.push(
        `        <mxCell id="${attr(nid)}" value="${attr(node.label ?? nid)}" ` + body
      );
    }
  }
  const edges = graph.edges || [];
  edges.forEach((edge, i) => {
    const geom = '<mxGeometry relative="1" as="geometry"/>';
    cells.push(
      `        <mxCell id="e${i}" value="${attr(edge.label ?? "")}" ` +
        `style="${attr(edge.style ?? EDGE_STYLE)}" edge="1" parent="1" ` +
        `source="${attr(edge.source)}" target="${attr(edge.target)}">\n` +
        `          ${geom}\n` +
        `        </mxCell>`
    );
  });
  return cells.join("\n");
}

// Compute absolute snapped rects for a graph using elk.
async function layoutRects(graph) {
  const nodes = graph.nodes.map((n) => ({
    id: n.id,
    width: n.width ?? DEFAULT_W,
    height: n.height ?? DEFAULT_H,
  }));
  const edges = (graph.edges || []).map((e) => ({ source: e.source, target: e.target }));
  const direction = String(graph.direction ?? "TB").toUpperCase() === "LR" ? "RIGHT" : "DOWN";
  const positions = await layout(nodes, edges, { direction });
  const posById = new Map(positions.map((p) => [p.id, p]));
  const rects = new Map();
  for (const node of graph.nodes) {
    const p = posById.get(node.id);
    if (!p) continue;
    const w = node.width ?? DEFAULT_W;
    const h = node.height ?? DEFAULT_H;
    rects.set(node.id, [snap(p.x), snap(p.y), w, h]);
  }
  return rects;
}

/**
 * Core reusable entry point: lay out a graph and return the <root> child
 * cells (the two reserved cells are added by wrapPage). Async because elk is.
 *
 * @param {{direction?: string, nodes: Array, edges?: Array}} graph
 * @param {{color?: boolean}} [opts]
 * @returns {Promise<string>} rendered mxCell block
 */
export async function autolayoutModel(graph, opts = {}) {
  const color = opts.color ?? true;
  const rects = await layoutRects(graph);
  return renderCells(graph, rects, color);
}

/** One <diagram> page around pre-rendered root cells. */
export function wrapPage(cells, { pageId = "autolayout", name = "Page-1" } = {}) {
  return (
    `  <diagram id="${attr(pageId)}" name="${attr(name)}">\n` +
    '    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" ' +
    'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ' +
    'pageWidth="850" pageHeight="1100" math="0" shadow="0">\n' +
    "      <root>\n" +
    '        <mxCell id="0"/>\n' +
    '        <mxCell id="1" parent="0"/>\n' +
    cells +
    "\n      </root>\n    </mxGraphModel>\n  </diagram>\n"
  );
}

function toDrawio(cells) {
  return "<mxfile>\n" + wrapPage(cells) + "</mxfile>\n";
}

// Simplified readability score for --tune: straight source-centre-to-target-
// centre segments; count edges routed through a non-endpoint node plus edge
// crossings (lower is better). This is a coarse approximation of the Python
// dot-based score (no orthogonal routing is available from elk).
function tuneScore(graph, rects) {
  const center = (id) => {
    const r = rects.get(id);
    return r ? [r[0] + r[2] / 2, r[1] + r[3] / 2] : null;
  };
  const routes = [];
  for (const e of graph.edges || []) {
    const a = center(e.source);
    const b = center(e.target);
    if (a && b) routes.push([a, b, new Set([e.source, e.target])]);
  }
  const segRect = (p, q, box) => {
    // crude: sample points along segment, count if any lands inside box
    const [x, y, w, h] = box;
    for (let s = 1; s < 8; s++) {
      const t = s / 8;
      const px = p[0] + (q[0] - p[0]) * t;
      const py = p[1] + (q[1] - p[1]) * t;
      if (px > x && px < x + w && py > y && py < y + h) return true;
    }
    return false;
  };
  const orient = (a, b, c) => {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1;
  };
  const cross = (p1, p2, p3, p4) => {
    const o = [orient(p1, p2, p3), orient(p1, p2, p4), orient(p3, p4, p1), orient(p3, p4, p2)];
    return o[0] !== o[1] && o[2] !== o[3] && !o.includes(0);
  };
  let through = 0;
  for (const [a, b, ends] of routes) {
    for (const [id, box] of rects) {
      if (!ends.has(id) && segRect(a, b, box)) through++;
    }
  }
  let crossings = 0;
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      if (cross(routes[i][0], routes[i][1], routes[j][0], routes[j][1])) crossings++;
    }
  }
  return 20 * through + 10 * crossings;
}

async function main() {
  const a = parseArgs(
    {
      name: "autolayout",
      usage: "Usage: autolayout.mjs <graph.json> [-o out.drawio] [--mono] [--tune]",
      flags: {
        output: { short: "-o", takesValue: true },
        mono: {},
        tune: {},
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("need exactly one <graph.json>");
  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(a._[0], "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") die(`[Errno 2] No such file or directory: '${a._[0]}'`);
    die(String(e.message || e));
  }
  const color = !a.mono;

  let cells;
  if (a.tune) {
    let best = null;
    for (const d of ["TB", "LR"]) {
      const cand = { ...graph, direction: d };
      const rects = await layoutRects(cand);
      const s = tuneScore(cand, rects);
      if (best === null || s < best.s) best = { s, d, cand, rects };
    }
    process.stderr.write(`tuned: direction=${best.d} (score ${best.s})\n`);
    cells = renderCells(best.cand, best.rects, color);
  } else {
    cells = await autolayoutModel(graph, { color });
  }

  const xml = toDrawio(cells);
  if (a.output) {
    fs.writeFileSync(a.output, xml, "utf8");
    process.stderr.write(
      `wrote ${a.output} (${graph.nodes.length} nodes, ${(graph.edges || []).length} edges)\n`
    );
  } else {
    process.stdout.write(xml);
  }
}

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

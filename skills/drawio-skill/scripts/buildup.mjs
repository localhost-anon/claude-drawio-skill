#!/usr/bin/env node
// Animate a static .drawio building itself, node by node -> HTML player.
//
// Node port of buildup.py. Reveals a diagram's cells incrementally in
// dependency order (topological over its edges, ties/cycle-remnants fall
// back to document order) and assembles a self-contained HTML player
// (base64-embedded PNG frames, play/pause/step/scrub) of the diagram
// constructing itself. Each frame is a temp copy of the diagram with
// not-yet-revealed cells removed from <root>. Needs the draw.io CLI on PATH
// to export PNG frames — GIF assembly is skipped (no Pillow-equivalent used;
// --gif is accepted but reported as unsupported since this is a zero-npm-dep
// port and there is no bundled GIF encoder).
//
// Usage: buildup.mjs <file.drawio> [-o out.html] [--gif out.gif]
//        [--fps N] [--hold N] [--keep-frames]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "./lib/args.mjs";
import { parse, find, findAll, serialize } from "./lib/xml.mjs";

/**
 * First page of a .drawio -> { root, cells }. cells: array of {id, node,
 * vertex, edge, parent, source, target, style, relative, x, y, w, h} in
 * document order. `node` is the TOP-LEVEL <root> child (mxCell / UserObject /
 * object) so it can be removed directly; vertex/edge/geometry attributes are
 * read off the inner mxCell for wrapped cells, same unwrapping used
 * throughout this skill (see SHARED CONVENTIONS).
 */
function parsePage(file) {
  let doc;
  try {
    doc = parse(fs.readFileSync(file, "utf8"));
  } catch (exc) {
    die(`cannot parse ${file}: ${exc.message || exc}`);
  }
  const pages = doc.children.filter((c) => c.tag === "diagram");
  if (!pages.length) die(`no <diagram> pages in ${file}`);
  if (pages.length > 1) {
    process.stderr.write(`warning: ${file} has ${pages.length} pages, animating the first only\n`);
  }
  const page = pages[0];
  const model = find(page, "mxGraphModel");
  const r = model ? find(model, "root") : null;
  if (!r) die(`${file}: page is compressed, cannot buildup`);

  const cells = [];
  for (const el of r.children) {
    const inner = el.tag === "mxCell" ? el : find(el, "mxCell");
    if (!inner) continue;
    const g = find(inner, "mxGeometry");
    const relative = !!g && g.attrs.relative === "1";
    let x = null, y = null, w = null, h = null;
    if (g && !relative && g.attrs.x !== undefined && g.attrs.width !== undefined) {
      x = parseFloat(g.attrs.x);
      y = parseFloat(g.attrs.y ?? "0");
      w = parseFloat(g.attrs.width);
      h = parseFloat(g.attrs.height ?? "0");
    }
    cells.push({
      id: el.attrs.id,
      node: el,
      vertex: inner.attrs.vertex === "1",
      edge: inner.attrs.edge === "1",
      parent: inner.attrs.parent,
      source: inner.attrs.source,
      target: inner.attrs.target,
      style: inner.attrs.style || "",
      relative,
      x, y, w, h,
    });
  }
  return { doc, page, cells };
}

/**
 * cells -> { leaves: leaf-vertex ids in doc order, containers: Set of ids,
 * edges: [[id,source,target]] }. Mirrors buildup.py's classify(): a vertex
 * that is some other cell's parent is a container/group (always shown, never
 * an individual reveal step); an edge-label sub-cell (relative geometry or
 * an `edgeLabel` style) is neither a node nor revealed on its own.
 */
function classify(cells) {
  const parents = new Set(cells.filter((c) => c.parent).map((c) => c.parent));
  const leaves = [];
  const containers = new Set();
  const edges = [];
  for (const c of cells) {
    if (c.edge) {
      if (c.source && c.target) edges.push([c.id, c.source, c.target]);
    } else if (c.vertex) {
      if (c.relative || c.style.includes("edgeLabel")) continue;
      if (parents.has(c.id)) containers.add(c.id);
      else leaves.push(c.id);
    }
  }
  return { leaves, containers, edges };
}

/** [width, height] of the full diagram from every absolute cell geometry, with a margin. */
function boundingBox(cells, margin = 40) {
  const xs = cells.filter((c) => c.x !== null).map((c) => c.x + c.w);
  const ys = cells.filter((c) => c.y !== null).map((c) => c.y + c.h);
  if (!xs.length || !ys.length) return [850, 1100];
  return [Math.trunc(Math.max(...xs)) + margin, Math.trunc(Math.max(...ys)) + margin];
}

/**
 * Kahn topological order over nodeIds given directed [source,target] edges.
 * Ties among ready nodes, and any nodes left over from a cycle, fall back to
 * document order (nodeIds' input order). Uses a min-heap over doc-order index
 * for the ready set, matching Python's heapq-over-index approach.
 */
function revealOrder(nodeIds, edges) {
  const doc = [...new Set(nodeIds)]; // de-dup, keep doc order
  const idx = new Map(doc.map((n, i) => [n, i]));
  const adj = new Map(doc.map((n) => [n, []]));
  const indeg = new Map(doc.map((n) => [n, 0]));
  for (const [s, t] of edges) {
    if (idx.has(s) && idx.has(t) && s !== t) {
      adj.get(s).push(t);
      indeg.set(t, indeg.get(t) + 1);
    }
  }

  // Min-heap of doc-order indices, implemented as a simple sorted array push
  // (small N in practice; heapq semantics reduced to "always take smallest").
  const ready = new Set();
  for (const n of doc) if (indeg.get(n) === 0) ready.add(idx.get(n));

  const order = [];
  const seen = new Set();
  while (ready.size) {
    const min = Math.min(...ready);
    ready.delete(min);
    const nid = doc[min];
    seen.add(nid);
    order.push(nid);
    for (const nxt of adj.get(nid)) {
      indeg.set(nxt, indeg.get(nxt) - 1);
      if (indeg.get(nxt) === 0) ready.add(idx.get(nxt));
    }
  }
  for (const nid of doc) {
    if (!seen.has(nid)) order.push(nid); // cycle remnants, document order
  }
  return order;
}

/**
 * -> { nodeStep: Map(id -> int), edgeStep: Map(edgeId -> int) }. An edge's
 * step is the LATER of its two endpoints' steps, so it only appears once
 * both are revealed (endpoints outside nodeOrder, e.g. a container, count as
 * step 0 — already shown).
 */
function revealSteps(nodeOrder, edges) {
  const nodeStep = new Map(nodeOrder.map((nid, i) => [nid, i]));
  const edgeStep = new Map();
  for (const [eid, s, t] of edges) {
    edgeStep.set(eid, Math.max(nodeStep.get(s) ?? 0, nodeStep.get(t) ?? 0));
  }
  return { nodeStep, edgeStep };
}

/** Visible text of a root child (mxCell or UserObject/object wrapper). */
function labelOf(el) {
  if (el.tag === "mxCell") return el.attrs.value || el.attrs.id || "";
  return el.attrs.label || el.attrs.value || el.attrs.id || "";
}

/** Self-contained HTML player. frames: [[pngBytes, label, step, total]]. */
function buildHtml(frames, title) {
  const data = frames.map(([png, label, step, total]) => ({
    img: "data:image/png;base64," + Buffer.from(png).toString("base64"),
    label,
    step,
    total,
  }));
  const payload = JSON.stringify(data).replace(/<\//g, "<\\/");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
background:#f6f7f9;color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#15171a;color:#e8e8e8}}
header{padding:16px 20px 4px}h1{margin:0;font-size:17px;font-weight:600}
main{max-width:1100px;margin:0 auto;padding:8px 16px 28px}
#stage{background:#fff;border:1px solid #0001;border-radius:10px;
min-height:60vh;display:flex;align-items:center;justify-content:center;padding:12px}
@media(prefers-color-scheme:dark){#stage{background:#1e2226;border-color:#fff2}}
#stage img{max-width:100%;max-height:74vh;object-fit:contain}
.cap{display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;
padding:12px 4px 6px;color:#556;font-size:13px}
@media(prefers-color-scheme:dark){.cap{color:#9aa}}
.cap .lbl{color:#1a1a1a;font-weight:600}
@media(prefers-color-scheme:dark){.cap .lbl{color:#e8e8e8}}
.bar{height:6px;border-radius:3px;background:#0d99ff;transition:width .3s}
.barwrap{height:6px;background:#0001;border-radius:3px;margin:2px 4px 12px}
.ctl{display:flex;gap:10px;align-items:center;padding:4px}
button{font:inherit;padding:6px 12px;border:1px solid #0002;border-radius:8px;
background:#fff;cursor:pointer;color:inherit}
@media(prefers-color-scheme:dark){button{background:#262b31;border-color:#fff2}}
button:hover{border-color:#0d99ff}
input[type=range]{flex:1;accent-color:#0d99ff}
</style></head><body>
<header><h1>${title}</h1></header>
<main>
<div id="stage"><img id="img" alt="build-up frame"></div>
<div class="cap">
  <span><b id="idx"></b></span>
  <span>+ <span class="lbl" id="label"></span></span>
</div>
<div class="barwrap"><div class="bar" id="bar"></div></div>
<div class="ctl">
  <button id="prev">‹ Prev</button>
  <button id="play">▶ Play</button>
  <button id="next">Next ›</button>
  <input type="range" id="scrub" min="0" value="0">
</div>
</main>
<script>
const F=${payload};
let i=0,timer=null;
const $=id=>document.getElementById(id);
$("scrub").max=F.length-1;
function show(k){
  i=(k+F.length)%F.length;const f=F[i];
  $("img").src=f.img;$("idx").textContent=\`Step \${f.step} / \${f.total}\`;
  $("label").textContent=f.label;
  $("bar").style.width=(6+94*f.step/f.total)+"%";$("scrub").value=i;
}
function stop(){clearInterval(timer);timer=null;$("play").textContent="▶ Play";}
$("prev").onclick=()=>{stop();show(i-1);};
$("next").onclick=()=>{stop();show(i+1);};
$("scrub").oninput=e=>{stop();show(+e.target.value);};
$("play").onclick=()=>{
  if(timer){stop();return;}
  $("play").textContent="⏸ Pause";
  timer=setInterval(()=>{if(i>=F.length-1){show(0);}else{show(i+1);}},700);
};
show(0);
</script></body></html>`;
}

async function main() {
  const a = parseArgs(
    {
      name: "buildup",
      usage: "Usage: buildup.mjs <file.drawio> [-o out.html] [--gif out.gif] [--fps N] [--hold N] [--keep-frames]",
      flags: {
        output: { short: "-o", takesValue: true },
        gif: { takesValue: true },
        fps: { takesValue: true, default: "2" },
        hold: { takesValue: true, default: "1.5" },
        "keep-frames": { takesValue: false },
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("need exactly one <file.drawio>");
  const file = a._[0];

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die(`${file} not found`);
  let drawioOk = true;
  try {
    execFileSync("drawio", ["--version"], { stdio: "ignore" });
  } catch {
    drawioOk = false;
  }
  if (!drawioOk) die("draw.io CLI not found on PATH (is the draw.io CLI installed?)");

  const { doc, cells } = parsePage(file);
  const { leaves, containers, edges: edgeList } = classify(cells);
  if (!leaves.length) die(`no revealable vertices found in ${file}`);

  const order = revealOrder(leaves, edgeList.map(([, s, t]) => [s, t]));
  const { nodeStep, edgeStep } = revealSteps(order, edgeList);
  const [width, height] = boundingBox(cells);
  const labels = new Map(cells.map((c) => [c.id, labelOf(c.node)]));
  const nTotal = order.length;

  const out = a.output || path.join(path.dirname(path.resolve(file)) || ".", "buildup.html");

  const frames = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "buildup-"));
  try {
    for (let k = 0; k < nTotal; k++) {
      const revealedNodes = new Set(order.slice(0, k + 1));
      const revealedEdges = new Set(edgeList.filter(([eid]) => edgeStep.get(eid) <= k).map(([eid]) => eid));
      const keep = new Set(["0", "1", ...containers, ...revealedNodes, ...revealedEdges]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const c of cells) {
          if (!keep.has(c.id) && keep.has(c.parent)) {
            keep.add(c.id);
            changed = true;
          }
        }
      }

      const frameDoc = JSON.parse(JSON.stringify(doc));
      const framePage = frameDoc.children.find((c) => c.tag === "diagram");
      const model = find(framePage, "mxGraphModel");
      model.attrs.pageWidth = String(width);
      model.attrs.pageHeight = String(height);
      const froot = find(model, "root");
      froot.children = froot.children.filter((child) => keep.has(child.attrs.id));

      const src = path.join(tmp, `step${String(k).padStart(3, "0")}.drawio`);
      fs.writeFileSync(src, serialize(frameDoc), "utf8");
      const pngPath = path.join(tmp, `step${String(k).padStart(3, "0")}.png`);
      let ok = true;
      try {
        execFileSync(
          "drawio",
          ["-x", "-f", "png", "--page-index", "1", "--width", "2000", "-o", pngPath, src],
          { stdio: "pipe" }
        );
      } catch {
        ok = false;
      }
      if (!ok || !fs.existsSync(pngPath)) {
        process.stderr.write(`warning: step ${k + 1}/${nTotal} export failed — skipped\n`);
        continue;
      }
      const png = fs.readFileSync(pngPath);
      const label = labels.get(order[k]) || order[k];
      frames.push([png, label, k + 1, nTotal]);
      if (a["keep-frames"]) {
        const base = out.replace(/\.[^./]+$/, "");
        fs.writeFileSync(`${base}-frame${String(k + 1).padStart(3, "0")}.png`, png);
      }
      process.stderr.write(`[${k + 1}/${nTotal}] revealed ${JSON.stringify(label)}\n`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (!frames.length) die("no frames exported (is the draw.io CLI installed?)");

  const title = path.basename(file).replace(/\.[^./]+$/, "") + " — build-up";
  fs.writeFileSync(out, buildHtml(frames, title), "utf8");
  process.stderr.write(`wrote ${out} (${frames.length} frames)\n`);

  if (a.gif) {
    process.stderr.write("warning: --gif is not supported by the Node port (no bundled GIF encoder, zero new deps); skipping\n");
  }
}

export { parsePage, classify, boundingBox, revealOrder, revealSteps, labelOf, buildHtml };

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

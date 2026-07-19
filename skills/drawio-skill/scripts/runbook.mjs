#!/usr/bin/env node
// Turn a flowchart / decision-tree .drawio into a click-through HTML runbook.
//
// Node port of runbook.py. Parses the nodes and edges out of a .drawio and
// infers a node "type" from its shape style (ellipse -> start/end, rhombus
// -> decision, parallelogram -> io, else process). The ellipse with no
// incoming edges is taken as the start node. The output is a single
// self-contained HTML page: the current node's text front and center, one
// button per outgoing edge (labeled with the edge's choice text, or
// "Continue" when a node has a single unlabeled successor), a breadcrumb
// trail of visited nodes, Back/Restart controls, and an "end" state on
// terminal nodes (no outgoing edges). No draw.io CLI is needed -- the XML is
// read and the HTML is built directly, so the whole script is testable
// without any external tool.
//
// Usage: runbook.mjs <file.drawio> [-o out.html]
import fs from "node:fs";
import path from "node:path";
import { parseArgs, die } from "./lib/args.mjs";
import { parse as parseXml, find } from "./lib/xml.mjs";

/**
 * Return { nodes, edges, startId }.
 *
 * nodes: {id: {label, type: "start"|"end"|"decision"|"io"|"process"}}
 * edges: [{source, target, label}, ...] in document order.
 * Cells are flattened across pages; UserObject/object wrappers are unwrapped
 * (id on the wrapper, cell inside) -- mirrors drawiodiff.mjs parse().
 */
export function parse(file) {
  let root;
  try {
    root = parseXml(fs.readFileSync(file, "utf8"));
  } catch (exc) {
    die(`cannot parse ${file}: ${exc.message || exc}`);
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
        process.stderr.write(`warning: ${file}: a page is compressed, skipped\n`);
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
  const order = [];
  const styles = new Map();
  let edges = [];
  for (const c of cells) {
    const cid = c.attrs.id;
    if (c.attrs.edge === "1") {
      const s = c.attrs.source, t = c.attrs.target;
      if (s && t) edges.push({ source: s, target: t, label: labels.get(cid) || "" });
    } else if (c.attrs.vertex === "1" && !parents.has(cid)) {
      const style = c.attrs.style || "";
      if (style.includes("edgeLabel")) continue;
      const g = find(c, "mxGeometry");
      if (g && g.attrs.relative === "1") continue; // edge-label child
      order.push(cid);
      styles.set(cid, style);
    }
  }

  const indeg = new Map(order.map((i) => [i, 0]));
  const outdeg = new Map(order.map((i) => [i, 0]));
  for (const e of edges) {
    if (outdeg.has(e.source)) outdeg.set(e.source, outdeg.get(e.source) + 1);
    if (indeg.has(e.target)) indeg.set(e.target, indeg.get(e.target) + 1);
  }

  const nodes = {};
  for (const nid of order) {
    const style = styles.get(nid);
    let ntype;
    if (style.includes("ellipse")) {
      ntype = outdeg.get(nid) === 0 && indeg.get(nid) > 0 ? "end" : "start";
    } else if (style.includes("rhombus")) {
      ntype = "decision";
    } else if (style.includes("parallelogram")) {
      ntype = "io";
    } else {
      ntype = "process";
    }
    nodes[nid] = { label: labels.get(nid) || "", type: ntype };
  }

  edges = edges.filter((e) => e.source in nodes && e.target in nodes);

  // Start node: the ellipse with no incoming edges; else the unique in-degree-0
  // node; else the first node in document order. Warn to stderr if ambiguous.
  const ellipseZeroIn = order.filter((nid) => styles.get(nid).includes("ellipse") && indeg.get(nid) === 0);
  let startId;
  if (ellipseZeroIn.length === 1) {
    startId = ellipseZeroIn[0];
  } else if (ellipseZeroIn.length > 1) {
    process.stderr.write("warning: multiple ellipse nodes with in-degree 0; picking the first\n");
    startId = ellipseZeroIn[0];
  } else {
    const zeroIn = order.filter((nid) => indeg.get(nid) === 0);
    if (zeroIn.length === 1) {
      startId = zeroIn[0];
    } else if (zeroIn.length > 1) {
      process.stderr.write("warning: no unique in-degree-0 node; picking the first\n");
      startId = zeroIn[0];
    } else if (order.length) {
      process.stderr.write("warning: no start node found by heuristics; using the first node\n");
      startId = order[0];
    } else {
      startId = null;
    }
  }
  return { nodes, edges, startId };
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * One self-contained click-through page. nodes: {id:{label,type}}; edges:
 * [{source,target,label}, ...]; startId: node id to begin the walk at.
 */
export function buildHtml(title, nodes, edges, startId) {
  const adjacency = {};
  for (const e of edges) {
    if (!adjacency[e.source]) adjacency[e.source] = [];
    adjacency[e.source].push({ target: e.target, label: e.label });
  }
  const payload = JSON.stringify({ nodes, edges: adjacency, start: startId }).replace(/<\//g, "<\\/");
  const t = escHtml(title);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
background:#f6f7f9;color:#1a1a1a;min-height:100vh;display:flex;flex-direction:column;align-items:center}
@media(prefers-color-scheme:dark){body{background:#15171a;color:#e8e8e8}}
header{width:100%;max-width:640px;padding:16px 20px 4px}
h1{margin:0;font-size:16px;font-weight:600}
#crumbs{width:100%;max-width:640px;padding:6px 20px;display:flex;flex-wrap:wrap;gap:4px;
font-size:12px;color:#667}
@media(prefers-color-scheme:dark){#crumbs{color:#9aa}}
#crumbs span:not(:last-child)::after{content:" \\2192 ";margin:0 2px}
main{width:100%;max-width:640px;padding:12px 20px 28px;flex:1}
#card{background:#fff;border:1px solid #0002;border-left:4px solid #0d99ff;border-radius:12px;
padding:24px;box-shadow:0 1px 3px #0001}
@media(prefers-color-scheme:dark){#card{background:#1e2226;border-color:#fff2;border-left-color:#0d99ff}}
#card.decision{border-left-color:#d79b00}
#card.end{border-left-color:#82b366}
#card.io{border-left-color:#9673a6}
#type{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#889;margin:0 0 8px}
#label{font-size:19px;font-weight:600;white-space:pre-wrap;margin:0 0 20px}
.choices{display:flex;flex-direction:column;gap:8px}
.choices button{font:inherit;text-align:left;padding:10px 14px;border:1px solid #0002;
border-radius:8px;background:#fff;cursor:pointer;color:inherit}
@media(prefers-color-scheme:dark){.choices button{background:#262b31;border-color:#fff2}}
.choices button:hover{border-color:#0d99ff;color:#0d99ff}
.ctl{display:flex;gap:10px;margin-top:20px}
.ctl button{font:inherit;padding:6px 14px;border:1px solid #0002;border-radius:8px;
background:#fff;cursor:pointer;color:inherit}
@media(prefers-color-scheme:dark){.ctl button{background:#262b31;border-color:#fff2}}
.ctl button:hover{border-color:#0d99ff}
.ctl button:disabled{opacity:.4;cursor:default}
#endmsg{display:none;color:#82b366;font-weight:600;margin:0}
</style></head><body>
<header><h1>${t}</h1></header>
<div id="crumbs"></div>
<main>
<div id="card">
<p id="type"></p>
<p id="label"></p>
<div class="choices" id="choices"></div>
<p id="endmsg">End of path -- nothing more to check.</p>
</div>
<div class="ctl">
  <button id="back">&larr; Back</button>
  <button id="restart">&#8635; Restart</button>
</div>
</main>
<script>
const DATA=${payload};
let path=[DATA.start];
const $=id=>document.getElementById(id);
function render(){
  const cur=path[path.length-1];
  const node=DATA.nodes[cur]||{label:String(cur),type:"process"};
  $("card").className=node.type;
  $("type").textContent=node.type;
  $("label").textContent=node.label;
  const choices=DATA.edges[cur]||[];
  const box=$("choices");box.innerHTML="";
  $("endmsg").style.display=choices.length?"none":"block";
  choices.forEach(c=>{
    const b=document.createElement("button");
    const target=DATA.nodes[c.target]||{};
    b.textContent=c.label||(choices.length===1?"Continue":(target.label||c.target));
    b.onclick=()=>{path.push(c.target);render();};
    box.appendChild(b);
  });
  $("back").disabled=path.length<2;
  const crumbs=$("crumbs");crumbs.innerHTML="";
  path.forEach((id,i)=>{
    const s=document.createElement("span");
    s.textContent=(DATA.nodes[id]||{}).label||id;
    if(i<path.length-1){
      s.style.cursor="pointer";
      s.onclick=()=>{path=path.slice(0,i+1);render();};
    }
    crumbs.appendChild(s);
  });
}
$("back").onclick=()=>{if(path.length>1){path.pop();render();}};
$("restart").onclick=()=>{path=[DATA.start];render();};
render();
</script></body></html>
`;
}

async function main() {
  const a = parseArgs(
    {
      name: "runbook",
      usage: "Usage: runbook.mjs <file.drawio> [-o out.html]",
      flags: {
        output: { short: "-o", takesValue: true },
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("need exactly one <file.drawio>");
  const file = a._[0];

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die(`${file} not found`);
  const { nodes, edges, startId } = parse(file);
  if (!Object.keys(nodes).length) die(`no nodes found in ${file}`);
  if (startId === null || startId === undefined) die(`no start node found in ${file}`);

  const title = path.basename(file).replace(/\.[^./]+$/, "");
  const out = a.output || file.replace(/\.[^./]+$/, "") + ".html";
  fs.writeFileSync(out, buildHtml(title, nodes, edges, startId), "utf8");
  process.stderr.write(`wrote ${out} (${Object.keys(nodes).length} nodes, ${edges.length} edges)\n`);
}

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

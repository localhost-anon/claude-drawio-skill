#!/usr/bin/env node
// Publish a .drawio as a single interactive HTML viewer.
//
// Exports every page to SVG via the draw.io CLI and inlines them into ONE
// self-contained .html with pan (drag), zoom (wheel / buttons), page tabs,
// node search, and working links — external links open normally and internal
// page links ("data:page/id,…", e.g. a C4 model's drill-down) switch tabs
// inside the viewer. Share the file with anyone: no draw.io, no server,
// no external requests.
//
//   drawiohtml.mjs architecture.drawio -o architecture.html
//   drawiohtml.mjs c4.drawio                # -> c4.html, drill-down works
//
// Search matches node text (draw.io wraps every cell in <g data-cell-id>);
// matches glow, Enter cycles through them and centres each. Internal page
// links survive export by being rewritten to "#page-<id>" fragments first
// (draw.io drops raw data:page/id links from SVG).
//
// Usage: drawiohtml.mjs <file.drawio> [-o out.html]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs, die } from "./lib/args.mjs";
import { parse, serialize } from "./lib/xml.mjs";

const PAGE_LINK = "data:page/id,";

function escapeHtml(s, quote = false) {
  let out = String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (quote) out = out.replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  return out;
}

// [(id, name)] of the <diagram> pages, in order.
function pagesOf(filePath) {
  let root;
  try {
    root = parse(fs.readFileSync(filePath, "utf8"));
  } catch (exc) {
    const msg =
      exc && exc.code === "ENOENT"
        ? `[Errno 2] No such file or directory: '${filePath}'`
        : String(exc.message || exc);
    die(`cannot parse ${filePath}: ${msg}`);
  }
  const diagrams = root.children.filter((c) => c.tag === "diagram");
  return diagrams.map((d, i) => [d.attrs.id || `p${i}`, d.attrs.name || `Page ${i + 1}`]);
}

// data:page/id,X links -> #page-X (fragments survive SVG export). Returns count.
function rewritePageLinks(root) {
  let n = 0;
  function walk(el) {
    const link = el.attrs.link;
    if (link && link.startsWith(PAGE_LINK)) {
      el.attrs.link = "#page-" + link.slice(PAGE_LINK.length);
      n++;
    }
    for (const c of el.children) walk(c);
  }
  walk(root);
  return n;
}

// Export one page (1-based index) to SVG via the draw.io CLI.
function exportSvg(drawioFile, index, outSvg) {
  let ok = true;
  try {
    execFileSync("drawio", ["-x", "-f", "svg", "--page-index", String(index), "-o", outSvg, drawioFile], {
      stdio: "pipe",
    });
  } catch {
    ok = false;
  }
  return ok && fs.existsSync(outSvg);
}

// Drop any XML declaration / doctype so the SVG can be inlined in HTML.
function stripProlog(svg) {
  return svg.replace(/^\s*(?:<\?xml[^>]*\?>\s*|<!DOCTYPE[^>]*>\s*)*/, "");
}

// One self-contained viewer page. pageMeta = [[id, name], ...] aligned with svgs.
function buildHtml(title, pageMeta, svgs) {
  const sections = pageMeta
    .map(([pid], i) => `<div class="page" data-pgid="${escapeHtml(pid, true)}">${svgs[i]}</div>`)
    .join("\n");
  const tabs = JSON.stringify(pageMeta.map(([id, name]) => ({ id, name }))).replace(/<\//g, "<\\/");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
background:#f6f7f9;color:#1a1a1a;height:100vh;display:flex;flex-direction:column}
@media(prefers-color-scheme:dark){body{background:#15171a;color:#e8e8e8}}
header{padding:10px 16px 8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{margin:0;font-size:15px;font-weight:600}
nav{display:flex;gap:6px;flex-wrap:wrap}
button,input{font:inherit;color:inherit}
nav button,.ctl button{padding:4px 10px;border:1px solid #0002;border-radius:8px;
background:#fff;cursor:pointer}
@media(prefers-color-scheme:dark){nav button,.ctl button{background:#262b31;border-color:#fff2}}
nav button.on{border-color:#0d99ff;color:#0d99ff;font-weight:600}
.ctl{display:flex;gap:8px;align-items:center;margin-left:auto}
.ctl input{padding:4px 10px;border:1px solid #0002;border-radius:8px;background:#fff;width:180px}
@media(prefers-color-scheme:dark){.ctl input{background:#262b31;border-color:#fff2}}
#hits{font-size:12px;color:#889;min-width:56px}
#stage{flex:1;overflow:hidden;position:relative;background:#fff;
border-top:1px solid #0001;cursor:grab;touch-action:none}
@media(prefers-color-scheme:dark){#stage{background:#1e2226;border-color:#fff2}}
#stage.drag{cursor:grabbing}
.page{position:absolute;transform-origin:0 0;display:none}
.page.on{display:block}
.page svg{display:block}
.hit{filter:drop-shadow(0 0 3px #ff9800) drop-shadow(0 0 6px #ff980088)}
.hit.cursel{filter:drop-shadow(0 0 4px #f44336) drop-shadow(0 0 9px #f44336aa)}
</style></head><body>
<header><h1>${escapeHtml(title)}</h1><nav id="tabs"></nav>
<div class="ctl">
 <input id="q" type="search" placeholder="Search nodes… Enter = next">
 <span id="hits"></span>
 <button id="zout" title="zoom out">−</button><button id="zin" title="zoom in">+</button>
 <button id="fit">Fit</button>
</div></header>
<main id="stage">
${sections}
</main>
<script>
const META=${tabs};
const stage=document.getElementById('stage');
const pages=[...document.querySelectorAll('.page')];
const view=pages.map(()=>({x:0,y:0,s:1}));
let cur=0,hits=[],hi=-1;
const tabs=document.getElementById('tabs');
if(META.length>1)META.forEach((m,i)=>{
  const b=document.createElement('button');b.textContent=m.name;
  b.onclick=()=>show(i);tabs.appendChild(b);});
function apply(){const v=view[cur];
  pages[cur].style.transform=\`translate(\${v.x}px,\${v.y}px) scale(\${v.s})\`;}
function svgSize(i){const s=pages[i].querySelector('svg');
  return[parseFloat(s.getAttribute('width'))||800,
         parseFloat(s.getAttribute('height'))||600];}
function fit(){const[w,h]=svgSize(cur),r=stage.getBoundingClientRect(),
  s=Math.min((r.width-40)/w,(r.height-40)/h,4);
  view[cur]={s,x:(r.width-w*s)/2,y:(r.height-h*s)/2};apply();}
function show(i){cur=i;
  pages.forEach((p,j)=>p.classList.toggle('on',j===i));
  [...tabs.children].forEach((b,j)=>b.classList.toggle('on',j===i));
  if(!pages[i].dataset.seen){pages[i].dataset.seen=1;fit();}else apply();
  search();}
stage.addEventListener('wheel',e=>{e.preventDefault();const v=view[cur],
  r=stage.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,
  k=Math.exp(-e.deltaY*0.0015),s=Math.min(Math.max(v.s*k,0.05),8);
  v.x=mx-(mx-v.x)*s/v.s;v.y=my-(my-v.y)*s/v.s;v.s=s;apply();},{passive:false});
let drag=null;
stage.addEventListener('pointerdown',e=>{if(e.target.closest('a'))return;
  drag={x:e.clientX,y:e.clientY};stage.classList.add('drag');
  stage.setPointerCapture(e.pointerId);});
stage.addEventListener('pointermove',e=>{if(!drag)return;const v=view[cur];
  v.x+=e.clientX-drag.x;v.y+=e.clientY-drag.y;
  drag={x:e.clientX,y:e.clientY};apply();});
stage.addEventListener('pointerup',()=>{drag=null;stage.classList.remove('drag');});
function zoom(k){const v=view[cur],r=stage.getBoundingClientRect(),
  mx=r.width/2,my=r.height/2,s=Math.min(Math.max(v.s*k,0.05),8);
  v.x=mx-(mx-v.x)*s/v.s;v.y=my-(my-v.y)*s/v.s;v.s=s;apply();}
document.getElementById('zin').onclick=()=>zoom(1.25);
document.getElementById('zout').onclick=()=>zoom(0.8);
document.getElementById('fit').onclick=fit;
// Internal page links: any anchor whose target ends in #page-<id> switches tabs.
document.addEventListener('click',e=>{const a=e.target.closest('a');
  if(!a)return;const href=a.getAttribute('xlink:href')||a.getAttribute('href')||'';
  const m=href.match(/#page-(.+)$/);if(!m)return;e.preventDefault();
  const i=META.findIndex(p=>p.id===decodeURIComponent(m[1]));if(i>=0)show(i);},true);
const q=document.getElementById('q'),hitEl=document.getElementById('hits');
function search(){
  hits.forEach(g=>g.classList.remove('hit','cursel'));hits=[];hi=-1;
  const t=q.value.trim().toLowerCase();
  if(t){
    const all=[...pages[cur].querySelectorAll('g[data-cell-id]')]
      .filter(g=>!['0','1'].includes(g.dataset.cellId))
      .filter(g=>g.textContent.toLowerCase().includes(t));
    hits=all.filter(g=>!all.some(o=>o!==g&&g.contains(o)));   // innermost only
    hits.forEach(g=>g.classList.add('hit'));
  }
  hitEl.textContent=t?hits.length+' hit'+(hits.length===1?'':'s'):'';}
function centre(g){const v=view[cur],r=stage.getBoundingClientRect(),
  b=g.getBoundingClientRect();
  v.x+=r.left+r.width/2-(b.left+b.width/2);
  v.y+=r.top+r.height/2-(b.top+b.height/2);apply();}
q.addEventListener('input',search);
q.addEventListener('keydown',e=>{
  if(e.key==='Escape'){q.value='';search();q.blur();}
  if(e.key!=='Enter'||!hits.length)return;
  if(hi>=0)hits[hi].classList.remove('cursel');
  hi=(hi+1)%hits.length;hits[hi].classList.add('cursel');centre(hits[hi]);});
show(0);
</script></body></html>
`;
}

const a = parseArgs(
  {
    name: "drawiohtml",
    usage: "Usage: drawiohtml.mjs <file.drawio> [-o out.html]",
    flags: {
      output: { short: "-o", takesValue: true },
    },
  },
  process.argv.slice(2)
);

if (a._.length !== 1) die("need exactly one <file.drawio>");
const file = a._[0];

if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die(`${file} not found`);
const meta = pagesOf(file);
if (!meta.length) die(`no <diagram> pages in ${file}`);

const root = parse(fs.readFileSync(file, "utf8"));
const relinked = rewritePageLinks(root);

const svgs = [];
const kept = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drawiohtml-"));
try {
  let src = file;
  if (relinked) {
    // export the rewritten copy instead
    src = path.join(tmp, "relinked.drawio");
    fs.writeFileSync(src, serialize(root), "utf8");
  }
  meta.forEach(([pid, name], idx) => {
    const i = idx + 1; // draw.io --page-index is 1-based
    const out = path.join(tmp, `p${i}.svg`);
    if (!exportSvg(src, i, out)) {
      process.stderr.write(`warning: page ${i} (${name}) export failed — skipped\n`);
      return;
    }
    svgs.push(stripProlog(fs.readFileSync(out, "utf8")));
    kept.push([pid, name]);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (!svgs.length) die("no pages exported (is the draw.io CLI installed?)");
const base = path.basename(file);
const dot = base.lastIndexOf(".");
const title = dot > 0 ? base.slice(0, dot) : base;
const out = a.output || file.replace(/\.[^./]+$/, "") + ".html";
fs.writeFileSync(out, buildHtml(title, kept, svgs), "utf8");
process.stderr.write(
  `wrote ${out} (${svgs.length} page${svgs.length !== 1 ? "s" : ""}` +
    (relinked ? `, ${relinked} drill-down link${relinked !== 1 ? "s" : ""}` : "") +
    ")\n"
);

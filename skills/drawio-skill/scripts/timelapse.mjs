#!/usr/bin/env node
// Animate how a codebase's architecture grew, across its git history.
//
// Node port of timelapse.py.
//
// Walks the git history of a directory, re-runs one of the bundled importers at
// each sampled commit (the tree is pulled with `git archive` — the working copy
// is never touched), lays each out and exports a PNG frame, then assembles a
// single self-contained HTML player (frames embedded as base64, play / step
// controls, no external files or CDNs). Open it in any browser to watch the
// modules and edges appear over time.
//
//   node timelapse.mjs skills/drawio-skill/scripts --importer pyimports
//   # -> architecture-evolution.html
//
// The importer is any of the bundled graph extractors (pyimports, jsimports,
// goimports, rustimports, pyclasses, tfimports, k8simports, composeimports,
// sqlerd); it is run against the archived directory with the same positional
// "path" argument they all take, so point the path at the project/package/infra
// root the importer expects. Extra importer flags pass through via
// `--importer-args` (e.g. `--importer-args "--group"`).
//
// Commits that touched the directory are sampled evenly (always keeping the first
// and last) down to `--max-frames`; a commit where the importer finds nothing
// (the path did not exist yet) is skipped. Needs git, the importer's requirements,
// Graphviz (autolayout) and the draw.io CLI — the same tools the importers use.
//
// Usage: timelapse.mjs <dir> [--importer NAME] [--importer-args STR]
//        [--max-frames N] [-o out.html] [--direction TB|LR] [--keep-frames]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "./lib/args.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPORTERS = new Set([
  "pyimports",
  "jsimports",
  "goimports",
  "rustimports",
  "pyclasses",
  "tfimports",
  "k8simports",
  "composeimports",
  "sqlerd",
]);

/** Run a git command in `root`; return {code, stdout} (stdout is a Buffer). */
export function git(root, ...args) {
  try {
    const stdout = execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0) };
  }
}

/**
 * Evenly-spaced indices across [0, total), always including first and last.
 *
 * For total <= n every index is kept; otherwise n indices are picked so the
 * first (0) and last (total-1) are always present and the rest are spread
 * uniformly between them.
 */
export function sampleIndices(total, n) {
  if (total <= 0) return [];
  if (total <= n || n <= 1) return Array.from({ length: total }, (_, i) => i);
  const set = new Set();
  for (let i = 0; i < n; i++) set.add(Math.round((i * (total - 1)) / (n - 1)));
  return [...set].sort((a, b) => a - b);
}

/** Chronological [[hash, isoDate, subject], ...] of commits touching subpath. */
export function history(root, subpath) {
  const { code, stdout } = git(root, "log", "--format=%H%x09%aI%x09%s", "--", subpath || ".");
  if (code !== 0) return [];
  const rows = [];
  for (const line of stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length >= 3) rows.push([parts[0], parts[1], parts.slice(2).join("\t")]);
  }
  return rows.reverse(); // oldest first
}

/** Extract subpath of `commit` into dest via git archive. False if absent. */
export function extractTree(root, commit, subpath, dest) {
  let tarBuf;
  try {
    tarBuf = execFileSync("git", ["-C", root, "archive", commit, subpath || "."], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (!tarBuf || !tarBuf.length) return false;
  execFileSync("tar", ["-x", "-C", dest], { input: tarBuf, stdio: ["pipe", "ignore", "ignore"] });
  return true;
}

/** Importer -> autolayout -> PNG for one commit. Returns [pngBuf, n, e] or null. */
export function buildFrame(importer, importerArgs, workPath, direction, tmp) {
  const graphJson = path.join(tmp, "graph.json");
  try {
    execFileSync(
      process.execPath,
      [path.join(HERE, importer + ".mjs"), workPath, "-o", graphJson, ...importerArgs],
      { stdio: "pipe" }
    );
  } catch {
    return null;
  }
  if (!fs.existsSync(graphJson)) return null;
  const graph = JSON.parse(fs.readFileSync(graphJson, "utf8"));
  if (!graph.nodes || !graph.nodes.length) return null;
  graph.direction = direction;
  fs.writeFileSync(graphJson, JSON.stringify(graph), "utf8");
  const drawio = path.join(tmp, "frame.drawio");
  try {
    execFileSync(process.execPath, [path.join(HERE, "autolayout.mjs"), graphJson, "-o", drawio], { stdio: "pipe" });
  } catch {
    return null;
  }
  if (!fs.existsSync(drawio)) return null;
  const png = path.join(tmp, "frame.png");
  try {
    execFileSync("drawio", ["-x", "-f", "png", "--width", "1600", "-o", png, drawio], { stdio: "pipe" });
  } catch {
    return null;
  }
  if (!fs.existsSync(png)) return null;
  return [fs.readFileSync(png), graph.nodes.length, graph.edges.length];
}

/** Self-contained HTML player for the frame list. */
export function buildHtml(frames, title) {
  const data = frames.map(([png, h, d, s, n, e]) => ({
    img: "data:image/png;base64," + Buffer.from(png).toString("base64"),
    hash: h.slice(0, 9),
    date: d.slice(0, 10),
    subj: s,
    n,
    e,
  }));
  const peak = data.length ? Math.max(...data.map((f) => f.n), 1) : 1;
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
.cap b{color:inherit;font-weight:600}.cap .subj{color:#1a1a1a}
@media(prefers-color-scheme:dark){.cap .subj{color:#e8e8e8}}
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
<div id="stage"><img id="img" alt="architecture frame"></div>
<div class="cap">
  <span><b id="idx"></b></span>
  <span><b id="hash"></b> · <span id="date"></span></span>
  <span class="subj" id="subj"></span>
  <span id="counts"></span>
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
const F=${payload},PEAK=${peak};
let i=0,timer=null;
const $=id=>document.getElementById(id);
$("scrub").max=F.length-1;
function show(k){
  i=(k+F.length)%F.length;const f=F[i];
  $("img").src=f.img;$("idx").textContent=\`Frame \${i+1} / \${F.length}\`;
  $("hash").textContent=f.hash;$("date").textContent=f.date;$("subj").textContent=f.subj;
  $("counts").textContent=\`\${f.n} nodes · \${f.e} edges\`;
  $("bar").style.width=(6+94*f.n/PEAK)+"%";$("scrub").value=i;
}
function stop(){clearInterval(timer);timer=null;$("play").textContent="▶ Play";}
$("prev").onclick=()=>{stop();show(i-1);};
$("next").onclick=()=>{stop();show(i+1);};
$("scrub").oninput=e=>{stop();show(+e.target.value);};
$("play").onclick=()=>{
  if(timer){stop();return;}
  $("play").textContent="⏸ Pause";
  timer=setInterval(()=>{if(i>=F.length-1){show(0);}else{show(i+1);}},900);
};
show(0);
</script></body></html>`;
}

function main() {
  const a = parseArgs(
    {
      name: "timelapse.mjs",
      usage:
        "Usage: timelapse.mjs <dir> [--importer NAME] [--importer-args STR] " +
        "[--max-frames N] [-o out.html] [--direction TB|LR] [--keep-frames]",
      flags: {
        importer: { takesValue: true, default: "pyimports" },
        "importer-args": { takesValue: true, default: "" },
        "max-frames": { takesValue: true, default: "10" },
        direction: { takesValue: true, default: "TB" },
        output: { short: "-o", takesValue: true, default: "architecture-evolution.html" },
        "keep-frames": { takesValue: false },
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("need exactly one <dir>");
  const dirArg = a._[0];

  let importer = a.importer;
  if (importer.endsWith(".py") || importer.endsWith(".mjs")) {
    importer = importer.replace(/\.(py|mjs)$/, "");
  }
  if (!IMPORTERS.has(importer)) {
    die(`unknown importer '${importer}' (choose one of: ${[...IMPORTERS].sort().join(", ")})`);
  }
  if (!["TB", "LR"].includes(a.direction)) {
    die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);
  }
  if (!fs.existsSync(dirArg) || !fs.statSync(dirArg).isDirectory()) {
    die(`${dirArg} is not a directory`);
  }
  const { code: topCode, stdout: topOut } = git(dirArg, "rev-parse", "--show-toplevel");
  if (topCode !== 0) die(`${dirArg} is not inside a git repository`);
  const root = topOut.toString("utf8").trim();
  let subpath = path.relative(root, path.resolve(dirArg));
  if (subpath === ".") subpath = "";

  const commits = history(root, subpath);
  if (!commits.length) die(`no commits touch ${dirArg}`);
  const maxFrames = parseInt(a["max-frames"], 10);
  const picked = sampleIndices(commits.length, maxFrames).map((i) => commits[i]);
  const impArgs = a["importer-args"].split(/\s+/).filter(Boolean);

  const frames = [];
  for (let n = 0; n < picked.length; n++) {
    const [h, date, subj] = picked[n];
    process.stderr.write(`[${n + 1}/${picked.length}] ${h.slice(0, 9)} ${subj.slice(0, 50)}\n`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-"));
    try {
      if (!extractTree(root, h, subpath, tmp)) continue;
      const work = subpath ? path.join(tmp, subpath) : tmp;
      const frame = buildFrame(importer, impArgs, work, a.direction, tmp);
      if (!frame) {
        process.stderr.write("    (importer found nothing — skipped)\n");
        continue;
      }
      const [png, nn, ee] = frame;
      frames.push([png, h, date, subj, nn, ee]);
      if (a["keep-frames"]) {
        const base = a.output.replace(/\.[^./]+$/, "");
        fs.writeFileSync(`${base}-frame${String(frames.length).padStart(2, "0")}.png`, png);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (!frames.length) die("no frames produced (importer found nothing in any commit)");
  const title = `Architecture evolution — ${path.basename(path.resolve(dirArg))}`;
  fs.writeFileSync(a.output, buildHtml(frames, title), "utf8");
  process.stderr.write(`wrote ${a.output} (${frames.length} frames)\n`);
}

function isMainModule() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}
if (isMainModule()) {
  main();
}

#!/usr/bin/env node
// Make a diagram's edges *flow* — an animated data-flow SVG.
//
// Exports a .drawio to SVG (or takes an .svg directly) and turns every edge into
// a marching-ants animation: dashes travel along each connector in the direction
// of the arrow, so the diagram shows data/flow moving through it. The result is
// a single self-contained .svg that loops forever in any browser — nice for a
// README (GitHub renders SVG), a docs page, or a slide background.
//
//   svgflow.mjs architecture.drawio -o architecture-flow.svg
//   svgflow.mjs already-exported.svg  -o flow.svg
//
// Edges are found by draw.io's own marker: connector *lines* carry
// pointer-events="stroke" (shape outlines and arrowheads use ="all"), so only
// the real edges animate — arrowheads and shapes stay put. --speed sets seconds
// per cycle, --dash the dash pattern, --reverse flips the flow direction.
//
// Usage: svgflow.mjs <file.drawio|file.svg> [-o out.svg]
//        [--speed SEC] [--dash "6 4"] [--reverse]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs, die } from "./lib/args.mjs";

const EDGE_PATH = /(<path )((?:(?!\/?>)[^>])*pointer-events="stroke"(?:(?!\/?>)[^>])*\/?>)/g;

// Return SVG text for a .drawio (export via CLI) or .svg (read directly).
function toSvg(filePath) {
  if (filePath.toLowerCase().endsWith(".svg")) {
    return fs.readFileSync(filePath, "utf8");
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "svgflow-"));
  try {
    const out = path.join(tmp, "d.svg");
    let ok = true;
    try {
      execFileSync("drawio", ["-x", "-f", "svg", "-o", out, filePath], { stdio: "pipe" });
    } catch {
      ok = false;
    }
    if (!ok || !fs.existsSync(out)) {
      die("draw.io SVG export failed (is the draw.io CLI installed?)");
    }
    return fs.readFileSync(out, "utf8");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Python "%g" formatting.
function fmtG(n) {
  if (Number.isInteger(n)) return String(n);
  let s = n.toPrecision(6);
  if (s.includes(".") && !s.includes("e") && !s.includes("E")) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

// Tag edge paths and inject the flow keyframes. Returns [svg, edgeCount].
function animate(svg, speed, dash, reverse) {
  let n = 0;
  svg = svg.replace(EDGE_PATH, (m, p1, p2) => {
    n++;
    return `${p1}class="dio-flow" ${p2}`;
  });
  // One dash+gap of travel per cycle => seamless loop. Reverse flips the sign.
  const parts = dash.split(/\s+/).filter(Boolean).map(Number);
  const period = parts.reduce((a, b) => a + b, 0) || 10;
  const offset = reverse ? period : -period;
  const style =
    `<style>.dio-flow{stroke-dasharray:${dash};` +
    `animation:dio-flow ${speed}s linear infinite;}` +
    `@keyframes dio-flow{to{stroke-dashoffset:${fmtG(offset)};}}</style>`;
  svg = svg.replace(/(<svg\b[^>]*>)/, `$1${style}`);
  return [svg, n];
}

const a = parseArgs(
  {
    name: "svgflow",
    usage: "Usage: svgflow.mjs <file.drawio|file.svg> [-o out.svg] [--speed SEC] [--dash \"6 4\"] [--reverse]",
    flags: {
      output: { short: "-o", takesValue: true },
      speed: { takesValue: true, type: "float", default: 1.2 },
      dash: { takesValue: true, default: "6 4" },
      reverse: {},
    },
  },
  process.argv.slice(2)
);

if (a._.length !== 1) die("need exactly one <file.drawio|file.svg>");
const file = a._[0];

if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die(`${file} not found`);
let svg = toSvg(file);
if (!svg.includes("<svg")) die("no <svg> element found in the exported output");
const [outSvg, n] = animate(svg, a.speed, a.dash, a.reverse);
if (n === 0) {
  process.stderr.write("warning: no edges found to animate (a diagram with no connectors?)\n");
}

const out = a.output || file.replace(/\.[^./]+$/, "") + "-flow.svg";
fs.writeFileSync(out, outSvg, "utf8");
process.stderr.write(`wrote ${out} (${n} edge${n !== 1 ? "s" : ""} animated)\n`);

#!/usr/bin/env node
// De-rasterize an image-extracted graph (JSON) into an editable .drawio.
//
// Node port of raster2drawio.py. Turns a nodes/edges JSON description
// (produced by Claude reading a whiteboard photo / legacy diagram image —
// see references/derasterize.md) into `.drawio` XML. Note: despite the
// script name, the Python original never decodes PNG pixel data itself —
// image → JSON is a separate (vision) step; this script only maps JSON to
// drawio XML, honoring coordinates/labels/shapes/colors already extracted.
//
// If any node is missing x/y, positions aren't guessed here: the graph is
// handed to autolayoutModel() (in-process, mirrors the Python original's
// shell-out to autolayout.py) to place it, and a note is written to stderr.
//
// Usage: raster2drawio.mjs <graph.json|-> [-o out.drawio]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "./lib/args.mjs";
import { autolayoutModel, wrapPage } from "./autolayout.mjs";

const DEFAULT_W = 120;
const DEFAULT_H = 60;
const DEFAULT_FILL = "#dae8fc";
const DEFAULT_STROKE = "#6c8ebf";
const SHAPES = {
  rect: "whiteSpace=wrap;html=1;",
  rounded: "rounded=1;whiteSpace=wrap;html=1;",
  ellipse: "ellipse;whiteSpace=wrap;html=1;",
  rhombus: "rhombus;whiteSpace=wrap;html=1;",
  diamond: "rhombus;whiteSpace=wrap;html=1;",
  cylinder: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=15;",
  parallelogram: "shape=parallelogram;whiteSpace=wrap;html=1;",
  cloud: "ellipse;shape=cloud;whiteSpace=wrap;html=1;",
  hexagon: "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;",
};
const EDGE_BASE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;";

// Newlines in labels become &#xa; so draw.io renders a line break (a raw
// newline inside an XML attribute is normalized to a space by parsers).
function attr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#xa;");
}

function nodeStyle(node) {
  const base = SHAPES[node.shape ?? "rect"] ?? SHAPES.rect;
  const fill = node.fill ?? DEFAULT_FILL;
  const stroke = node.stroke ?? DEFAULT_STROKE;
  return `${base}fillColor=${fill};strokeColor=${stroke};`;
}

function edgeStyle(edge) {
  let style = EDGE_BASE;
  if (edge.dashed) style += "dashed=1;";
  if (edge.arrow === false) style += "endArrow=none;";
  return style;
}

// Direct build: every node already has x/y. Mirrors autolayout.py's/
// autolayout.mjs's cell string-building, without the layout pass.
function toDrawio(nodes, edges) {
  const cells = [];
  for (const node of nodes) {
    const w = node.w ?? DEFAULT_W;
    const h = node.h ?? DEFAULT_H;
    cells.push(
      `        <mxCell id="${attr(node.id)}" value="${attr(node.label ?? node.id)}" ` +
        `style="${attr(nodeStyle(node))}" vertex="1" parent="1">\n` +
        `          <mxGeometry x="${node.x}" y="${node.y}" width="${w}" height="${h}" as="geometry"/>\n` +
        `        </mxCell>`
    );
  }
  edges.forEach((edge, i) => {
    cells.push(
      `        <mxCell id="e${i}" value="${attr(edge.label ?? "")}" ` +
        `style="${attr(edgeStyle(edge))}" edge="1" parent="1" ` +
        `source="${attr(edge.source)}" target="${attr(edge.target)}">\n` +
        `          <mxGeometry relative="1" as="geometry"/>\n` +
        `        </mxCell>`
    );
  });
  return "<mxfile>\n" + wrapPage(cells.join("\n"), { pageId: "raster2drawio", name: "Page-1" }) + "</mxfile>\n";
}

// Same graph, in autolayout's input shape (positions dropped — the layout
// engine computes fresh ones for every node).
function buildAutolayoutGraph(nodes, edges) {
  return {
    direction: "TB",
    nodes: nodes.map((n) => ({
      id: n.id,
      label: n.label ?? n.id,
      style: nodeStyle(n),
      width: n.w ?? DEFAULT_W,
      height: n.h ?? DEFAULT_H,
    })),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      label: e.label ?? "",
      style: edgeStyle(e),
    })),
  };
}

async function runAutolayout(graph) {
  const cells = await autolayoutModel(graph, { color: true });
  return "<mxfile>\n" + wrapPage(cells) + "</mxfile>\n";
}

async function main() {
  const a = parseArgs(
    {
      name: "raster2drawio",
      usage: "Usage: raster2drawio.mjs <graph.json|-> [-o out.drawio]",
      flags: {
        output: { short: "-o", takesValue: true },
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("need exactly one <graph.json|->");
  const input = a._[0];

  let raw;
  if (input === "-") {
    raw = fs.readFileSync(0, "utf8");
  } else {
    try {
      raw = fs.readFileSync(input, "utf8");
    } catch (exc) {
      die(`cannot read ${input}: ${exc.message}`);
    }
  }

  let graph;
  try {
    graph = JSON.parse(raw);
  } catch (exc) {
    die(`invalid JSON: ${exc.message}`);
  }

  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  if (!nodes.length) die("no nodes in input");
  for (const n of nodes) {
    if (!("id" in n)) die("every node needs an 'id'");
  }
  for (const e of edges) {
    if (!("source" in e) || !("target" in e)) die("every edge needs 'source' and 'target'");
  }

  let xml;
  if (nodes.some((n) => n.x === undefined || n.x === null || n.y === undefined || n.y === null)) {
    xml = await runAutolayout(buildAutolayoutGraph(nodes, edges));
    process.stderr.write("note: some nodes had no x/y — positions were auto-placed via autolayout.py\n");
  } else {
    xml = toDrawio(nodes, edges);
  }

  if (a.output) {
    fs.writeFileSync(a.output, xml, "utf8");
    process.stderr.write(`wrote ${a.output} (${nodes.length} nodes, ${edges.length} edges)\n`);
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

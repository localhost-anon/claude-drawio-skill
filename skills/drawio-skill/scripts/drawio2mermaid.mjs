#!/usr/bin/env node
// Convert a .drawio into Mermaid flowchart text (diagrams-as-code).
//
// Usage: drawio2mermaid.mjs <file.drawio> [-o out] [--direction TD|LR] [--fenced]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";
import { parse } from "./lib/xml.mjs";

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function htmlUnescape(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent] : m;
  });
}

// Strip the HTML draw.io stores in labels; keep line breaks as \n.
function clean(text) {
  if (!text) return "";
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = htmlUnescape(text);
  return text.replace(/[ \t]+/g, " ").trim();
}

// Mermaid-safe quoted label: escape quotes, newlines -> <br/>.
function esc(label) {
  label = label.replace(/"/g, "&quot;").replace(/\n/g, "<br/>");
  return label || " ";
}

// Mermaid node declaration, shape chosen from the draw.io style.
function nodeForm(safeId, label, style) {
  const lbl = `"${esc(label)}"`;
  if (style.includes("shape=cylinder") || style.includes("shape=datastore")) {
    return `${safeId}[(${lbl})]`; // database
  }
  if (style.includes("rhombus")) {
    return `${safeId}{${lbl}}`; // decision
  }
  if (style.includes("ellipse") || style.includes("shape=cloud")) {
    return `${safeId}((${lbl}))`; // circle-ish
  }
  return `${safeId}[${lbl}]`; // default box
}

// [{cell, id, label}] for a page, unwrapping UserObject/object wrappers.
function cellsOf(page) {
  const model = page.children.find((c) => c.tag === "mxGraphModel");
  const root = model ? model.children.find((c) => c.tag === "root") : null;
  if (!root) return null;
  const out = [];
  for (const child of root.children) {
    if (child.tag === "mxCell") {
      out.push({ cell: child, id: child.attrs.id, label: clean(child.attrs.value) });
    } else if (child.tag === "UserObject" || child.tag === "object") {
      const inner = child.children.find((c) => c.tag === "mxCell");
      if (inner) {
        inner.attrs.id = child.attrs.id || "";
        out.push({
          cell: inner,
          id: child.attrs.id,
          label: clean(child.attrs.label !== undefined ? child.attrs.label : child.attrs.value),
        });
      }
    }
  }
  return out;
}

function pageToMermaid(page, direction) {
  const cells = cellsOf(page);
  if (cells === null) return "%% (compressed page — skipped)";

  const label = new Map(cells.map(({ id, label: l }) => [id, l]));
  const style = new Map(cells.map(({ cell, id }) => [id, cell.attrs.style || ""]));
  const parents = new Set(cells.map(({ cell }) => cell.attrs.parent).filter((p) => p));

  const verts = cells.filter(({ cell }) => cell.attrs.vertex === "1").map(({ cell, id }) => [cell, id]);
  const containers = new Set(verts.filter(([, id]) => parents.has(id)).map(([, id]) => id));
  const leaves = verts.filter(
    ([, id]) => !containers.has(id) && !(style.get(id) || "").includes("edgeLabel")
  );

  const sid = new Map(leaves.map(([, id], i) => [id, `n${i}`])); // mermaid-safe ids
  const lines = [`flowchart ${direction}`];

  // Nodes, grouped into subgraphs by their container.
  const byContainer = new Map();
  for (const [cell, cid] of leaves) {
    const parent = cell.attrs.parent;
    const key = containers.has(parent) ? parent : null;
    if (!byContainer.has(key)) byContainer.set(key, []);
    byContainer.get(key).push(cid);
  }

  function emitNode(cid, indent) {
    lines.push(indent + nodeForm(sid.get(cid), label.get(cid) || cid, style.get(cid) || ""));
  }

  for (const cid of byContainer.get(null) || []) {
    emitNode(cid, "    ");
  }
  for (const [cont, members] of byContainer) {
    if (cont === null) continue;
    lines.push(`    subgraph ${sid.get(cont) || "g_" + cont}["${esc(label.get(cont) || "")}"]`);
    for (const cid of members) emitNode(cid, "        ");
    lines.push("    end");
  }

  // Edges (only between leaves we emitted).
  for (const { cell } of cells) {
    if (cell.attrs.edge !== "1") continue;
    const s = cell.attrs.source, t = cell.attrs.target;
    if (sid.has(s) && sid.has(t)) {
      const lbl = clean(cell.attrs.value);
      const arrow = lbl ? `-->|"${esc(lbl)}"|` : "-->";
      lines.push(`    ${sid.get(s)} ${arrow} ${sid.get(t)}`);
    }
  }
  return lines.join("\n");
}

const a = parseArgs(
  {
    name: "drawio2mermaid",
    usage: "Usage: drawio2mermaid.mjs <file.drawio> [-o out] [--direction TD|LR] [--fenced]",
    flags: {
      output: { short: "-o", takesValue: true },
      direction: { takesValue: true, default: "TD" },
      fenced: {},
    },
  },
  process.argv.slice(2)
);

if (a._.length !== 1) die("need exactly one <file.drawio>");
const file = a._[0];

if (!["TD", "LR", "TB", "RL", "BT"].includes(a.direction)) {
  process.stderr.write(
    `usage: drawio2mermaid.mjs [-h] [-o OUTPUT] [--direction {TD,LR,TB,RL,BT}] [--fenced] file\n` +
      `drawio2mermaid.mjs: error: argument --direction: invalid choice: '${a.direction}' (choose from 'TD', 'LR', 'TB', 'RL', 'BT')\n`
  );
  process.exit(2);
}

let root;
try {
  const text = fs.readFileSync(file, "utf8");
  root = parse(text);
} catch (exc) {
  const msg =
    exc && exc.code === "ENOENT"
      ? `[Errno 2] No such file or directory: '${file}'`
      : String(exc.message || exc);
  process.stderr.write(`error: cannot parse ${file}: ${msg}\n`);
  process.exit(1);
}

const topDiagrams = root.children.filter((c) => c.tag === "diagram");
const pages = topDiagrams.length ? topDiagrams : [root];

const blocks = [];
pages.forEach((page, idx) => {
  const i = idx + 1;
  let graph = pageToMermaid(page, a.direction);
  const name = page.attrs.name;
  if (pages.length > 1 && name) {
    graph = `%% Page ${i}: ${name}\n${graph}`;
  }
  blocks.push(a.fenced ? "```mermaid\n" + graph + "\n```" : graph);
});

const text = blocks.join("\n\n").replace(/\s+$/, "") + "\n";
if (a.output) {
  fs.writeFileSync(a.output, text, "utf8");
  process.stderr.write(`wrote ${a.output} (${pages.length} page${pages.length !== 1 ? "s" : ""})\n`);
} else {
  process.stdout.write(text);
}

#!/usr/bin/env node
// Read a .drawio and describe it as structured Markdown.
//
// Usage: explain.mjs <file.drawio> [-o out.md]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";
import { parse, find } from "./lib/xml.mjs";

// style fragment -> human noun. First match wins; order matters (specific first).
const SHAPE_TYPES = [
  ["mxgraph.aws", "AWS"],
  ["img/lib/azure", "Azure"],
  ["mxgraph.gcp", "GCP"],
  ["mxgraph.kubernetes", "Kubernetes"],
  ["umlActor", "actor"],
  ["shape=actor", "actor"],
  ["shape=cylinder", "data store"],
  ["shape=datastore", "data store"],
  ["shape=cloud", "cloud"],
  ["rhombus", "decision"],
  ["mscae", "Azure"],
  ["shape=process", "process"],
  ["shape=hexagon", "queue"],
];

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// Approximate Python's html.unescape() for the entities draw.io actually emits.
function htmlUnescape(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isNaN(code)) return String.fromCodePoint(code);
      return m;
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent)) return NAMED_ENTITIES[ent];
    return m;
  });
}

// Strip HTML tags/entities draw.io stores in labels; collapse whitespace.
function clean(text) {
  if (!text) return "";
  text = text.replace(/<br\s*\/?>/gi, " ");
  text = text.replace(/<[^>]+>/g, "");
  return htmlUnescape(text).replace(/\s+/g, " ").trim();
}

function shapeOf(style) {
  for (const [frag, noun] of SHAPE_TYPES) {
    if ((style || "").includes(frag)) return noun;
  }
  return null;
}

// [{cell, id, label}] for a page, unwrapping UserObject/object wrappers.
function cellsOf(page) {
  const model = find(page, "mxGraphModel");
  const root = model ? find(model, "root") : null;
  if (!root) return null; // compressed / empty page
  const out = [];
  for (const child of root.children) {
    if (child.tag === "mxCell") {
      out.push({ cell: child, id: child.attrs.id, label: clean(child.attrs.value) });
    } else if (child.tag === "UserObject" || child.tag === "object") {
      const inner = find(child, "mxCell");
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

// Markdown body lines for one <diagram> page (no page heading).
function describePage(page) {
  const cells = cellsOf(page);
  if (cells === null) return ["_(compressed page — cannot describe)_"];

  const label = new Map(cells.map(({ id, label: l }) => [id, l]));
  const style = new Map(cells.map(({ cell, id }) => [id, cell.attrs.style || ""]));
  const parents = new Set(cells.map(({ cell }) => cell.attrs.parent).filter((p) => p));

  const vertices = cells.filter(({ cell }) => cell.attrs.vertex === "1").map(({ cell, id }) => [cell, id]);
  const containers = new Set(vertices.filter(([, id]) => parents.has(id)).map(([, id]) => id));
  const leaves = vertices.filter(
    ([, id]) => !containers.has(id) && !(style.get(id) || "").includes("edgeLabel")
  );

  const groups = new Map();
  const order = [];
  for (const [cell, cid] of leaves) {
    const parent = cell.attrs.parent;
    let gname = containers.has(parent) ? label.get(parent) || "" : "";
    gname = gname || "Ungrouped";
    if (!groups.has(gname)) {
      groups.set(gname, []);
      order.push(gname);
    }
    const typ = shapeOf(style.get(cid) || "");
    const name = label.get(cid) || `(unlabeled ${cid})`;
    groups.get(gname).push(`${name}` + (typ ? ` _${typ}_` : ""));
  }

  const lines = [`### Components (${leaves.length})`, ""];
  const single = order.length === 1 && order[0] === "Ungrouped";
  for (const gname of order) {
    if (!single) {
      lines.push(`- **${gname}**`);
      for (const item of groups.get(gname)) lines.push(`  - ${item}`);
    } else {
      for (const item of groups.get(gname)) lines.push(`- ${item}`);
    }
  }
  lines.push("");

  const edges = cells.filter(({ cell }) => cell.attrs.edge === "1").map(({ cell }) => cell);
  const rels = [];
  for (const e of edges) {
    const s = label.get(e.attrs.source);
    const t = label.get(e.attrs.target);
    if (!s || !t) continue; // dangling endpoint — skip
    const verb = clean(e.attrs.value);
    rels.push(verb ? `- ${s} —${verb}→ ${t}` : `- ${s} → ${t}`);
  }
  lines.push(`### Relations (${rels.length})`);
  lines.push("");
  lines.push(...(rels.length ? rels : ["_(none)_"]));
  lines.push("");
  return lines;
}

const a = parseArgs({
  name: "explain",
  usage: "Usage: explain.mjs <file.drawio> [-o out.md]",
  flags: {
    output: { short: "-o", takesValue: true },
  },
}, process.argv.slice(2));

if (a._.length !== 1) die("need exactly one <file.drawio>");
const file = a._[0];

let root;
try {
  const text = fs.readFileSync(file, "utf8");
  root = parse(text);
} catch (exc) {
  const msg = exc && exc.code === "ENOENT"
    ? `[Errno 2] No such file or directory: '${file}'`
    : String(exc.message || exc);
  process.stderr.write(`error: cannot parse ${file}: ${msg}\n`);
  process.exit(1);
}

const topDiagrams = root.children.filter((c) => c.tag === "diagram");
const pages = topDiagrams.length ? topDiagrams : [root];

const base = file.split("/").pop();
const dot = base.lastIndexOf(".");
const title = dot > 0 ? base.slice(0, dot) : base;

let lines = [`# ${title}`, ""];
pages.forEach((page, idx) => {
  const i = idx + 1;
  const name = page.attrs.name;
  if (pages.length > 1) {
    lines.push(name ? `## Page ${i}: ${name}` : `## Page ${i}`);
    lines.push("");
  }
  lines = lines.concat(describePage(page));
});

const text = lines.join("\n").replace(/\s+$/, "") + "\n";
if (a.output) {
  fs.writeFileSync(a.output, text, "utf8");
  process.stderr.write(`wrote ${a.output}\n`);
} else {
  process.stdout.write(text);
}

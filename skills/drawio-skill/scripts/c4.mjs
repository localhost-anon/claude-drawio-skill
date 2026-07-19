#!/usr/bin/env node
// C4 model diagrams: levels JSON -> one multi-page .drawio with drill-down.
//
// Node port of c4.py. Python original called autolayout.py's build_dot/layout
// (Graphviz `dot`) per page; this port calls autolayoutModel() from
// autolayout.mjs (elkjs) instead — node coordinates will differ from the
// Python output (byte-parity not expected), gate via validate.mjs +
// bounding-box overlap check per test harness rules.
//
// Input JSON:
//   {
//     "title": "Internet Banking",
//     "levels": [
//       { "name": "System Context",
//         "elements": [
//           {"id": "customer", "type": "person", "label": "Personal Customer", "desc": "..."},
//           {"id": "ibs", "type": "system", "label": "Internet Banking System",
//            "desc": "...", "children": "Containers"},
//         ],
//         "relations": [ {"from": "customer", "to": "ibs", "label": "Uses"} ]
//       },
//       ...
//     ]
//   }
//
// Usage: c4.mjs <c4.json> [-o out.drawio] [--direction TB|LR]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";
import { autolayoutModel, wrapPage } from "./autolayout.mjs";

// Official draw.io C4 template styles (colors from c4model.com).
const _BASE = "html=1;whiteSpace=wrap;fontSize=12;fontColor=#ffffff;align=center;";
const STYLES = {
  person: ["shape=mxgraph.c4.person2;" + _BASE + "fillColor=#083F75;strokeColor=#06315C;", 200, 180],
  system: ["rounded=1;arcSize=10;" + _BASE + "fillColor=#1061B0;strokeColor=#0D5091;", 240, 120],
  external: ["rounded=1;arcSize=10;" + _BASE + "fillColor=#8C8496;strokeColor=#736782;", 240, 120],
  container: ["rounded=1;arcSize=10;" + _BASE + "fillColor=#23A2D9;strokeColor=#0E7DAD;", 240, 120],
  component: ["rounded=1;arcSize=10;" + _BASE + "fillColor=#63BEF2;strokeColor=#2086C9;", 240, 120],
  database: ["shape=cylinder3;size=15;boundedLbl=1;" + _BASE + "fillColor=#23A2D9;strokeColor=#0E7DAD;", 240, 120],
};
const TYPE_WORD = {
  person: "Person",
  system: "Software System",
  external: "Software System",
  container: "Container",
  component: "Component",
  database: "Container",
};
const EDGE = "endArrow=blockThin;endFill=1;endSize=10;html=1;fontSize=11;" +
  "fontColor=#404040;strokeColor=#828282;labelBackgroundColor=#ffffff;rounded=0;";

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}

function c4Label(el) {
  const kind = TYPE_WORD[el.type ?? "system"] ?? "Software System";
  const bracket = el.tech ? `[${kind}: ${el.tech}]` : `[${kind}]`;
  const lines = [el.label ?? el.id, bracket];
  if (el.desc) lines.push(el.desc);
  return lines.join("\n");
}

async function main() {
  const a = parseArgs(
    {
      name: "c4",
      usage: "Usage: c4.mjs <c4.json> [-o out.drawio] [--direction TB|LR]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "TB" },
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("need exactly one <c4.json>");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(a._[0], "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") die(`[Errno 2] No such file or directory: '${a._[0]}'`);
    die(String(e.message || e));
  }
  const levels = spec.levels || [];
  if (levels.length === 0) die("no levels in input");

  const pageIds = new Map(levels.map((lv) => [lv.name, slug(lv.name)]));
  const seen = new Set();
  const pages = [];

  for (const lv of levels) {
    const nodes = [];
    for (const el of lv.elements || []) {
      if (seen.has(el.id)) die(`duplicate element id ${pyRepr(el.id)} (ids must be unique across all levels)`);
      seen.add(el.id);
      const [style, w, h] = STYLES[el.type ?? "system"] ?? STYLES.system;
      const node = { id: el.id, label: c4Label(el), style, width: w, height: h };
      const child = el.children;
      if (child) {
        if (!pageIds.has(child)) die(`element ${pyRepr(el.id)} drills down to unknown level ${pyRepr(child)}`);
        node.link = `data:page/id,${pageIds.get(child)}`;
      }
      nodes.push(node);
    }
    const edges = (lv.relations || []).map((r) => ({
      source: r.from,
      target: r.to,
      label: r.label ?? "",
      style: EDGE,
    }));
    const graph = { direction: a.direction, nodes, edges };
    const cells = await autolayoutModel(graph, { color: false });
    pages.push(wrapPage(cells, { pageId: pageIds.get(lv.name), name: lv.name }));
  }

  const xml = "<mxfile>\n" + pages.join("") + "</mxfile>\n";
  if (a.output) {
    fs.writeFileSync(a.output, xml, "utf8");
    process.stderr.write(`wrote ${a.output} (${pages.length} pages, ${seen.size} elements)\n`);
  } else {
    process.stdout.write(xml);
  }
}

// Python repr() of a string, used in error messages.
function pyRepr(s) {
  if (s === null || s === undefined) return "None";
  return `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

await main();

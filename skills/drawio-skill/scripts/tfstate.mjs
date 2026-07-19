#!/usr/bin/env node
// Draw the cloud resources ACTUALLY deployed, from `terraform show -json`.
// Direct port of tfstate.py.
//
// Where tfimports.mjs reads the *declared* config (.tf files), this reads
// the *real* state: what Terraform recorded as provisioned. Reuses
// tfimports.mjs's IconResolver/transitiveReduce via a plain ESM import
// (the Python original used importlib.util to dynamically load tfimports.py
// at runtime; here it's just a static import).
//
// Usage: terraform show -json | tfstate.mjs - [-o graph.json]
//        [--direction TB|LR] [--group] [--no-reduce] [--no-icons]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";
import { IconResolver, transitiveReduce } from "./tfimports.mjs";

// Collect [address, type, name, index, modulePath, dependsOn] for every
// managed resource, recursing into child modules.
function walkModule(mod, out) {
  const addr = mod.address || ""; // "" for root, else module.x[...]
  for (const r of mod.resources || []) {
    if (r.mode === "data") continue;
    out.push([r.address, r.type, r.name, r.index ?? null, addr, r.depends_on || []]);
  }
  for (const child of mod.child_modules || []) walkModule(child, out);
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const a = parseArgs(
    {
      name: "tfstate",
      usage: "Usage: tfstate.mjs <input|-> [-o graph.json] [--direction TB|LR] [--group] [--no-reduce] [--no-icons]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "TB" },
        group: {},
        "no-reduce": {},
        "no-icons": {},
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("the following arguments are required: input");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const text = a._[0] === "-" ? readStdin() : fs.readFileSync(a._[0], "utf8");
  let data;
  try {
    data = JSON.parse(text);
  } catch (exc) {
    die(`input is not valid JSON (${exc.message}) — feed \`terraform show -json\``);
  }
  // State: top-level "values"; saved plan: "planned_values".
  const root = (data.values || data.planned_values || {}).root_module || {};
  const resources = [];
  walkModule(root, resources);
  if (!resources.length) {
    process.stderr.write("error: no managed resources found in the Terraform state/plan\n");
    process.exit(1);
  }

  const addresses = new Set(resources.map((r) => r[0]));

  // Instance addresses a depends_on entry names. State records the un-indexed
  // address (aws_subnet.this) for a resource with several instances
  // (aws_subnet.this[0]), so expand by prefix too.
  const targets = (dep) => {
    if (addresses.has(dep)) return new Set([dep]);
    const out = new Set();
    for (const a2 of addresses) if (a2.startsWith(dep + "[")) out.add(a2);
    return out;
  };

  const edgeSet = new Set();
  const pairs = [];
  for (const [addr, , , , , deps] of resources) {
    for (const dep of deps) {
      for (const t of targets(dep)) {
        if (t === addr) continue;
        const key = `${addr} ${t}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          pairs.push([addr, t]);
        }
      }
    }
  }
  pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));

  const raw = pairs.length;
  let edges = pairs;
  if (!a["no-reduce"] && edges.length) edges = transitiveReduce([...addresses], pairs);

  const resolver = a["no-icons"] ? null : new IconResolver();
  const unmatched = [];
  const nodes = [];
  for (const [addr, rtype, name, index, mpath] of resources) {
    const label = index === null ? name : `${name}[${index}]`;
    const node = { id: addr, label };
    const icon = resolver && rtype ? resolver.resolve(rtype) : null;
    if (icon) {
      node.style = icon.style;
      node.width = icon.w;
      node.height = icon.h;
    } else {
      node.label = rtype ? `${label}\n${rtype}` : label;
      if (rtype) unmatched.push(rtype);
    }
    if (a.group && mpath) node.group = mpath;
    nodes.push(node);
  }

  const graph = {
    direction: a.direction,
    nodes,
    edges: edges.map(([s, t]) => ({ source: s, target: t })),
  };
  if (resolver) {
    graph.ranksep = 0.7;
    graph.nodesep = 0.6;
  }
  const out = JSON.stringify(graph, null, 2);
  if (a.output) {
    fs.writeFileSync(a.output, out, "utf8");
    process.stderr.write(`wrote ${a.output}\n`);
  } else {
    process.stdout.write(out);
  }
  const note = a["no-reduce"] ? "" : ` (reduced from ${raw})`;
  process.stderr.write(`${nodes.length} resources, ${edges.length} edges${note}\n`);
  if (unmatched.length) {
    process.stderr.write("no icon for: " + [...new Set(unmatched)].sort().join(", ") + "\n");
  }
}

main();

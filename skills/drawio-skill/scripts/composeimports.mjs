#!/usr/bin/env node
// Extract a docker-compose file's service graph as autolayout graph JSON.
// Direct port of composeimports.py.
//
// Services become rounded boxes (labeled name + image), named volumes become
// cylinders, and edges come from real wiring: `depends_on` (list or mapping
// form), `links`, `volumes_from`, and named-volume mounts (short "vol:/path"
// and long {type: volume, source: ...} syntax). The output feeds autolayout.mjs.
//
// The Python original calls `yaml.safe_load()` unconditionally (no
// extension-based branching) and exits if PyYAML isn't installed -- there is
// no bundled fallback parser. This port must add zero new dependencies (no
// `yaml` npm package) and Node's standard library has no YAML parser, so it
// takes advantage of the fact that JSON is a valid subset of YAML: it parses
// the compose file with JSON.parse, which succeeds for any compose file that
// happens to be written as pure JSON (also valid YAML, so this is a genuine
// behavioral match for that input class) and fails -- with a clear
// "no YAML parser available" error -- for real YAML syntax (block mappings,
// unquoted scalars, comments, etc.), matching the Python original's actual
// behavior in this environment, where PyYAML is also not installed and
// composeimports.py cannot run on ANY input, YAML or otherwise.
//
// Usage: composeimports.mjs <compose-file-or-dir> [-o graph.json]
//        [--direction TB|LR] [--group]
import fs from "node:fs";
import path from "node:path";
import { parseArgs, die } from "./lib/args.mjs";

const SERVICE_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;";
const VOLUME_STYLE = "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=15;fillColor=#f5f5f5;strokeColor=#666666;";

function findCompose(p) {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  for (const name of ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]) {
    const cand = path.join(p, name);
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  die(`no compose file found under ${p}`);
}

function loadSpec(file) {
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text) || {};
  } catch {
    die("PyYAML is required (pip install pyyaml) -- Node port has zero dependencies and no built-in YAML parser (JSON-formatted compose files work, since JSON is valid YAML)");
  }
}

// Named volumes a service mounts (short and long syntax).
function* volumeMounts(svc) {
  for (const v of svc.volumes || []) {
    if (typeof v === "string") {
      const src = v.split(":", 1)[0];
      if (src && !/^[./~$]/.test(src[0])) yield src;
    } else if (v && typeof v === "object" && (v.type || "volume") === "volume" && v.source) {
      yield v.source;
    }
  }
}

function dependencies(svc) {
  const dep = svc.depends_on || [];
  const deps = Array.isArray(dep) ? [...dep] : dep && typeof dep === "object" ? Object.keys(dep) : [];
  for (const link of svc.links || []) deps.push(String(link).split(":", 1)[0]);
  for (const vf of svc.volumes_from || []) deps.push(String(vf).split(":", 1)[0]);
  return deps;
}

function main() {
  const a = parseArgs(
    {
      name: "composeimports",
      usage: "Usage: composeimports.mjs <compose-file-or-dir> [-o graph.json] [--direction TB|LR] [--group]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "TB" },
        group: {},
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("the following arguments are required: path");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const cfile = findCompose(a._[0]);
  const spec = loadSpec(cfile);
  const services = spec.services || {};
  if (!Object.keys(services).length) die(`no services in ${cfile}`);
  const declaredVolumes = new Set(Object.keys(spec.volumes || {}));

  const nodes = [];
  const edges = new Set();
  for (const [name, svcRaw] of Object.entries(services)) {
    const svc = svcRaw || {};
    let image = svc.image;
    if (!image) {
      const build = svc.build;
      const ctx = build && typeof build === "object" ? build.context || "." : build || ".";
      image = `build: ${ctx}`;
    }
    const node = { id: name, label: `${name}\n${image}`, style: SERVICE_STYLE, width: 160, height: 60 };
    const nets = svc.networks;
    let firstNet = null;
    if (nets) {
      firstNet = Array.isArray(nets) ? nets[0] : [...Object.keys(nets)].sort()[0];
    }
    if (a.group && firstNet) node.group = String(firstNet);
    nodes.push(node);
    for (const dep of dependencies(svc)) {
      if (Object.prototype.hasOwnProperty.call(services, dep) && dep !== name) edges.add(`${name} ${dep}`);
    }
    for (const vol of volumeMounts(svc)) {
      if (declaredVolumes.has(vol)) edges.add(`${name} vol:${vol}`);
    }
  }
  const volNames = new Set();
  for (const e of edges) {
    const t = e.split(" ")[1];
    if (t.startsWith("vol:")) volNames.add(t.slice(4));
  }
  for (const vol of [...volNames].sort()) {
    nodes.push({ id: `vol:${vol}`, label: vol, style: VOLUME_STYLE, width: 120, height: 70 });
  }

  const edgePairs = [...edges]
    .map((e) => e.split(" "))
    .sort(([xs, xt], [ys, yt]) => (xs < ys ? -1 : xs > ys ? 1 : xt < yt ? -1 : xt > yt ? 1 : 0));

  const graph = { direction: a.direction, nodes, edges: edgePairs.map(([s, t]) => ({ source: s, target: t })) };
  const text = JSON.stringify(graph, null, 2);
  if (a.output) {
    fs.writeFileSync(a.output, text, "utf8");
    process.stderr.write(`wrote ${a.output}\n`);
  } else {
    process.stdout.write(text);
  }
  process.stderr.write(`${nodes.length} nodes, ${edgePairs.length} edges\n`);
}

main();

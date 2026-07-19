#!/usr/bin/env node
// Draw the containers that are ACTUALLY running from `docker inspect` output.
// Direct port of dockerimports.py.
//
// Where composeimports.mjs reads the *declared* stack (compose file), this
// reads the *live* one: pipe `docker inspect` of the running containers and
// it maps the real topology -- every container, the user networks they are
// attached to, the named volumes they mount, and the container->container
// edges recorded in `links` / compose `depends_on` labels. The output feeds
// autolayout.mjs:
//
//   docker inspect $(docker ps -q) | node dockerimports.mjs - -o graph.json
//   node autolayout.mjs graph.json -o running.drawio
//
// Input is the JSON array `docker inspect` prints (a file path, or `-` for
// stdin). Containers become rounded boxes (name + image), user networks
// become green ellipses, named volumes become cylinders -- visually matching
// the compose importer so declared and live diagrams read alike. `--group`
// boxes containers by their compose project (falling back to their first
// user network).
//
// Usage: docker inspect $(docker ps -q) | dockerimports.mjs - [-o graph.json]
//        [--direction TB|LR] [--group]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";

const CONTAINER_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;";
const NETWORK_STYLE = "ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;";
const VOLUME_STYLE = "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=15;fillColor=#f5f5f5;strokeColor=#666666;";
// Docker's built-in networks are topology noise -- a compose stack's own
// networks are what tell the architecture story.
const BUILTIN_NETS = new Set(["bridge", "host", "none", "ingress"]);

// A container's short name (strip docker's leading slash).
function cname(obj) {
  return (obj.Name || (obj.Id || "").slice(0, 12)).replace(/^\/+/, "");
}

// Container names this one links to (HostConfig.Links + per-network Links).
function linksOf(obj) {
  const out = new Set();
  const raw = [...((obj.HostConfig || {}).Links || [])];
  for (const net of Object.values((obj.NetworkSettings || {}).Networks || {})) {
    raw.push(...((net || {}).Links || []));
  }
  for (const link of raw) {
    // "/db:/web/db" -> target container is the part before the first colon.
    const target = String(link).replace(/^\/+/, "").split(":", 1)[0];
    if (target) out.add(target);
  }
  return out;
}

// Compose service names this container depends on (label form).
function dependsOn(obj) {
  const label = ((obj.Config || {}).Labels || {})["com.docker.compose.depends_on"];
  if (!label) return new Set();
  // "db:service_healthy:false,cache:service_started:false" -> {db, cache}
  const out = new Set();
  for (const part of label.split(",")) {
    if (part.trim()) out.add(part.split(":", 1)[0]);
  }
  return out;
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
      name: "dockerimports",
      usage: "Usage: dockerimports.mjs <input|-> [-o graph.json] [--direction TB|LR] [--group]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "TB" },
        group: {},
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
    die(`input is not valid JSON (${exc.message}) — feed \`docker inspect ...\``);
  }
  let containers = Array.isArray(data) ? data : [data];
  containers = containers.filter((c) => c && typeof c === "object" && !Array.isArray(c) && c.Id);
  if (!containers.length) die("no containers found (feed `docker inspect $(docker ps -q)`)");

  const names = new Set(containers.map(cname));
  // compose service label -> container name, so depends_on (which names
  // services) can resolve to the real container node.
  const svcToName = {};
  for (const c of containers) {
    const svc = ((c.Config || {}).Labels || {})["com.docker.compose.service"];
    if (svc) svcToName[svc] = cname(c);
  }

  const nodes = [];
  const edges = new Set();
  const nets = new Set();
  const vols = new Set();
  for (const c of containers) {
    const name = cname(c);
    const image = (c.Config || {}).Image || "?";
    const labels = (c.Config || {}).Labels || {};
    const node = { id: name, label: `${name}\n${image}`, style: CONTAINER_STYLE, width: 160, height: 60 };

    const attached = Object.keys((c.NetworkSettings || {}).Networks || {}).filter((n) => !BUILTIN_NETS.has(n));
    if (a.group) {
      const project = labels["com.docker.compose.project"];
      const grp = project || (attached.length ? attached[0] : null);
      if (grp) node.group = String(grp);
    }
    nodes.push(node);

    for (const net of attached) {
      nets.add(net);
      edges.add(`${name} net:${net}`);
    }
    for (const m of c.Mounts || []) {
      if (m.Type === "volume" && m.Name) {
        vols.add(m.Name);
        edges.add(`${name} vol:${m.Name}`);
      }
    }
    for (const target of linksOf(c)) {
      if (names.has(target) && target !== name) edges.add(`${name} ${target}`);
    }
    for (const dep of dependsOn(c)) {
      const target = Object.prototype.hasOwnProperty.call(svcToName, dep) ? svcToName[dep] : dep;
      if (names.has(target) && target !== name) edges.add(`${name} ${target}`);
    }
  }

  for (const net of [...nets].sort()) {
    nodes.push({ id: `net:${net}`, label: net, style: NETWORK_STYLE, width: 120, height: 70 });
  }
  for (const vol of [...vols].sort()) {
    nodes.push({ id: `vol:${vol}`, label: vol, style: VOLUME_STYLE, width: 120, height: 70 });
  }

  const edgePairs = [...edges]
    .map((e) => e.split(" "))
    .sort(([xs, xt], [ys, yt]) => (xs < ys ? -1 : xs > ys ? 1 : xt < yt ? -1 : xt > yt ? 1 : 0));

  const graph = { direction: a.direction, nodes, edges: edgePairs.map(([s, t]) => ({ source: s, target: t })) };
  const out = JSON.stringify(graph, null, 2);
  if (a.output) {
    fs.writeFileSync(a.output, out, "utf8");
    process.stderr.write(`wrote ${a.output}\n`);
  } else {
    process.stdout.write(out);
  }
  process.stderr.write(`${nodes.length} nodes (${containers.length} containers, ${nets.size} networks, ${vols.size} volumes), ${edgePairs.length} edges\n`);
}

main();

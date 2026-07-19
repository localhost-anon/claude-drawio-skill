#!/usr/bin/env node
// Turn an OpenAPI / Swagger spec into an API diagram as autolayout graph JSON.
// Direct port of openapiimports.py.
//
// Reads an OpenAPI 3 or Swagger 2 spec and emits one node per operation --
// coloured by HTTP method -- plus one node per component schema, with edges
// from each operation to the schemas it references (request/response
// bodies) and between schemas that nest one another. Feeds autolayout.mjs:
//
//   node openapiimports.mjs openapi.yaml -o graph.json
//   node autolayout.mjs graph.json -o api.drawio
//
// Operations are grouped by their first `tag` (falling back to the first
// path segment) with --group; --no-schemas drops the data-model nodes to
// show just the endpoint surface. $refs are resolved to their final name;
// only schemas defined under components/definitions become nodes, so
// external refs are ignored.
//
// The Python original parses .json directly with json.loads, and falls back
// to PyYAML for .yaml/.yml files or when JSON parsing fails. There is no
// YAML parser in the Node standard library and this port must add zero
// dependencies, so it uses the same JSON.parse strategy documented in
// composeimports.mjs: JSON is a valid YAML subset, so a JSON-formatted spec
// (any extension) parses correctly, while real YAML syntax fails with a
// clear "no YAML parser available" error -- matching the Python original's
// actual behavior in this environment, where PyYAML is also not installed.
//
// Usage: openapiimports.mjs <spec.json|spec.yaml> [-o graph.json]
//        [--direction TB|LR] [--group] [--no-schemas]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
// HTTP method -> [fill, stroke]. GET reads, POST creates, PUT/PATCH update, DELETE removes.
const METHOD_STYLE = {
  get: ["#dae8fc", "#6c8ebf"],
  post: ["#d5e8d4", "#82b366"],
  put: ["#ffe6cc", "#d79b00"],
  patch: ["#ffe6cc", "#d79b00"],
  delete: ["#f8cecc", "#b85450"],
};
const OTHER_STYLE = ["#f5f5f5", "#666666"];
const SCHEMA_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;";
const OP_EDGE = "edgeStyle=orthogonalEdgeStyle;html=1;rounded=0;fontSize=10;endArrow=open;";
const REF_EDGE =
  "edgeStyle=orthogonalEdgeStyle;html=1;rounded=0;fontSize=10;dashed=1;endArrow=open;strokeColor=#9673a6;";

function loadSpec(specPath) {
  const text = fs.readFileSync(specPath, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    die(
      "spec is not valid JSON, and no YAML parser is available (Node port has zero dependencies) -- feed a JSON-formatted OpenAPI/Swagger spec"
    );
  }
}

// Yield the final name of every $ref anywhere inside a spec fragment.
function* findRefs(obj) {
  if (Array.isArray(obj)) {
    for (const item of obj) yield* findRefs(item);
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$ref" && typeof v === "string") yield v.split("/").pop();
      else yield* findRefs(v);
    }
  }
}

function methodStyle(method) {
  const [fill, stroke] = METHOD_STYLE[method] || OTHER_STYLE;
  return `rounded=1;whiteSpace=wrap;html=1;align=left;spacingLeft=6;fillColor=${fill};strokeColor=${stroke};`;
}

function build(spec, group, noSchemas, direction) {
  const paths = spec.paths || {};
  // components.schemas (OpenAPI 3) or definitions (Swagger 2)
  const schemas = (spec.components || {}).schemas || spec.definitions || {};
  const wantSchemas = Object.keys(schemas).length > 0 && !noSchemas;
  const sid = {};
  for (const name of Object.keys(schemas)) sid[name] = `S:${name}`;

  const nodes = [];
  const edges = [];
  const seen = new Set();
  const addEdge = (src, dst, style) => {
    const key = `${src} ${dst}`;
    if (src !== dst && !seen.has(key)) {
      seen.add(key);
      edges.push({ source: src, target: dst, style, label: "" });
    }
  };

  let i = 0;
  for (const [p, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object" || Array.isArray(op)) continue;
      const oid = `op${i}`;
      i += 1;
      const summary = String(op.summary || op.operationId || "").trim();
      const head = `${method.toUpperCase()} ${p}`;
      const node = {
        id: oid,
        label: head + (summary ? `\n${summary}` : ""),
        style: methodStyle(method),
        width: Math.max(160, 8 * head.length + 20),
        height: 40,
      };
      if (group) {
        const tags = op.tags;
        const firstSeg = p.replace(/^\/+|\/+$/g, "").split("/")[0] || "root";
        node.group = Array.isArray(tags) && tags.length ? tags[0] : firstSeg;
      }
      nodes.push(node);
      if (wantSchemas) {
        // Python iterates a `set()` of ref names here, whose order is
        // non-deterministic across runs (hash randomization on strings) --
        // confirmed by running openapiimports.py against the same input
        // repeatedly and observing different edge orders. Sorting gives
        // deterministic, reproducible output, a strict improvement.
        for (const ref of [...new Set(findRefs(op))].sort()) {
          if (Object.prototype.hasOwnProperty.call(sid, ref)) addEdge(oid, sid[ref], OP_EDGE);
        }
      }
    }
  }

  if (wantSchemas) {
    for (const [name, schema] of Object.entries(schemas)) {
      const fields = schema && typeof schema === "object" ? schema.properties : null;
      const count = fields ? Object.keys(fields).length : 0;
      const node = {
        id: sid[name],
        label: name + (count ? `\n(${count} field${count !== 1 ? "s" : ""})` : ""),
        style: SCHEMA_STYLE,
        width: Math.max(140, 9 * name.length + 20),
        height: 40,
      };
      if (group) node.group = "schemas";
      nodes.push(node);
      for (const ref of [...new Set(findRefs(schema))].sort()) {
        if (Object.prototype.hasOwnProperty.call(sid, ref)) addEdge(sid[name], sid[ref], REF_EDGE);
      }
    }
  }

  return { direction, nodes, edges };
}

function main() {
  const a = parseArgs(
    {
      name: "openapiimports",
      usage: "Usage: openapiimports.mjs <spec.json|spec.yaml> [-o graph.json] [--direction TB|LR] [--group] [--no-schemas]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "LR" },
        group: {},
        "no-schemas": {},
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("the following arguments are required: spec");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const specPath = a._[0];
  if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) die(`${specPath} not found`);
  const spec = loadSpec(specPath) || {};
  if (!spec.paths || !Object.keys(spec.paths).length) die("no paths found (is this an OpenAPI/Swagger spec?)");

  const graph = build(spec, a.group, a["no-schemas"], a.direction);
  const text = JSON.stringify(graph, null, 2);
  if (a.output) {
    fs.writeFileSync(a.output, text, "utf8");
    process.stderr.write(`wrote ${a.output}\n`);
  } else {
    process.stdout.write(text);
  }
  const ops = graph.nodes.filter((n) => n.id.startsWith("op")).length;
  process.stderr.write(`${ops} operations, ${graph.nodes.length - ops} schemas, ${graph.edges.length} edges\n`);
}

main();

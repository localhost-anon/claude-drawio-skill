#!/usr/bin/env node
// Extract a Terraform configuration's resource graph as autolayout graph JSON.
// Direct port of tfimports.py.
//
// Parses .tf files with a small regex + brace-matching pass (no HCL library
// needed), builds resource-reference edges, and resolves each resource type
// to its official draw.io cloud icon via the bundled shape index (shapesearch.mjs).
//
// Usage: tfimports.mjs <dir-or-file.tf> [-o graph.json]
//        [--direction TB|LR] [--group] [--no-reduce] [--no-icons]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs, die } from "./lib/args.mjs";
import { INDEX, buildTagMap, matchTerm, search } from "./shapesearch.mjs";

// provider prefix of the resource type -> (icon query prefix, style predicate).
export const PROVIDERS = {
  aws: ["aws", (st) => st.includes("mxgraph.aws4")],
  azurerm: ["azure", (st) => st.includes("img/lib/azure2")],
  azuread: ["azure", (st) => st.includes("img/lib/azure2")],
  google: ["gcp", (st) => st.includes("editableCssRules")],
};

// Resource types whose derived query ("aws lambda function") misses or
// mis-hits the intended icon; values are the query that finds it.
export const QUERY_OVERRIDES = {
  aws_alb: "aws elastic load balancing",
  aws_apigatewayv2_api: "aws api gateway",
  aws_autoscaling_group: "aws ec2 auto scaling",
  aws_cloudwatch_log_group: "aws cloudwatch",
  aws_db_instance: "aws rds",
  aws_dynamodb_table: "aws dynamodb",
  aws_ecr_repository: "aws elastic container registry",
  aws_ecs_cluster: "aws elastic container service",
  aws_ecs_service: "aws elastic container service",
  aws_ecs_task_definition: "aws elastic container service",
  aws_efs_file_system: "aws elastic file system",
  aws_eks_cluster: "aws elastic kubernetes service",
  aws_elasticache_cluster: "aws elasticache",
  aws_iam_policy: "aws identity and access management",
  aws_instance: "aws ec2",
  aws_kms_key: "aws key management service",
  aws_lambda_function: "aws lambda",
  aws_lb: "aws elastic load balancing",
  aws_rds_cluster: "aws aurora",
  aws_s3_bucket: "aws simple storage service",
  aws_secretsmanager_secret: "aws secrets manager",
  aws_sfn_state_machine: "aws step functions",
  aws_sns_topic: "aws simple notification service",
  aws_sqs_queue: "aws simple queue service",
  azurerm_app_service: "azure app services",
  azurerm_application_gateway: "azure application gateways",
  azurerm_cosmosdb_account: "azure cosmos db",
  azurerm_kubernetes_cluster: "azure kubernetes services",
  azurerm_linux_function_app: "azure function apps",
  azurerm_linux_virtual_machine: "azure virtual machine",
  azurerm_linux_web_app: "azure app services",
  azurerm_mssql_database: "azure sql database",
  azurerm_mssql_server: "azure sql database",
  azurerm_servicebus_namespace: "azure service bus",
  azurerm_storage_account: "azure storage accounts",
  azurerm_virtual_network: "azure virtual networks",
  azurerm_windows_function_app: "azure function apps",
  azurerm_windows_virtual_machine: "azure virtual machine",
  azurerm_windows_web_app: "azure app services",
  google_cloudfunctions2_function: "gcp cloud functions",
  google_cloudfunctions_function: "gcp cloud functions",
  google_compute_instance: "gcp compute engine",
  google_container_cluster: "gcp kubernetes engine",
  google_redis_instance: "gcp memorystore",
  google_sql_database_instance: "gcp cloud sql",
  google_storage_bucket: "gcp cloud storage",
};

const COMMENT_RE = /\/\*[\s\S]*?\*\/|(?:#|\/\/)[^\n]*/g;
const BLOCK_RE = /^[ \t]*(resource|module)[ \t]+"([\w.-]+)"(?:[ \t]+"([\w.-]+)")?[ \t]*\{/gm;
const REF_RE = /\b([a-z][a-z0-9_]*\.[A-Za-z_][A-Za-z0-9_-]*)/g;

// Yield [kind, label1, label2, body] for resource/module blocks.
function* parseBlocks(text) {
  text = text.replace(COMMENT_RE, "");
  BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_RE.exec(text))) {
    let depth = 1;
    let i = BLOCK_RE.lastIndex;
    while (i < text.length && depth) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    yield [m[1], m[2], m[3], text.slice(BLOCK_RE.lastIndex, i - 1)];
    BLOCK_RE.lastIndex = i;
  }
}

export class IconResolver {
  constructor() {
    if (!fs.existsSync(INDEX)) throw new Error(`shape index not found at ${INDEX}`);
    this.shapes = JSON.parse(zlib.gunzipSync(fs.readFileSync(INDEX)).toString("utf8"));
    this.tagMap = buildTagMap(this.shapes);
    this.cache = new Map();
  }

  // Style strings of shapes whose tags match EVERY query word (AND, not OR) —
  // a partial match here means a visibly wrong icon, so results outside this
  // set are rejected and the caller's back-off handles the miss.
  _andStyles(words) {
    let idxs = null;
    for (const t of words) {
      const [exact, phonetic] = matchTerm(this.tagMap, t);
      const s = new Set([...exact, ...phonetic]);
      idxs = idxs === null ? s : new Set([...idxs].filter((x) => s.has(x)));
      if (idxs.size === 0) return new Set();
    }
    return new Set([...idxs].map((i) => this.shapes[i].style));
  }

  resolve(rtype) {
    if (this.cache.has(rtype)) return this.cache.get(rtype);
    const provider = rtype.split("_", 1)[0];
    let hit = null;
    if (Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
      const [prefix, want] = PROVIDERS[provider];
      const rest = rtype.slice(provider.length + 1);
      let words = (QUERY_OVERRIDES[rtype] || `${prefix} ${rest.replace(/_/g, " ")}`).split(/\s+/);
      // Back off one trailing word at a time.
      while (words.length > 1 && hit === null) {
        const allowed = this._andStyles(words);
        const good = search(this.shapes, this.tagMap, words.join(" "), 40).filter(
          (r) => allowed.has(r.style) && want(r.style) && !r.style.toLowerCase().includes("group")
        );
        // Prefer aws4 service icons (resIcon=) over scenario glyphs.
        hit = good.find((r) => r.style.includes("resIcon=")) || good[0] || null;
        words = words.slice(0, -1);
      }
    }
    if (hit && Math.max(hit.w, hit.h) < 44) {
      // Some sets (GCP) ship tiny nominal sizes; scale up so the icon is not
      // dwarfed by its label. aspect=fixed keeps the ratio.
      const f = 48 / Math.max(hit.w, hit.h);
      hit = { ...hit, w: Math.round(hit.w * f), h: Math.round(hit.h * f) };
    }
    this.cache.set(rtype, hit);
    return hit;
  }
}

// Drop edges implied by a longer path, via Graphviz `tred`.
export function transitiveReduce(nodes, edges) {
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const dot = "digraph{" + edges.map(([s, t]) => `${idx.get(s)}->${idx.get(t)};`).join("") + "}";
  let res;
  try {
    res = spawnSync("tred", { input: dot, encoding: "utf8" });
  } catch (e) {
    process.stderr.write(`warning: tred unavailable, keeping all edges (${e.message})\n`);
    return edges;
  }
  if (!res || res.error || res.status !== 0) {
    const msg = res && res.error ? res.error.message : "tred not found";
    process.stderr.write(`warning: tred unavailable, keeping all edges (${msg})\n`);
    return edges;
  }
  const rev = new Map(nodes.map((n, i) => [i, n]));
  const out = [];
  for (const m of res.stdout.matchAll(/(\d+)\s*->\s*(\d+)/g)) out.push([rev.get(Number(m[1])), rev.get(Number(m[2]))]);
  return out;
}

function discoverFiles(p) {
  if (fs.statSync(p).isFile()) return [p];
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".tf")) out.push(full);
    }
  };
  walk(p);
  return out.sort();
}

function main() {
  const a = parseArgs(
    {
      name: "tfimports",
      usage: "Usage: tfimports.mjs <dir-or-file.tf> [-o graph.json] [--direction TB|LR] [--group] [--no-reduce] [--no-icons]",
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
  if (a._.length !== 1) die("the following arguments are required: path");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const files = discoverFiles(a._[0]);
  const blocks = [];
  for (const f of files) blocks.push(...parseBlocks(fs.readFileSync(f, "utf8")));
  if (!blocks.length) {
    process.stderr.write(`error: no resource/module blocks found under ${a._[0]}\n`);
    process.exit(1);
  }

  const declared = new Map(); // nid -> [rtype-or-null, name, body]
  for (const [kind, l1, l2, body] of blocks) {
    const nid = kind === "resource" ? `${l1}.${l2}` : `module.${l1}`;
    declared.set(nid, [kind === "resource" ? l1 : null, l2 || l1, body]);
  }

  const edgeSet = new Set();
  const pairs = [];
  for (const [nid, [, , body]] of declared) {
    for (const m of body.matchAll(REF_RE)) {
      const ref = m[1];
      if (declared.has(ref) && ref !== nid) {
        const key = `${nid} ${ref}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          pairs.push([nid, ref]);
        }
      }
    }
  }
  pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const raw = pairs.length;
  let edges = pairs;
  if (!a["no-reduce"]) edges = transitiveReduce([...declared.keys()], pairs);

  const resolver = a["no-icons"] ? null : new IconResolver();
  const unmatched = [];
  const nodes = [];
  for (const [nid, [rtype, name]] of declared) {
    const node = { id: nid, label: name };
    const icon = resolver && rtype ? resolver.resolve(rtype) : null;
    if (icon) {
      node.style = icon.style;
      node.width = icon.w;
      node.height = icon.h;
    } else {
      node.label = rtype ? `${name}\n${rtype}` : `module ${name}`;
      if (rtype) unmatched.push(rtype);
    }
    if (a.group && rtype && rtype.includes("_")) node.group = rtype.split("_")[1];
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
  const text = JSON.stringify(graph, null, 2);
  if (a.output) {
    fs.writeFileSync(a.output, text, "utf8");
    process.stderr.write(`wrote ${a.output}\n`);
  } else {
    process.stdout.write(text);
  }
  const note = a["no-reduce"] ? "" : ` (reduced from ${raw})`;
  process.stderr.write(`${nodes.length} nodes, ${edges.length} edges${note}\n`);
  if (unmatched.length) {
    process.stderr.write("no icon for: " + [...new Set(unmatched)].sort().join(", ") + "\n");
  }
}

function isMainModule() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}
if (isMainModule()) main();

#!/usr/bin/env node
// Extract a Kubernetes manifest set's object graph as autolayout graph JSON.
// Direct port of k8simports.py.
//
// JSON input (single object, or `kind: List`) parses with Node's built-in
// JSON.parse. .yaml/.yml files need PyYAML in the Python original -- since
// there is no YAML parser in the Node standard library and this port must
// add zero dependencies, YAML files fail with a clear error instead (the
// Python original is also unusable on YAML input in this environment,
// since PyYAML is not installed here either).
//
// Usage: k8simports.mjs <dir-or-manifest...|-> [-o graph.json]
//        [--direction TB|LR] [--group] [--no-icons]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parseArgs, die } from "./lib/args.mjs";

// Object kind -> prIcon name inside the mxgraph.kubernetes.icon2 shape set.
const KIND_ICON = {
  ClusterRole: "c-role",
  ClusterRoleBinding: "crb",
  ConfigMap: "cm",
  CronJob: "cronjob",
  CustomResourceDefinition: "crd",
  DaemonSet: "ds",
  Deployment: "deploy",
  Endpoints: "ep",
  HorizontalPodAutoscaler: "hpa",
  Ingress: "ing",
  Job: "job",
  Namespace: "ns",
  NetworkPolicy: "netpol",
  Node: "node",
  PersistentVolume: "pv",
  PersistentVolumeClaim: "pvc",
  Pod: "pod",
  ReplicaSet: "rs",
  Role: "role",
  RoleBinding: "rb",
  Secret: "secret",
  Service: "svc",
  ServiceAccount: "sa",
  StatefulSet: "sts",
  StorageClass: "sc",
};
const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"]);
const INDEX = path.join(path.dirname(import.meta.dirname), "data", "shape-index.json.gz");

// prIcon name -> [style, w, h] from the bundled official shape index.
function iconStyles() {
  const shapes = JSON.parse(zlib.gunzipSync(fs.readFileSync(INDEX)).toString("utf8"));
  const out = {};
  for (const s of shapes) {
    const st = s.style;
    const m = st.match(/prIcon=([\w-]+)/);
    // Skip the kubernetesLabel=1 variants (they paint the kind name into the
    // icon; our node label already names the object below it).
    if (st.includes("mxgraph.kubernetes.icon2") && m && !st.includes("kubernetesLabel")) {
      if (!Object.prototype.hasOwnProperty.call(out, m[1])) out[m[1]] = [st, s.w, s.h];
    }
  }
  return out;
}

function discoverManifestFiles(paths) {
  const files = [];
  for (const p of paths) {
    if (p !== "-" && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
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
          else if (/\.(yaml|yml|json)$/.test(e.name)) files.push(full);
        }
      };
      walk(p);
    } else {
      files.push(p);
    }
  }
  return files;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function loadManifests(paths) {
  const files = discoverManifestFiles(paths);
  const objs = [];
  for (const p of [...new Set(files)].sort()) {
    let docs;
    if (p === "-") {
      docs = [JSON.parse(readStdin())];
    } else if (p.endsWith(".json")) {
      docs = [JSON.parse(fs.readFileSync(p, "utf8"))];
    } else {
      die(`${p} is YAML but no YAML parser is available (Node port has zero dependencies) -- feed JSON from \`kubectl get ... -o json\``);
    }
    for (const doc of docs) {
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) continue;
      if (doc.kind === "List") {
        for (const item of doc.items || []) {
          if (typeof item === "object" && item !== null && !Array.isArray(item)) objs.push(item);
        }
      } else {
        objs.push(doc);
      }
    }
  }
  return objs.filter((o) => o.kind && (o.metadata || {}).name);
}

function podSpec(obj) {
  let spec = obj.spec || {};
  if (obj.kind === "Pod") return spec;
  if (obj.kind === "CronJob") spec = (spec.jobTemplate || {}).spec || {};
  return (spec.template || {}).spec || {};
}

function podLabels(obj) {
  if (obj.kind === "Pod") return (obj.metadata || {}).labels || {};
  let spec = obj.spec || {};
  if (obj.kind === "CronJob") spec = (spec.jobTemplate || {}).spec || {};
  return ((spec.template || {}).metadata || {}).labels || {};
}

// [kind, name] pairs a pod spec references via env/envFrom/volumes.
function mountedRefs(pspec) {
  const seen = new Set();
  const refs = [];
  const add = (kind, name) => {
    const key = kind + "/" + name;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push([kind, name]);
    }
  };
  for (const c of [...(pspec.containers || []), ...(pspec.initContainers || [])]) {
    for (const e of c.env || []) {
      const vf = e.valueFrom || {};
      for (const [key, kind] of [
        ["configMapKeyRef", "ConfigMap"],
        ["secretKeyRef", "Secret"],
      ]) {
        if ((vf[key] || {}).name) add(kind, vf[key].name);
      }
    }
    for (const e of c.envFrom || []) {
      for (const [key, kind] of [
        ["configMapRef", "ConfigMap"],
        ["secretRef", "Secret"],
      ]) {
        if ((e[key] || {}).name) add(kind, e[key].name);
      }
    }
  }
  for (const v of pspec.volumes || []) {
    if ((v.configMap || {}).name) add("ConfigMap", v.configMap.name);
    if ((v.secret || {}).secretName) add("Secret", v.secret.secretName);
    if ((v.persistentVolumeClaim || {}).claimName) add("PersistentVolumeClaim", v.persistentVolumeClaim.claimName);
  }
  return refs;
}

// Service names referenced by an Ingress (networking.k8s.io/v1 + legacy).
function ingressBackends(obj) {
  const names = new Set();
  const stack = [obj.spec || {}];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      stack.push(...cur);
    } else if (cur && typeof cur === "object") {
      const svc = cur.service;
      if (svc && typeof svc === "object" && svc.name) names.add(svc.name);
      if (typeof cur.serviceName === "string") names.add(cur.serviceName);
      stack.push(...Object.values(cur));
    }
  }
  return names;
}

function main() {
  const a = parseArgs(
    {
      name: "k8simports",
      usage: "Usage: k8simports.mjs <dir-or-manifest...|-> [-o graph.json] [--direction TB|LR] [--group] [--no-icons]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "TB" },
        group: {},
        "no-icons": {},
      },
    },
    process.argv.slice(2)
  );
  if (a._.length < 1) die("the following arguments are required: paths");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const objs = loadManifests(a._);
  if (!objs.length) {
    process.stderr.write("error: no Kubernetes objects found (need kind + metadata.name)\n");
    process.exit(1);
  }

  const keyOf = (obj) => {
    const meta = obj.metadata || {};
    return [meta.namespace || "", obj.kind, meta.name];
  };
  // Kubernetes names/namespaces/kinds never contain "/", so joining with it
  // is an unambiguous, plain-text Map key (avoids control-byte delimiters).
  const keyStr = (k) => k.join("/");

  const byKey = new Map(); // keyStr -> [key, obj]
  for (const o of objs) {
    const k = keyOf(o);
    byKey.set(keyStr(k), [k, o]);
  }
  const icons = a["no-icons"] ? {} : iconStyles();

  const edges = new Map(); // "srcKeyStr>tgtKeyStr" -> [srcKey, tgtKey]
  for (const [, [k, obj]] of byKey) {
    const [ns, kind] = k;

    const link = (tkind, tname) => {
      const tk = [ns, tkind, tname];
      const tks = keyStr(tk);
      if (byKey.has(tks) && tks !== keyStr(k)) edges.set(`${keyStr(k)}>${tks}`, [k, tk]);
    };

    if (kind === "Ingress") {
      for (const svc of ingressBackends(obj)) link("Service", svc);
    } else if (kind === "Service") {
      const sel = (obj.spec || {}).selector || {};
      const selEntries = Object.entries(sel);
      if (selEntries.length) {
        for (const [, [tk, target]] of byKey) {
          if (tk[0] === ns && WORKLOADS.has(tk[1])) {
            const labels = podLabels(target);
            if (selEntries.every(([sk, sv]) => labels[sk] === sv)) {
              edges.set(`${keyStr(k)}>${keyStr(tk)}`, [k, tk]);
            }
          }
        }
      }
    } else if (WORKLOADS.has(kind)) {
      for (const [tkind, tname] of mountedRefs(podSpec(obj))) link(tkind, tname);
    } else if (kind === "HorizontalPodAutoscaler") {
      const ref = (obj.spec || {}).scaleTargetRef || {};
      if (ref.kind && ref.name) link(ref.kind, ref.name);
    }
  }

  const nid = (k) => `${k[0] ? k[0] + "/" : ""}${k[1]}/${k[2]}`;

  const nodes = [];
  for (const [, [k]] of byKey) {
    const [ns, kind, name] = k;
    const node = { id: nid(k), label: name };
    const icon = icons[KIND_ICON[kind] || ""];
    if (icon) {
      node.style = icon[0];
      node.width = icon[1];
      node.height = icon[2];
    } else {
      node.label = `${name}\n${kind}`;
    }
    if (a.group && ns) node.group = ns;
    nodes.push(node);
  }

  // Python sorts raw (ns,kind,name) tuple pairs, which is NOT necessarily the
  // same order as sorting on the rendered nid() string (nid() drops the
  // "ns/" prefix when namespace is empty). Compare on the raw [src, tgt]
  // triples directly to match that exactly.
  const cmpTriple = (x, y) => {
    for (let i = 0; i < 3; i++) {
      if (x[i] < y[i]) return -1;
      if (x[i] > y[i]) return 1;
    }
    return 0;
  };
  const edgeList = [...edges.values()].sort(([xs, xt], [ys, yt]) => cmpTriple(xs, ys) || cmpTriple(xt, yt));

  const graph = {
    direction: a.direction,
    nodes,
    edges: edgeList.map(([s, t]) => ({ source: nid(s), target: nid(t) })),
  };
  if (Object.keys(icons).length) {
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
  process.stderr.write(`${nodes.length} objects, ${edgeList.length} edges\n`);
}

main();

#!/usr/bin/env node
// Extract a CI pipeline (GitHub Actions / GitLab CI) as autolayout graph JSON.
// Direct port of ciimports.py.
//
// GitHub Actions: every job becomes a node (label: name, runner, matrix
// size, reusable-workflow target), `needs:` become edges, and each workflow
// gets a trigger node (its `on:` events) feeding the jobs that have no
// `needs`. Given a repo root, all of `.github/workflows/*.yml|yaml` are read
// and each workflow is boxed in its own container.
//
// GitLab CI (`.gitlab-ci.yml`, auto-detected): jobs become nodes grouped by
// stage; edges come from `needs:`, and jobs without `needs` inherit the
// stage DAG (every job of the previous stage), matching GitLab's execution
// order.
//
//   node ciimports.mjs .                          # repo root -> all workflows
//   node ciimports.mjs .github/workflows/ci.yml -o graph.json
//   node autolayout.mjs graph.json -o pipeline.drawio
//
// The Python original requires PyYAML unconditionally and refuses to run at
// all without it -- there is no JSON fallback in the original. This port
// must add zero dependencies and Node's standard library has no YAML
// parser, so (as with composeimports.mjs / openapiimports.mjs) it relies on
// JSON being a valid YAML subset: JSON.parse succeeds for a workflow file
// written as pure JSON and fails -- with a per-file "skipping" warning,
// mirroring the original's yaml.YAMLError handling -- for real YAML syntax.
// (Real GitHub Actions/GitLab CI files are near-universally YAML, so this
// is a narrower fixture-only affordance than the other YAML-touching ports,
// but it is a genuine, testable improvement over the Python original, which
// cannot run on ANY input in this environment since PyYAML is absent here.)
// Note: PyYAML's YAML-1.1 `on:` quirk (a bare `on` key parses as boolean
// True) never triggers for JSON input, since JSON always quotes keys --
// matching what real yaml.safe_load would also do for a JSON-shaped file.
//
// Usage: ciimports.mjs <repo-root | workflow.yml ...> [-o graph.json]
//        [--direction TB|LR]
import fs from "node:fs";
import path from "node:path";
import { parseArgs, die } from "./lib/args.mjs";

const JOB_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;";
const REUSE_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;";
const TRIGGER_STYLE = "ellipse;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;";

const GITLAB_RESERVED = new Set([
  "stages",
  "variables",
  "workflow",
  "default",
  "include",
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
  "pages",
]);

// Workflow files for a path: file(s) as-is, or a repo root via .github/workflows.
function findWorkflows(p) {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return [p];
  const wfdir = path.join(p, ".github", "workflows");
  let files = [];
  if (fs.existsSync(wfdir) && fs.statSync(wfdir).isDirectory()) {
    files = fs
      .readdirSync(wfdir)
      .filter((f) => /\.(yml|yaml)$/.test(f))
      .map((f) => path.join(wfdir, f))
      .sort();
  }
  const gitlab = path.join(p, ".gitlab-ci.yml");
  if (fs.existsSync(gitlab) && fs.statSync(gitlab).isFile()) files.push(gitlab);
  if (!files.length) die(`no workflow files under ${p}`);
  return files;
}

function matrixSize(strategy) {
  let n = 1;
  const matrix = (strategy || {}).matrix || {};
  if (typeof matrix !== "object" || matrix === null || Array.isArray(matrix)) return 0; // dynamic (fromJSON) -- unknown
  for (const [key, vals] of Object.entries(matrix)) {
    if (key !== "include" && key !== "exclude" && Array.isArray(vals)) n *= vals.length;
  }
  n += (matrix.include || []).length - (matrix.exclude || []).length;
  return Math.max(n, 1);
}

// One GitHub Actions workflow -> [nodes, edges].
function parseActions(spec, wfId, group) {
  const nodes = [];
  const edges = [];
  const on = Object.prototype.hasOwnProperty.call(spec, "on") ? spec.on : {};
  let events;
  if (on && typeof on === "object" && !Array.isArray(on)) events = Object.keys(on).sort();
  else if (typeof on === "string") events = [on];
  else events = [...(Array.isArray(on) ? on : [])].sort();
  const trigId = `${wfId}//trigger`;
  nodes.push({
    id: trigId,
    label: "on: " + (events.join(", ") || "?"),
    style: TRIGGER_STYLE,
    width: 160,
    height: 50,
    group,
  });
  const jobs = spec.jobs || {};
  for (const [jid, jobRaw] of Object.entries(jobs)) {
    const job = jobRaw || {};
    const lines = [job.name || jid];
    let style;
    if (job.uses) {
      lines.push("uses: " + path.basename(String(job.uses)));
      style = REUSE_STYLE;
    } else {
      style = JOB_STYLE;
      const runner = job["runs-on"];
      if (runner) lines.push(typeof runner === "string" ? runner : Array.isArray(runner) ? runner.join(", ") : String(runner));
    }
    const n = matrixSize(job.strategy);
    if (n > 1) lines.push(`matrix ×${n}`);
    else if (n === 0) lines.push("matrix (dynamic)");
    nodes.push({ id: `${wfId}//${jid}`, label: lines.join("\n"), style, width: 180, height: 60, group });
    let needs = job.needs || [];
    needs = typeof needs === "string" ? [needs] : needs;
    for (const dep of needs) {
      if (Object.prototype.hasOwnProperty.call(jobs, dep)) edges.push({ source: `${wfId}//${dep}`, target: `${wfId}//${jid}` });
    }
    if (!needs.length) edges.push({ source: trigId, target: `${wfId}//${jid}` });
  }
  return [nodes, edges];
}

// A .gitlab-ci.yml -> [nodes, edges]; jobs grouped by stage.
function parseGitlab(spec, wfId, groupPrefix) {
  const stages = spec.stages || ["build", "test", "deploy"];
  const jobs = {};
  for (const [k, v] of Object.entries(spec)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !GITLAB_RESERVED.has(k) &&
      !k.startsWith(".") &&
      ("script" in v || "trigger" in v || "extends" in v || "stage" in v)
    ) {
      jobs[k] = v;
    }
  }
  const nodes = [];
  const edges = [];
  const byStage = {};
  for (const [jid, job] of Object.entries(jobs)) {
    const stage = job.stage || "test";
    (byStage[stage] || (byStage[stage] = [])).push(jid);
    nodes.push({ id: `${wfId}//${jid}`, label: jid, style: JOB_STYLE, width: 160, height: 50, group: `${groupPrefix}${stage}` });
  }
  const order = stages.filter((s) => Object.prototype.hasOwnProperty.call(byStage, s));
  for (const [jid, job] of Object.entries(jobs)) {
    let needs = (job.needs || []).map((n) => (n && typeof n === "object" ? n.job : n));
    needs = needs.filter((n) => Object.prototype.hasOwnProperty.call(jobs, n));
    if (needs.length) {
      for (const n of needs) edges.push({ source: `${wfId}//${n}`, target: `${wfId}//${jid}` });
    } else {
      // stage DAG: all jobs of the previous stage
      const stage = job.stage || "test";
      const i = order.includes(stage) ? order.indexOf(stage) : 0;
      if (i > 0) {
        for (const p of byStage[order[i - 1]]) edges.push({ source: `${wfId}//${p}`, target: `${wfId}//${jid}` });
      }
    }
  }
  return [nodes, edges];
}

function main() {
  const a = parseArgs(
    {
      name: "ciimports",
      usage: "Usage: ciimports.mjs <repo-root | workflow.yml ...> [-o graph.json] [--direction TB|LR]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "LR" },
      },
    },
    process.argv.slice(2)
  );
  if (a._.length < 1) die("the following arguments are required: paths");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const files = a._.flatMap(findWorkflows);
  const nodes = [];
  const edges = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    let spec;
    try {
      spec = JSON.parse(text) || {};
    } catch (exc) {
      process.stderr.write(`warning: skipping ${file}: ${exc.message}\n`);
      continue;
    }
    const base = path.basename(file);
    const wfId = base.replace(/\.[^.]+$/, "");
    let n, e;
    if (base === ".gitlab-ci.yml" || (!("jobs" in spec) && "stages" in spec)) {
      const groupPrefix = files.length === 1 ? "stage: " : `${wfId} / stage: `;
      [n, e] = parseGitlab(spec, wfId, groupPrefix);
    } else if (spec.jobs) {
      const group = files.length > 1 ? spec.name || wfId : null;
      [n, e] = parseActions(spec, wfId, group);
    } else {
      process.stderr.write(`warning: ${file} has no jobs — skipped\n`);
      continue;
    }
    nodes.push(...n);
    edges.push(...e);
  }
  if (!nodes.length) die("no CI jobs found");

  const graph = { direction: a.direction, nodes, edges };
  const text = JSON.stringify(graph, null, 2);
  if (a.output) {
    fs.writeFileSync(a.output, text, "utf8");
    process.stderr.write(`wrote ${a.output}\n`);
  } else {
    process.stdout.write(text);
  }
  process.stderr.write(`${nodes.length} nodes, ${edges.length} edges from ${files.length} file(s)\n`);
}

main();

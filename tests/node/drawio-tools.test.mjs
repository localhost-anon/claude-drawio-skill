// Port of the drawio-export portion of TestImportersCli from
// tests/test_scripts.py.orig (explain, drawio2mermaid, svgflow, ciimports).
// All CLI-only; driven via subprocess.
//
// SKIPPED: drawio2pptx deck-building test, drawiohtml --viewer CLI test —
// both require the `drawio` CLI to rasterize/export pages to SVG/PNG, and it
// is not installed on this system (`which drawio` -> not found). This
// matches pytest's OWN skip behaviour for the same missing-binary case.
// See drawiohtml.test.mjs for the directly-portable (import-based) pieces.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawiotools-"));

function run(script, args) {
  return execFileSync("node", [path.join(SCRIPTS, script), ...args], { encoding: "utf8" });
}

const page = path.join(dir, "page.drawio");
fs.writeFileSync(
  page,
  `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="A" style="rounded=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="b" value="B" style="rhombus;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" value="go" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`
);

test("explain: renders a components + relations markdown summary", () => {
  const out = run("explain.mjs", [page]);
  assert.match(out, /### Components \(2\)/);
  assert.match(out, /- A/);
  assert.match(out, /_decision_/);
  assert.match(out, /### Relations \(1\)/);
  assert.match(out, /A .*go.*B/);
});

test("drawio2mermaid: renders a flowchart with a decision diamond and labeled edge", () => {
  const out = run("drawio2mermaid.mjs", [page]);
  assert.match(out, /flowchart TD/);
  assert.match(out, /\["A"\]/);
  assert.match(out, /\{"B"\}/); // rhombus -> mermaid decision diamond syntax
  assert.match(out, /-->\|"go"\|/);
});

test("svgflow: animates only paths marked pointer-events=stroke (real edges)", () => {
  const svg = path.join(dir, "flow.svg");
  fs.writeFileSync(
    svg,
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
<path d="M10 10 L100 10" fill="none" stroke="#000" pointer-events="stroke"/>
<path d="M0 0 L20 20 L0 20 Z" fill="#000" pointer-events="all"/>
</svg>`
  );
  const out = path.join(dir, "flow-out.svg");
  const r = spawnSync("node", [path.join(SCRIPTS, "svgflow.mjs"), svg, "-o", out], { encoding: "utf8" });
  assert.match(r.stderr, /1 edge animated/);
  const written = fs.readFileSync(out, "utf8");
  assert.match(written, /<path class="dio-flow"[^>]*pointer-events="stroke"/);
  assert.doesNotMatch(written, /pointer-events="all"[^>]*class="dio-flow"/);
});

test("svgflow: --reverse flips the dashoffset sign", () => {
  const svg = path.join(dir, "flow2.svg");
  fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 0" pointer-events="stroke"/></svg>`);
  const fwd = path.join(dir, "fwd.svg");
  const rev = path.join(dir, "rev.svg");
  execFileSync("node", [path.join(SCRIPTS, "svgflow.mjs"), svg, "-o", fwd], { encoding: "utf8" });
  execFileSync("node", [path.join(SCRIPTS, "svgflow.mjs"), svg, "-o", rev, "--reverse"], { encoding: "utf8" });
  const fwdOffset = fs.readFileSync(fwd, "utf8").match(/stroke-dashoffset:(-?\d+)/)[1];
  const revOffset = fs.readFileSync(rev, "utf8").match(/stroke-dashoffset:(-?\d+)/)[1];
  assert.equal(Number(fwdOffset), -Number(revOffset));
});

test("svgflow: no-edge input reports zero animated with a warning, exits 0", () => {
  const svg = path.join(dir, "noedge.svg");
  fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="5" height="5"/></svg>`);
  const out = path.join(dir, "noedge-out.svg");
  const r = spawnSync("node", [path.join(SCRIPTS, "svgflow.mjs"), svg, "-o", out], { encoding: "utf8" });
  assert.match(r.stderr, /0 edges animated|no edges found/);
});

test("ciimports: builds a job DAG from a GitHub Actions workflow with matrix/needs edges", () => {
  const out = path.join(dir, "ci.json");
  const stderr = execFileSync("node", [path.join(SCRIPTS, "ciimports.mjs"), path.join(FIXTURES, "ci", "workflow.json"), "-o", out], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
  const g = JSON.parse(fs.readFileSync(out, "utf8"));
  const labels = g.nodes.map((n) => n.id || n.label);
  assert.ok(labels.some((l) => /trigger/.test(l)));
  assert.ok(labels.some((l) => /lint/.test(l)));
  assert.ok(labels.some((l) => /test/.test(l)));
  assert.ok(labels.some((l) => /deploy/.test(l)));
  // test needs lint, deploy needs [lint, test] -> at least those 3 dependency edges plus the trigger edges.
  assert.ok(g.edges.length >= 4);
});

test("ciimports: rejects real YAML syntax (no bundled YAML parser)", () => {
  const yml = path.join(dir, "workflow.yml");
  fs.writeFileSync(yml, "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n");
  assert.throws(() => execFileSync("node", [path.join(SCRIPTS, "ciimports.mjs"), yml, "-o", path.join(dir, "x.json")], { encoding: "utf8" }));
});

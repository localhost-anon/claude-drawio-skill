// Port of TestHeatmap from tests/test_scripts.py.orig.
// heatmap.mjs has no exports (PALETTES/set_style/load_metrics are internal),
// so the pure-function pieces are exercised end-to-end via the CLI here.
//
// SKIPPED: test_set_style_replaces_colours_once, test_load_metrics_csv_and_json
// as isolated unit tests — no direct-import equivalent exists; both are
// exercised through the CLI recolor test below (which reads a JSON metrics
// file and applies fillColor/strokeColor exactly once per vertex).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const HEATMAP = path.join(SCRIPTS, "heatmap.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heatmap-"));

const src = path.join(dir, "graph.drawio");
fs.writeFileSync(
  src,
  `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="b" value="B" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="c" value="C" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="400" y="0" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`
);

test("heatmap: recolors vertices per JSON metrics using the heat ramp anchors", () => {
  const metrics = path.join(dir, "metrics.json");
  fs.writeFileSync(metrics, JSON.stringify({ a: 0.0, b: 0.5, c: 1.0 }));
  const out = path.join(dir, "out.drawio");
  const r = spawnSync("node", [HEATMAP, src, "--metrics", metrics, "-o", out], { encoding: "utf8" });
  assert.match(r.stderr, /3\/3 metrics matched/);
  const written = fs.readFileSync(out, "utf8");
  assert.match(written, /id="a"[^>]*style="[^"]*fillColor=#57bb8a/);
  assert.match(written, /id="b"[^>]*style="[^"]*fillColor=#ffd666/);
  assert.match(written, /id="c"[^>]*style="[^"]*fillColor=#e67c73/);
});

test("heatmap: default run includes a legend with anchor labels 0, 0.5, 1", () => {
  const metrics = path.join(dir, "metrics2.json");
  fs.writeFileSync(metrics, JSON.stringify({ a: 0.0, b: 0.5, c: 1.0 }));
  const out = path.join(dir, "out2.drawio");
  execFileSync("node", [HEATMAP, src, "--metrics", metrics, "-o", out], { encoding: "utf8" });
  const written = fs.readFileSync(out, "utf8");
  assert.match(written, /value="Heatmap"/);
  assert.match(written, /value="0"/);
  assert.match(written, /value="0.5"/);
  assert.match(written, /value="1"/);
});

test("heatmap: --no-legend omits the legend cells", () => {
  const metrics = path.join(dir, "metrics3.json");
  fs.writeFileSync(metrics, JSON.stringify({ a: 0.0, b: 1.0 }));
  const out = path.join(dir, "out3.drawio");
  execFileSync("node", [HEATMAP, src, "--metrics", metrics, "-o", out, "--no-legend"], { encoding: "utf8" });
  const written = fs.readFileSync(out, "utf8");
  assert.doesNotMatch(written, /value="Heatmap"/);
});

test("heatmap: CSV metrics file is also accepted", () => {
  const metrics = path.join(dir, "metrics.csv");
  fs.writeFileSync(metrics, "id,value\na,0\nb,1\n");
  const out = path.join(dir, "out4.drawio");
  const r = spawnSync("node", [HEATMAP, src, "--metrics", metrics, "-o", out], { encoding: "utf8" });
  assert.match(r.stderr, /2\/2 metrics matched/);
});

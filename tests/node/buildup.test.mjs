// Port of tests/test_buildup.py to node:test.
// buildup.mjs doesn't do fresh layout (it replays existing geometry), so the
// gate here is unit-level parity with the deterministic pieces: parsePage,
// classify, boundingBox, revealOrder, revealSteps, buildHtml. The full CLI
// path (TestBuildupCli in the Python suite) needs the draw.io CLI to export
// PNG frames; it is confirmed absent from PATH in this environment, so that
// end-to-end test is skipped here too, matching Python's own
// self.skipTest("draw.io CLI not installed") behavior — see task-4-brief rule 4(d).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parsePage,
  classify,
  boundingBox,
  revealOrder,
  revealSteps,
  buildHtml,
} from "../../skills/drawio-skill/scripts/buildup.mjs";

function drawioOnPath() {
  try {
    execFileSync("drawio", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Two independent sources a, b both feeding sink c.
const PAGE =
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="a" value="A" vertex="1" parent="1">' +
  '<mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="b" value="B" vertex="1" parent="1">' +
  '<mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="c" value="C" vertex="1" parent="1">' +
  '<mxGeometry x="400" y="0" width="80" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="e1" edge="1" parent="1" source="a" target="c">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>' +
  '<mxCell id="e2" edge="1" parent="1" source="b" target="c">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>';
const DOC = `<mxfile><diagram name="P1"><mxGraphModel><root>${PAGE}</root></mxGraphModel></diagram></mxfile>`;

function writeTemp(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildup-"));
  const p = path.join(dir, "x.drawio");
  fs.writeFileSync(p, doc, "utf8");
  return p;
}

test("parse+classify: leaves and edges", () => {
  const p = writeTemp(DOC);
  const { cells } = parsePage(p);
  const { leaves, containers, edges } = classify(cells);
  assert.deepEqual(leaves, ["a", "b", "c"]);
  assert.deepEqual(containers, new Set());
  assert.deepEqual(edges, [
    ["e1", "a", "c"],
    ["e2", "b", "c"],
  ]);
});

test("bounding box from full diagram", () => {
  const p = writeTemp(DOC);
  const { cells } = parsePage(p);
  const [width, height] = boundingBox(cells);
  assert.equal(width, 520); // rightmost cell C: x=400,w=80 -> 480 + 40 margin
  assert.equal(height, 80); // tallest: 0+40 + 40 margin
});

test("reveal order: sources precede targets (diamond)", () => {
  // a,b -> c -> d
  const order = revealOrder(
    ["a", "b", "c", "d"],
    [
      ["a", "c"],
      ["b", "c"],
      ["c", "d"],
    ]
  );
  assert.deepEqual(new Set(order), new Set(["a", "b", "c", "d"]));
  assert.ok(order.indexOf("a") < order.indexOf("c"));
  assert.ok(order.indexOf("b") < order.indexOf("c"));
  assert.ok(order.indexOf("c") < order.indexOf("d"));
});

test("reveal order: cycle falls back to document order", () => {
  const order = revealOrder(
    ["x", "y"],
    [
      ["x", "y"],
      ["y", "x"],
    ]
  );
  assert.deepEqual(order, ["x", "y"]);
});

test("reveal steps: edge step is at or after both endpoints", () => {
  const order = revealOrder(
    ["a", "b", "c", "d"],
    [
      ["a", "c"],
      ["b", "c"],
      ["c", "d"],
    ]
  );
  const edgeList = [
    ["e1", "a", "c"],
    ["e2", "b", "c"],
    ["e3", "c", "d"],
  ];
  const { nodeStep, edgeStep } = revealSteps(order, edgeList);
  for (const [eid, s, t] of edgeList) {
    assert.ok(edgeStep.get(eid) >= nodeStep.get(s));
    assert.ok(edgeStep.get(eid) >= nodeStep.get(t));
  }
  assert.ok(edgeStep.get("e3") >= nodeStep.get("c"));
});

test("build html: self-contained, embeds frames, exposes player controls", () => {
  const frames = [
    [Buffer.from("\x89PNG-1"), "A", 1, 3],
    [Buffer.from("\x89PNG-2"), "B", 2, 3],
    [Buffer.from("\x89PNG-3"), "C", 3, 3],
  ];
  const html = buildHtml(frames, "demo — build-up");
  assert.equal((html.match(/data:image\/png;base64,/g) || []).length, 3);
  assert.ok(!html.includes("http://"));
  assert.ok(!html.includes("https://"));
  assert.match(html, /id="play"/);
  assert.match(html, /id="scrub"/);
  assert.match(html, /id="bar"/);
  // JSON.stringify is compact by default (no space after ":"), unlike
  // Python's json.dumps default — assert against JS's actual output shape.
  assert.match(html, /"label":"C"/);
  assert.match(html, /"step":3/);
  assert.match(html, /"total":3/);
});

test("CLI: full run produces one frame per node", { skip: !drawioOnPath() }, () => {
  // Skipped when the draw.io CLI is not on PATH, mirroring
  // TestBuildupCli's self.skipTest("draw.io CLI not installed") in the
  // Python suite. When drawio IS available this exercises the full pipeline.
  const p = writeTemp(DOC);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildup-cli-"));
  const out = path.join(outDir, "out.html");
  execFileSync(
    "node",
    [new URL("../../skills/drawio-skill/scripts/buildup.mjs", import.meta.url).pathname, p, "-o", out],
    { stdio: "pipe" }
  );
  const html = fs.readFileSync(out, "utf8");
  assert.equal((html.match(/data:image\/png;base64,/g) || []).length, 3);
});

// Port of tests/test_runbook.py to node:test.
// runbook.mjs parses a flowchart .drawio and builds a click-through HTML
// runbook directly from the XML — pure and deterministic (no dot / no
// elkjs / no draw.io CLI), so all six original test methods translate 1:1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, buildHtml } from "../../skills/drawio-skill/scripts/runbook.mjs";

const FLOWCHART = `<mxfile><diagram name="P1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="start" value="Start" vertex="1" parent="1" style="ellipse;whiteSpace=wrap;html=1;">
<mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="dec" value="Is it broken?" vertex="1" parent="1" style="rhombus;whiteSpace=wrap;html=1;">
<mxGeometry x="0" y="100" width="160" height="80" as="geometry"/></mxCell>
<mxCell id="a" value="Escalate" vertex="1" parent="1" style="rounded=1;whiteSpace=wrap;html=1;">
<mxGeometry x="-150" y="220" width="140" height="60" as="geometry"/></mxCell>
<mxCell id="b" value="Close ticket" vertex="1" parent="1" style="rounded=1;whiteSpace=wrap;html=1;">
<mxGeometry x="150" y="220" width="140" height="60" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="start" target="dec">
<mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2" value="Yes" edge="1" parent="1" source="dec" target="a">
<mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e3" value="No" edge="1" parent="1" source="dec" target="b">
<mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

function writeTemp(xmlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-"));
  const p = path.join(dir, "x.drawio");
  fs.writeFileSync(p, xmlText, "utf8");
  return p;
}

test("node types inferred from style", () => {
  const p = writeTemp(FLOWCHART);
  const { nodes } = parse(p);
  assert.deepEqual(nodes["start"], { label: "Start", type: "start" });
  assert.equal(nodes["dec"].type, "decision");
  assert.equal(nodes["a"].type, "process");
  assert.equal(nodes["b"].type, "process");
});

test("edges carry choice labels", () => {
  const p = writeTemp(FLOWCHART);
  const { edges } = parse(p);
  assert.equal(edges.length, 3);
  const byTarget = Object.fromEntries(edges.map((e) => [e.target, e.label]));
  assert.equal(byTarget["a"], "Yes");
  assert.equal(byTarget["b"], "No");
  assert.equal(byTarget["dec"], "");
});

test("start node is the ellipse with in-degree zero", () => {
  const p = writeTemp(FLOWCHART);
  const { startId } = parse(p);
  assert.equal(startId, "start");
});

test("build html is self-contained with all labels and choices", () => {
  const p = writeTemp(FLOWCHART);
  const { nodes, edges, startId } = parse(p);
  const html = buildHtml("runbook-demo", nodes, edges, startId);
  for (const label of ["Start", "Is it broken?", "Escalate", "Close ticket"]) {
    assert.ok(html.includes(label), `missing label ${label}`);
  }
  assert.ok(html.includes('"Yes"'));
  assert.ok(html.includes('"No"'));
  // JSON.stringify is compact by default (no space after ":"), unlike
  // Python's json.dumps default — assert against JS's actual output shape.
  assert.ok(html.includes('"start":"start"'));
  assert.ok(!html.includes("http://"));
  assert.ok(!html.includes("https://"));
});

test("label XML entities are decoded", () => {
  const xmlText = FLOWCHART.replace('value="Start"', 'value="A &amp; B &lt;end&gt;"');
  const p = writeTemp(xmlText);
  const { nodes } = parse(p);
  assert.equal(nodes["start"].label, "A & B <end>");
});

test("terminal nodes have no outgoing edges", () => {
  const p = writeTemp(FLOWCHART);
  const { edges } = parse(p);
  const sources = new Set(edges.map((e) => e.source));
  assert.ok(!sources.has("a"));
  assert.ok(!sources.has("b"));
});

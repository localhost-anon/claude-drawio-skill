// Regression: composite edge keys in drawiodiff.mjs must be \0-joined, not
// space-joined. Labels can legitimately contain spaces, so `${a} ${b}` keys
// collide across different (source, target) pairs. This fixture has two
// distinct edges under --by-label that collide under a space join but not
// under a \0 join:
//   "a b" -> "c"    space-joined: "a b c"   \0-joined: "a b\0c"
//   "a"   -> "b c"  space-joined: "a b c"   \0-joined: "a\0b c"
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;

function drawioWithEdges(pairs) {
  // pairs: [[srcLabel, tgtLabel], ...] -- each pair gets its own two nodes
  // plus one edge between them, all ids unique.
  let cells = "";
  let id = 0;
  const nodeXml = (nid, label) =>
    `<mxCell id="${nid}" value="${label}" style="rounded=0;" vertex="1" parent="1">` +
    `<mxGeometry x="0" y="0" width="80" height="30" as="geometry"/></mxCell>`;
  const edgeXml = (nid, s, t) =>
    `<mxCell id="${nid}" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="${s}" target="${t}">` +
    `<mxGeometry relative="1" as="geometry"/></mxCell>`;
  for (const [sLabel, tLabel] of pairs) {
    const sId = `n${id++}`;
    const tId = `n${id++}`;
    const eId = `e${id++}`;
    cells += nodeXml(sId, sLabel) + nodeXml(tId, tLabel) + edgeXml(eId, sId, tId);
  }
  return (
    `<mxfile><diagram id="d1" name="Page-1"><mxGraphModel><root>` +
    `<mxCell id="0"/><mxCell id="1" parent="0"/>` +
    cells +
    `</root></mxGraphModel></diagram></mxfile>`
  );
}

test("drawiodiff --by-label: space-colliding label pairs stay distinct edges", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawiodiff-"));
  const file = path.join(dir, "graph.drawio");
  fs.writeFileSync(
    file,
    drawioWithEdges([
      ["a b", "c"],
      ["a", "b c"],
    ]),
    "utf8"
  );

  const out = execFileSync(
    "node",
    [path.join(SCRIPTS, "drawiodiff.mjs"), file, file, "--by-label"],
    { encoding: "utf8" }
  );
  const graph = JSON.parse(out);

  assert.equal(graph.edges.length, 2, "both edges must survive as distinct entries");
  const pairs = graph.edges.map((e) => [e.source, e.target]);
  assert.ok(
    pairs.some(([s, t]) => s === "a b" && t === "c"),
    'missing edge "a b" -> "c"'
  );
  assert.ok(
    pairs.some(([s, t]) => s === "a" && t === "b c"),
    'missing edge "a" -> "b c"'
  );
});

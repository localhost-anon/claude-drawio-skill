// Port of tests/test_tubemap.py to node:test.
// tubemap builds .drawio XML directly from a metro JSON — pure and
// deterministic, no dot / no elkjs layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { octilinearWaypoints, build, TUBE_PALETTE } from "../../skills/drawio-skill/scripts/tubemap.mjs";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;

const DEMO = {
  stations: {
    a: { label: "A", gx: 0, gy: 0 },
    b: { label: "B", gx: 2, gy: 0, interchange: true },
    c: { label: "C & <x>", gx: 2, gy: 2 },
    d: { label: "D", gx: 4, gy: 1 },
  },
  lines: [
    { name: "L1", color: "#0098d4", stations: ["a", "b", "c"] },
    { name: "L2", stations: ["b", "d"] }, // no colour -> palette
  ],
};

test("octilinear: horizontal needs no bend", () => {
  assert.deepEqual(octilinearWaypoints(0, 0, 5, 0), []);
});

test("octilinear: vertical needs no bend", () => {
  assert.deepEqual(octilinearWaypoints(0, 0, 0, 5), []);
});

test("octilinear: exact diagonal needs no bend", () => {
  assert.deepEqual(octilinearWaypoints(0, 0, 4, 4), []);
  assert.deepEqual(octilinearWaypoints(0, 0, -3, 3), []);
});

test("octilinear: wide delta goes diagonal then horizontal", () => {
  // dx=4, dy=1: diagonal run length 1, then straight into the target row.
  assert.deepEqual(octilinearWaypoints(0, 0, 4, 1), [[1, 1]]);
});

test("octilinear: tall delta goes diagonal then vertical", () => {
  // dx=1, dy=4: diagonal run length 1, then straight into the target column.
  assert.deepEqual(octilinearWaypoints(0, 0, 1, 4), [[1, 1]]);
});

test("octilinear: bend lands on the target axis", () => {
  for (const [x2, y2] of [[7, 2], [2, 7], [-6, 3], [3, -6]]) {
    const wp = octilinearWaypoints(0, 0, x2, y2);
    assert.equal(wp.length, 1);
    const [bx, by] = wp[0];
    assert.ok(bx === x2 || by === y2, `bend ${JSON.stringify(wp[0])} not aligned with target (${x2},${y2})`);
  }
});

test("build: counts and well-formed", () => {
  const [xml, nSt, nLn] = build(DEMO, 100);
  assert.deepEqual([nSt, nLn], [4, 2]);
  assert.ok(xml.startsWith("<?xml"));
  assert.match(xml, /<mxCell id="1" parent="0"\/>/); // layer footgun honoured
});

test("build: interchange marker distinct", () => {
  const [xml] = build(DEMO, 100);
  // Interchange stations use the black ring; regular stops the grey ring.
  assert.match(xml, /strokeColor=#111111/);
  assert.match(xml, /strokeColor=#555555/);
});

test("build: line colour and palette fallback", () => {
  const [xml] = build(DEMO, 100);
  assert.match(xml, /strokeColor=#0098d4/); // explicit colour
  assert.ok(xml.includes(`strokeColor=${TUBE_PALETTE[1]}`)); // 2nd line -> palette[1]
});

test("build: label escaped", () => {
  const [xml] = build(DEMO, 100);
  assert.ok(xml.includes("C &amp; &lt;x&gt;"));
  assert.ok(!xml.includes("C & <x>"));
});

test("build: unknown station id errors", () => {
  const bad = {
    stations: { a: { gx: 0, gy: 0 } },
    lines: [{ name: "L", stations: ["a", "ghost"] }],
  };
  assert.throws(() => build(bad));
});

test("CLI: stdout roundtrip", () => {
  const r = spawnSync("node", [path.join(SCRIPTS, "tubemap.mjs"), "-"], {
    input: JSON.stringify(DEMO),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<mxfile/);
  assert.match(r.stdout, /Tube Map/);
});

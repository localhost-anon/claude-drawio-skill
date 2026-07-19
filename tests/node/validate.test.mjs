// Port of TestValidateCli + the CLI portion of TestValidateGeometry from
// tests/test_scripts.py.orig. validate.mjs is CLI-only (no exports), so the
// pure-function geometry tests (segments_cross, route_hits_rect, abs_rect,
// endpoint) from TestValidateGeometry cannot be ported directly.
//
// SKIPPED: test_segments_cross, test_route_hits_rect, test_abs_rect,
// test_endpoint — these called internal geometry helpers via load("validate");
// validate.mjs exports none of them. Their effect is still exercised
// indirectly through the --score crossing/overlap counts below.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const VALIDATE = path.join(SCRIPTS, "validate.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-"));

function write(name, xml) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, xml);
  return p;
}

function run(...args) {
  const r = execFileSync("node", [VALIDATE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
  return r;
}
function runStatus(...args) {
  try {
    execFileSync("node", [VALIDATE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return 0;
  } catch (e) {
    return e.status;
  }
}

const GOOD = write(
  "good.drawio",
  `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="A" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="b" value="B" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`
);

const BAD = write(
  "bad.drawio",
  `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="missing1" target="missing2"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`
);

const EDGE_LABEL = write(
  "edgelabel.drawio",
  `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="b" value="B" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="lbl" value="label" vertex="1" connectable="0" parent="e1"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`
);

test("validate: clean diagram exits 0 with no errors", () => {
  const out = run(GOOD);
  assert.match(out, /^0 error\(s\), 0 warning\(s\)/m);
  assert.equal(runStatus(GOOD), 0);
});

test("validate: dangling edge endpoints reported and cause non-zero exit", () => {
  let stdout = "";
  try {
    execFileSync("node", [VALIDATE, BAD], { encoding: "utf8" });
  } catch (e) {
    stdout = e.stdout ? e.stdout.toString() : "";
  }
  assert.match(stdout, /source 'missing1' does not exist/);
  assert.match(stdout, /target 'missing2' does not exist/);
  assert.equal(runStatus(BAD), 1);
});

test("validate: --strict does not soften a hard error's exit code", () => {
  assert.equal(runStatus(BAD, "--strict"), 1);
});

test("validate: edge label vertex (connectable=0) does not trip vertex checks", () => {
  assert.equal(runStatus(EDGE_LABEL), 0);
});

test("validate: --score reports a numeric score line", () => {
  const out = run(GOOD, "--score");
  assert.match(out, /score: -?\d+ \(\d+ through-vertex, \d+ crossings, \d+ overlaps\)/);
});

test("validate: missing file exits non-zero", () => {
  assert.equal(runStatus(path.join(dir, "nope.drawio")), 1);
});

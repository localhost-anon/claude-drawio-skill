// Port of TestRestyle from tests/test_scripts.py.orig.
// restyle.mjs has no exports (hueSlot/setKeys are internal), so this is a
// subprocess end-to-end port rather than direct-import unit tests.
//
// SKIPPED: test_hue_slot_mapping, test_set_keys_replaces_and_appends — these
// called the internal hueSlot()/setKeys() helpers via load("restyle");
// restyle.mjs exports neither. Their behaviour is exercised end-to-end below
// (the dark-preset recolor test drives hueSlot's #dae8fc -> "primary"
// mapping, and setKeys's replace/append logic, through the CLI).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse, find, findAll } from "../../skills/drawio-skill/scripts/lib/xml.mjs";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const RESTYLE = path.join(SCRIPTS, "restyle.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restyle-"));

const src = path.join(dir, "svc.drawio");
fs.writeFileSync(
  src,
  `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="A" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="a" target="a"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`
);

test("restyle: dark preset recolors vertex/edge and sets model background", () => {
  const out = path.join(dir, "out.drawio");
  execFileSync("node", [RESTYLE, src, "--preset", "dark", "-o", out], { encoding: "utf8" });
  const root = parse(fs.readFileSync(out, "utf8"));
  const diagram = findAll(root, "diagram")[0];
  const model = find(diagram, "mxGraphModel");
  assert.equal(model.attrs.background, "#1e1e1e");

  const vertex = findAll(diagram, "mxCell").find((c) => c.attrs.id === "a");
  assert.match(vertex.attrs.style, /fillColor=#004870/);
  assert.match(vertex.attrs.style, /strokeColor=#33b6ff/);
  assert.match(vertex.attrs.style, /fontColor=#f0f0f0/);

  const edge = findAll(diagram, "mxCell").find((c) => c.attrs.id === "e1");
  assert.match(edge.attrs.style, /strokeColor=#bbbbbb/);
  assert.match(edge.attrs.style, /labelBackgroundColor=none/);
});

test("restyle: unknown preset lists the built-in preset names", () => {
  let stderr = "";
  try {
    execFileSync("node", [RESTYLE, src, "--preset", "not-a-preset"], { encoding: "utf8" });
    assert.fail("expected non-zero exit");
  } catch (e) {
    stderr = e.stderr.toString();
  }
  assert.match(stderr, /preset 'not-a-preset' not found/);
  for (const name of ["default", "corporate", "handdrawn", "colorblind-safe", "dark"]) {
    assert.match(stderr, new RegExp(name));
  }
});

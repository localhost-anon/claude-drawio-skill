// Port of TestRelabel from tests/test_scripts.py.orig.
// relabel.mjs is CLI-only (no exports); exercised via subprocess with the
// same Start/Web Server fixture data as the original FIXTURE_RELABEL.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const RELABEL = path.join(SCRIPTS, "relabel.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relabel-"));

const src = path.join(dir, "flow.drawio");
fs.writeFileSync(
  src,
  `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="Start" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="b" value="Web Server" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`
);

test("relabel: --extract lists page name and vertex labels", () => {
  const out = JSON.parse(execFileSync("node", [RELABEL, src, "--extract"], { encoding: "utf8" }));
  assert.equal(out["Page-1"], "Page-1");
  assert.equal(out["Start"], "Start");
  assert.equal(out["Web Server"], "Web Server");
});

test("relabel: --map replaces matching labels and reports unmatched keys", () => {
  const map = path.join(dir, "map.json");
  fs.writeFileSync(map, JSON.stringify({ Start: "Inicio", "Web Server": "Servidor Web", Unmatched: "Nope" }));
  const out = path.join(dir, "out.drawio");
  const stderr = execFileSync("node", [RELABEL, src, "--map", map, "-o", out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
  const written = fs.readFileSync(out, "utf8");
  assert.match(written, /value="Inicio"/);
  assert.match(written, /value="Servidor Web"/);
});

test("relabel: --map warns about unmatched keys on stderr", () => {
  const map = path.join(dir, "map2.json");
  fs.writeFileSync(map, JSON.stringify({ Start: "Inicio", Unmatched: "Nope" }));
  const out = path.join(dir, "out2.drawio");
  const r = spawnSync("node", [RELABEL, src, "--map", map, "-o", out], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Unmatched/);
  assert.match(r.stderr, /1 map key\(s\) matched no label/);
});

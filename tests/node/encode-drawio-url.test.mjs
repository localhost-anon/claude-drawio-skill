// Port of TestEncodeUrl from tests/test_scripts.py.orig.
// encode_drawio_url.mjs is CLI-only (no exports); tested via subprocess.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const ENCODE = path.join(SCRIPTS, "encode_drawio_url.mjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "encodeurl-"));
const file = path.join(dir, "a.drawio");
fs.writeFileSync(
  file,
  `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="A" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`
);

test("encode_drawio_url: default produces a viewer.diagrams.net URL", () => {
  const out = execFileSync("node", [ENCODE, file], { encoding: "utf8" }).trim();
  assert.match(out, /^https:\/\/viewer\.diagrams\.net\/\?/);
  assert.match(out, /#R[A-Za-z0-9%_-]+$/);
});

test("encode_drawio_url: --edit produces an app.diagrams.net create URL", () => {
  const out = execFileSync("node", [ENCODE, "--edit", file], { encoding: "utf8" }).trim();
  assert.match(out, /^https:\/\/app\.diagrams\.net\/\?/);
  assert.match(out, /create=%7B%22type%22%3A%22xml%22/);
});

test("encode_drawio_url: missing file exits non-zero", () => {
  assert.throws(() => {
    execFileSync("node", [ENCODE, path.join(dir, "nope.drawio")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  });
});

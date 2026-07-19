// Gate for c4.mjs (dot-replaced-by-elk via autolayoutModel: no byte-parity
// vs Python). Gate = validate.mjs exits 0 on the output AND no two leaf-node
// bounding boxes overlap on any page. (drawio PNG-export gate is skipped
// when the CLI is absent.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { assertNoOverlap } from "./autolayout.test.mjs";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const FIX = new URL("../fixtures/c4.json", import.meta.url).pathname;

test("c4: validate exits 0, no leaf overlaps on either page, 2 pages emitted", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c4-")), "out.drawio");
  const r = spawnSync("node", [path.join(SCRIPTS, "c4.mjs"), FIX, "-o", out], { encoding: "utf8" });
  const stderr = r.stderr;
  execFileSync("node", [path.join(SCRIPTS, "validate.mjs"), out], { stdio: "pipe" });
  assertNoOverlap(out, 0);
  assertNoOverlap(out, 1);
  const xml = fs.readFileSync(out, "utf8");
  assert.equal((xml.match(/<diagram /g) || []).length, 2, "2 pages expected");
  assert.match(stderr, /2 pages, 6 elements/);
});

test("c4: drill-down link references the child page id", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c4-")), "out.drawio");
  execFileSync("node", [path.join(SCRIPTS, "c4.mjs"), FIX, "-o", out], { stdio: "pipe" });
  const xml = fs.readFileSync(out, "utf8");
  assert.match(xml, /link="data:page\/id,containers"/);
});

test("c4: --direction validates choices", () => {
  assert.throws(() =>
    execFileSync("node", [path.join(SCRIPTS, "c4.mjs"), FIX, "--direction", "XX"], { stdio: "pipe" })
  );
});

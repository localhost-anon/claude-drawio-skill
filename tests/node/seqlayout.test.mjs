// Gate for seqlayout.mjs: deterministic pure-math port.
// This file adds a lightweight regression test using the same fixture so
// `node --test` alone still exercises the port.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const FIX = new URL("../fixtures/seq.json", import.meta.url).pathname;

test("seqlayout: runs and produces well-formed mxfile with 3 lifelines + 4 message/return edges", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seq-")), "out.drawio");
  const stderr = execFileSync("node", [path.join(SCRIPTS, "seqlayout.mjs"), FIX, "-o", out], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const xml = fs.readFileSync(out, "utf8");
  assert.ok(xml.includes("<mxfile>"));
  assert.match(xml, /shape=umlLifeline/);
  // 3 participants -> 3 lifeline vertices with those ids.
  for (const id of ["u", "s", "d"]) {
    assert.ok(xml.includes(`id="${id}"`), `missing lifeline ${id}`);
  }
  // 4 messages -> m0..m3 edges.
  for (let i = 0; i < 4; i++) {
    assert.ok(xml.includes(`id="m${i}"`), `missing message m${i}`);
  }
  execFileSync("node", [path.join(SCRIPTS, "validate.mjs"), out], { stdio: "pipe" });
});

test("seqlayout: deterministic — repeated runs produce identical output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seq-det-"));
  const out1 = path.join(dir, "a.drawio");
  const out2 = path.join(dir, "b.drawio");
  execFileSync("node", [path.join(SCRIPTS, "seqlayout.mjs"), FIX, "-o", out1], { stdio: "pipe" });
  execFileSync("node", [path.join(SCRIPTS, "seqlayout.mjs"), FIX, "-o", out2], { stdio: "pipe" });
  assert.equal(fs.readFileSync(out1, "utf8"), fs.readFileSync(out2, "utf8"));
});

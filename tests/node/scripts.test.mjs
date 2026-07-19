// Port of tests/test_scripts.py's smoke matrix to node:test.
// Every bundled .mjs script must respond to --help with exit 0 and
// non-empty usage on stdout, fast (no hanging async main).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;

const scripts = fs.readdirSync(SCRIPTS)
  .filter((f) => f.endsWith(".mjs"))
  .sort();

test("scripts directory is non-empty", () => {
  assert.ok(scripts.length > 0);
});

for (const script of scripts) {
  test(`${script} --help: exit 0 with usage on stdout`, () => {
    const r = spawnSync("node", [path.join(SCRIPTS, script), "--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(r.status, 0, `${script} --help exited ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout && r.stdout.trim().length > 0, `${script} --help produced no stdout`);
  });
}

// Port of TestAiIcons from tests/test_scripts.py.orig.
// aiicons.mjs has no exports (CLI-only), so we exercise it as a subprocess
// with --json, matching the style already used in scripts.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const AIICONS = path.join(SCRIPTS, "aiicons.mjs");

function run(...args) {
  return execFileSync("node", [AIICONS, ...args], { encoding: "utf8" });
}

function brands(query, limit = 8) {
  const out = run(query, "--json", "--limit", String(limit));
  return JSON.parse(out).map((r) => r.brand);
}

// SKIPPED: test_families_group_variants, test_variant_preference — these
// exercised the internal families()/pickVariant() helpers directly; aiicons.mjs
// exports neither, so there is no direct-import equivalent. Variant grouping
// and preference are exercised indirectly below (search results never surface
// bare variant ids like "googlecloud-brand").

test("aiicons: search matches brand (direct name)", () => {
  assert.equal(brands("claude", 1)[0], "claude");
});

test("aiicons: search matches brand via token inside a phrase", () => {
  assert.equal(brands("use the openai logo", 1)[0], "openai");
});

test("aiicons: search matches multi-word brand", () => {
  assert.equal(brands("Atlas Cloud", 1)[0], "atlascloud");
});

test("aiicons: search does not return variant brand ids (googlecloud)", () => {
  const found = brands("google cloud", 8);
  assert.ok(found.includes("googlecloud"));
  assert.ok(!found.includes("googlecloud-brand"));
});

test("aiicons: search does not return variant brand ids (alibaba)", () => {
  const found = brands("alibaba cloud", 8);
  assert.ok(found.includes("alibabacloud"));
  assert.ok(!found.includes("alibabacloud-text-cn"));
});

test("aiicons: unknown brand exits non-zero with a clear error", () => {
  let threw = false;
  let stderr = "";
  try {
    run("definitelynotabrand", "--json", "--limit", "3");
  } catch (e) {
    threw = true;
    stderr = e.stderr ? e.stderr.toString() : "";
  }
  assert.ok(threw);
  assert.match(stderr, /no logo for 'definitelynotabrand'/);
});

test("aiicons: --variant color prefers colour variant file", () => {
  const out = JSON.parse(run("claude", "--json", "--limit", "1", "--variant", "color"));
  assert.equal(out[0].file, "claude-color");
});

test("aiicons: --variant color falls back for mono-only brand", () => {
  const out = JSON.parse(run("openai", "--json", "--limit", "1", "--variant", "color"));
  assert.equal(out[0].file, "openai");
});

test("aiicons: --variant text prefers text variant when present", () => {
  const out = JSON.parse(run("googlecloud", "--json", "--limit", "1", "--variant", "text"));
  assert.equal(out[0].file, "googlecloud-brand");
});

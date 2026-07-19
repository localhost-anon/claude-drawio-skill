// Port of tests/test_skill_metadata.py to node:test.
// Deliberately does NOT assert on the presence/absence of the
// openclaw/hermes `metadata:` JSON blob — Task 8 rewrites SKILL.md
// frontmatter to be Claude Code-only and drops it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SKILL = new URL("../../skills/drawio-skill/SKILL.md", import.meta.url).pathname;

function frontmatter() {
  const text = fs.readFileSync(SKILL, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, "SKILL.md must start with a --- frontmatter block");
  return m[1];
}

test("SKILL.md has a non-empty name", () => {
  const fm = frontmatter();
  const m = fm.match(/^name:\s*(\S.*)$/m);
  assert.ok(m, "name field is missing");
  assert.ok(m[1].trim().length > 0);
});

test("SKILL.md has a non-empty description", () => {
  const fm = frontmatter();
  const m = fm.match(/^description:\s*(\S.*)$/m);
  assert.ok(m, "description field is missing");
  assert.ok(m[1].trim().length > 0);
});

test("SKILL.md declares a semver version", () => {
  const fm = frontmatter();
  const m = fm.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m);
  assert.ok(m, "top-level version is missing or not semver");
});

test("SKILL.md license is MIT", () => {
  const fm = frontmatter();
  const m = fm.match(/^license:\s*(\S.*)$/m);
  assert.ok(m, "license field is missing");
  assert.equal(m[1].trim(), "MIT");
});

test("SKILL.md has no metadata: line (Claude Code-only, no other-agent blob)", () => {
  const fm = frontmatter();
  assert.ok(!/^metadata:/m.test(fm), "metadata: line should have been removed");
});

test("SKILL.md has no platforms: line", () => {
  const fm = frontmatter();
  assert.ok(!/^platforms:/m.test(fm), "platforms: line should have been removed");
});

test("SKILL.md compatibility mentions Node", () => {
  const fm = frontmatter();
  const m = fm.match(/^compatibility:\s*(\S.*)$/m);
  assert.ok(m, "compatibility field is missing");
  assert.match(m[1], /Node/);
});

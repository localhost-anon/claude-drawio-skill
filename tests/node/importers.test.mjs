// Port of the code-import portion of TestImportersCli from
// tests/test_scripts.py.orig (pyimports, pyclasses, jsimports, goimports,
// rustimports, tfimports, k8simports). All are CLI-only (no exports), so
// they're driven as subprocesses and asserted on the emitted graph.json
// structure (node/edge counts, absence of NaN, --group behaviour) rather
// than any drawio-specific rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "importers-"));

function run(script, args) {
  return execFileSync("node", [path.join(SCRIPTS, script), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function graph(script, args, outName) {
  const out = path.join(dir, outName);
  run(script, [...args, "-o", out]);
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

function assertNoNaN(g) {
  const s = JSON.stringify(g);
  assert.ok(!/NaN/.test(s), "graph JSON should contain no NaN values");
}

test("pyimports: builds a module graph from a Python project", () => {
  const g = graph("pyimports.mjs", [path.join(FIXTURES, "pyproj")], "py.json");
  assert.ok(g.nodes.length >= 3);
  assert.ok(g.edges.length >= 1);
  assertNoNaN(g);
});

test("pyimports: --group tags nodes/edges deterministically (idempotent across runs)", () => {
  const g1 = graph("pyimports.mjs", [path.join(FIXTURES, "pyproj"), "--group"], "py-g1.json");
  const g2 = graph("pyimports.mjs", [path.join(FIXTURES, "pyproj"), "--group"], "py-g2.json");
  assert.deepEqual(g1, g2);
});

test("pyclasses: builds a class graph from a Python project", () => {
  const out = path.join(dir, "pyclasses.json");
  const stderr = run("pyclasses.mjs", [path.join(FIXTURES, "pyproj"), "-o", out]);
  const g = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.ok(Array.isArray(g.nodes));
  assertNoNaN(g);
});

test("jsimports: builds a module graph from a JS project", () => {
  const g = graph("jsimports.mjs", [path.join(FIXTURES, "jsproj")], "js.json");
  assert.ok(g.nodes.length >= 2);
  assertNoNaN(g);
});

test("goimports: builds a package graph from a Go module", () => {
  const g = graph("goimports.mjs", [path.join(FIXTURES, "gomod")], "go.json");
  assert.ok(g.nodes.length >= 2);
  assertNoNaN(g);
});

test("rustimports: builds a module graph from a Rust crate", () => {
  const g = graph("rustimports.mjs", [path.join(FIXTURES, "rustcrate")], "rust.json");
  assert.ok(g.nodes.length >= 2);
  assertNoNaN(g);
});

test("tfimports: builds a resource graph from Terraform, with icons by default", () => {
  const g = graph("tfimports.mjs", [path.join(FIXTURES, "tf", "main.tf")], "tf.json");
  assert.ok(g.nodes.length >= 1);
  assertNoNaN(g);
});

test("tfimports: --no-icons still produces the same node/edge topology", () => {
  const withIcons = graph("tfimports.mjs", [path.join(FIXTURES, "tf", "main.tf")], "tf-icons.json");
  const noIcons = graph("tfimports.mjs", [path.join(FIXTURES, "tf", "main.tf"), "--no-icons"], "tf-noicons.json");
  assert.equal(withIcons.nodes.length, noIcons.nodes.length);
  assert.equal(withIcons.edges.length, noIcons.edges.length);
});

test("k8simports: builds an object graph from a manifest list, with hierarchy edges", () => {
  const g = graph("k8simports.mjs", [path.join(FIXTURES, "k8s", "manifests.json")], "k8s.json");
  assert.ok(g.nodes.length >= 1);
  assert.ok(g.edges.length >= 1);
  assertNoNaN(g);
});

test("k8simports: --group annotates nodes with a group field", () => {
  const g = graph("k8simports.mjs", [path.join(FIXTURES, "k8s", "manifests.json"), "--group"], "k8s-g.json");
  assert.ok(g.nodes.some((n) => "group" in n));
});

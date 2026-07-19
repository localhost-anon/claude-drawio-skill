// Port of the remaining infra-import portion of TestImportersCli from
// tests/test_scripts.py.orig (composeimports, dockerimports, tfstate,
// openapiimports, sqlerd). All CLI-only; driven via subprocess.
//
// NOTE: composeimports/ciimports require JSON input (not real YAML) — the
// Node port has zero dependencies and no built-in YAML parser (documented in
// the scripts' own error text: "PyYAML is required ... Node port has zero
// dependencies"). JSON is a valid YAML subset, so tests/fixtures/compose/
// docker-compose.json (JSON) is used here instead of a .yml file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "importers-extra-"));

function run(script, args) {
  return execFileSync("node", [path.join(SCRIPTS, script), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function graph(script, args, outName) {
  const out = path.join(dir, outName);
  run(script, [...args, "-o", out]);
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

test("composeimports: builds service graph with depends_on/links/volumes_from edges", () => {
  const g = graph("composeimports.mjs", [path.join(FIXTURES, "compose", "docker-compose.json")], "compose.json");
  const ids = g.nodes.map((n) => n.id || n.label);
  assert.ok(g.nodes.length >= 4);
  assert.ok(g.edges.length >= 3);
});

test("composeimports: rejects real YAML syntax (no bundled YAML parser)", () => {
  const yml = path.join(dir, "compose.yml");
  fs.writeFileSync(yml, "services:\n  web:\n    image: nginx\n");
  assert.throws(() => run("composeimports.mjs", [yml, "-o", path.join(dir, "x.json")]));
});

test("dockerimports: builds live topology graph (containers/networks/volumes)", () => {
  const g = graph("dockerimports.mjs", [path.join(FIXTURES, "docker", "inspect.json")], "docker.json");
  assert.ok(g.nodes.length >= 1);
  assert.ok(g.edges.length >= 1);
});

test("tfstate: builds a resource graph from terraform state, respecting --no-reduce", () => {
  const reduced = graph("tfstate.mjs", [path.join(FIXTURES, "tf", "state.json")], "tfstate-r.json");
  const full = graph("tfstate.mjs", [path.join(FIXTURES, "tf", "state.json"), "--no-reduce"], "tfstate-f.json");
  assert.ok(reduced.edges.length <= full.edges.length);
  assert.ok(reduced.nodes.length >= 1);
});

test("openapiimports: builds an operation graph with schema nodes by default", () => {
  const g = graph("openapiimports.mjs", [path.join(FIXTURES, "openapi", "spec.json")], "oapi.json");
  assert.ok(g.nodes.length >= 1);
});

test("openapiimports: --no-schemas drops schema nodes and their edges", () => {
  const withSchemas = graph("openapiimports.mjs", [path.join(FIXTURES, "openapi", "spec.json")], "oapi-with.json");
  const noSchemas = graph("openapiimports.mjs", [path.join(FIXTURES, "openapi", "spec.json"), "--no-schemas"], "oapi-without.json");
  assert.ok(noSchemas.nodes.length <= withSchemas.nodes.length);
  assert.ok(noSchemas.edges.length <= withSchemas.edges.length);
});

test("sqlerd: builds a table graph with foreign-key edges from schema.sql", () => {
  const g = graph("sqlerd.mjs", [path.join(FIXTURES, "sql", "schema.sql")], "sql.json");
  assert.ok(g.nodes.length >= 2);
  assert.ok(g.edges.length >= 1);
});

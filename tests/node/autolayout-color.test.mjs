// Port of TestAutolayoutColor from tests/test_scripts.py.orig.
// autolayout.mjs only exports autolayoutModel/wrapPage (loadPalette, groupStyle,
// toDrawio, tuneScore are internal), so this is a CLI end-to-end port using
// tests/fixtures/graph.json (an existing house fixture, already grouped into
// frontend/backend, matching the pytest scenario's shape).
//
// SKIPPED: any test that asserted on exact Graphviz `dot` layout coordinates
// — this repo uses elkjs (pure JS) instead of Graphviz for layout now, so
// assertions below check structural/coloring properties instead of exact
// positions. NOTE: adapted for elkjs layout (was Graphviz dot in original).
//
// SKIPPED: direct-import tests of loadPalette()/groupStyle()/toDrawio() —
// none of these are exported by autolayout.mjs; their effect is exercised
// end-to-end via the CLI below (consistent per-group fill colors, --mono).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse, findAll } from "../../skills/drawio-skill/scripts/lib/xml.mjs";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const AUTOLAYOUT = path.join(SCRIPTS, "autolayout.mjs");
const GRAPH = path.join(FIXTURES, "graph.json");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autolayout-color-"));

function cells(file) {
  const root = parse(fs.readFileSync(file, "utf8"));
  return findAll(root, "diagram").flatMap((d) => findAll(d, "mxCell"));
}

test("autolayout: nodes sharing a group get the same fill colour", () => {
  const out = path.join(dir, "grouped.drawio");
  execFileSync("node", [AUTOLAYOUT, GRAPH, "-o", out], { encoding: "utf8" });
  const cs = cells(out);
  const fill = (id) => (cs.find((c) => c.attrs.id === id).attrs.style.match(/fillColor=(#[0-9a-fA-F]{6})/) || [])[1];
  // api/auth/db are all group "backend" in tests/fixtures/graph.json.
  assert.equal(fill("api"), fill("auth"));
  assert.equal(fill("auth"), fill("db"));
  // web (group "frontend") should differ from the backend group's colour.
  assert.notEqual(fill("web"), fill("api"));
});

test("autolayout: --mono forces a single fill colour across all groups", () => {
  const out = path.join(dir, "mono.drawio");
  execFileSync("node", [AUTOLAYOUT, GRAPH, "-o", out, "--mono"], { encoding: "utf8" });
  const cs = cells(out).filter((c) => c.attrs.vertex === "1");
  const fills = new Set(cs.map((c) => (c.attrs.style.match(/fillColor=(#[0-9a-fA-F]{6})/) || [])[1]).filter(Boolean));
  assert.equal(fills.size, 1);
});

test("autolayout: ungrouped node still receives a valid, non-empty style", () => {
  const out = path.join(dir, "ungrouped.drawio");
  execFileSync("node", [AUTOLAYOUT, GRAPH, "-o", out], { encoding: "utf8" });
  const cs = cells(out);
  const cache = cs.find((c) => c.attrs.id === "cache");
  assert.ok(cache.attrs.style && cache.attrs.style.length > 0);
  assert.match(cache.attrs.style, /fillColor=#[0-9a-fA-F]{6}/);
});

// Gate for autolayout.mjs (dot-replaced-by-elk: no byte-parity vs Python).
// Gate = validate.mjs exits 0 on the output AND no two leaf-node bounding
// boxes overlap. (drawio PNG-export gate is skipped when the CLI is absent.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse, find, findAll } from "../../skills/drawio-skill/scripts/lib/xml.mjs";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const FIX = new URL("../fixtures/graph.json", import.meta.url).pathname;

// Absolute leaf-vertex rects, then assert no two overlap (~10-line check).
export function assertNoOverlap(file, pageIndex = null) {
  const root = parse(fs.readFileSync(file, "utf8"));
  const diagrams = root.children.filter((c) => c.tag === "diagram");
  const pages = pageIndex === null ? diagrams : [diagrams[pageIndex]];
  for (const page of pages) {
    const model = find(page, "mxGraphModel");
    const cells = model ? findAll(model, "mxCell") : [];
    const byId = new Map(cells.map((c) => [c.attrs.id, c]));
    const parents = new Set(cells.map((c) => c.attrs.parent));
    const abs = (c) => {
      const g = find(c, "mxGeometry");
      if (!g) return null;
      let x = parseFloat(g.attrs.x), y = parseFloat(g.attrs.y);
      let w = parseFloat(g.attrs.width), h = parseFloat(g.attrs.height);
      if ([x, y, w, h].some(Number.isNaN)) return null;
      let p = byId.get(c.attrs.parent);
      while (p && p.attrs.vertex === "1") {
        const pg = find(p, "mxGeometry");
        if (pg) { x += parseFloat(pg.attrs.x) || 0; y += parseFloat(pg.attrs.y) || 0; }
        p = byId.get(p.attrs.parent);
      }
      return [x, y, w, h];
    };
    const leaves = cells
      .filter((c) => c.attrs.vertex === "1" && !parents.has(c.attrs.id))
      .map((c) => [c.attrs.id, abs(c)])
      .filter(([, r]) => r);
    for (let i = 0; i < leaves.length; i++)
      for (let j = i + 1; j < leaves.length; j++) {
        const [ai, [ax, ay, aw, ah]] = leaves[i];
        const [bi, [bx, by, bw, bh]] = leaves[j];
        const overlap = ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
        assert.ok(!overlap, `leaf ${ai} overlaps ${bi} on page`);
      }
  }
}

test("autolayout: validate exits 0 and no leaf overlaps", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-")), "out.drawio");
  execFileSync("node", [path.join(SCRIPTS, "autolayout.mjs"), FIX, "-o", out], { stdio: "pipe" });
  // validate.mjs must exit 0 (throws on non-zero).
  execFileSync("node", [path.join(SCRIPTS, "validate.mjs"), out], { stdio: "pipe" });
  assertNoOverlap(out);
});

test("autolayout: --mono produces monochrome group boxes", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-")), "out.drawio");
  execFileSync("node", [path.join(SCRIPTS, "autolayout.mjs"), FIX, "-o", out, "--mono"], { stdio: "pipe" });
  const xml = fs.readFileSync(out, "utf8");
  assert.ok(xml.includes("strokeColor=#999999"), "mono group uses neutral stroke");
});

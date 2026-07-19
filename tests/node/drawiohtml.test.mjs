// Port of TestDrawioHtml from tests/test_scripts.py.orig.
//
// SKIPPED: test_rewrite_page_links, test_strip_prolog, test_build_html_self_contained
// — these called rewritePageLinks()/stripProlog()/buildHtml() directly via
// load("drawiohtml"). drawiohtml.mjs has no `export` statements (all helpers
// are module-private), so there is no direct-import equivalent in the Node
// port.
//
// SKIPPED: test_viewer_end_to_end — the CLI path shells out to the `drawio`
// binary to export each page to SVG (drawiohtml.mjs's exportSvg()), and
// `drawio` is not installed on this system (`which drawio` -> not found).
// This matches pytest's own runtime skip for the same missing-binary case.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const DRAWIOHTML = path.join(SCRIPTS, "drawiohtml.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawiohtml-"));

test("drawiohtml: without the draw.io CLI, exits non-zero with a clear error", () => {
  const page = path.join(dir, "two-page.drawio");
  fs.writeFileSync(
    page,
    `<mxfile>
<diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>
<diagram id="p2" name="Page-2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>
</mxfile>`
  );
  const out = path.join(dir, "out.html");
  let threw = false;
  let stderr = "";
  try {
    execFileSync("node", [DRAWIOHTML, page, "-o", out], { encoding: "utf8" });
  } catch (e) {
    threw = true;
    stderr = e.stderr ? e.stderr.toString() : "";
  }
  assert.ok(threw, "expected drawiohtml to fail without the draw.io CLI installed");
  assert.match(stderr, /draw\.io CLI|export failed/);
});

// Port of tests/test_prdiff.py to node:test.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { changedDrawios, buildEntry, renderMarkdown } from "../../skills/drawio-skill/scripts/prdiff.mjs";

function drawioOnPath() {
  try {
    execFileSync("drawio", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function makeRepo(tmp) {
  execFileSync("git", ["init", "-q", tmp]);
  execFileSync("git", ["-C", tmp, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", tmp, "config", "user.name", "Test"]);
}

function writeCommit(tmp, name, content, message) {
  fs.writeFileSync(path.join(tmp, name), content, "utf8");
  execFileSync("git", ["-C", tmp, "add", name]);
  execFileSync("git", ["-C", tmp, "commit", "-q", "-m", message]);
}

const V1 = `<mxfile>
  <diagram id="p1" name="Page-1">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="n1" value="A" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="120" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="n2" value="B" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="240" y="40" width="120" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="e1" style="html=1;" edge="1" parent="1" source="n1" target="n2">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
const V2 = V1.replace('value="B"', 'value="B2"');

test("changedDrawios: modified", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prdiff-"));
  makeRepo(tmp);
  writeCommit(tmp, "a.drawio", V1, "v1");
  writeCommit(tmp, "a.drawio", V2, "v2");
  assert.deepEqual(changedDrawios("HEAD~1", "HEAD", tmp), [["a.drawio", "modified"]]);
});

test("changedDrawios: added", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prdiff-"));
  makeRepo(tmp);
  writeCommit(tmp, "a.drawio", V1, "v1");
  writeCommit(tmp, "b.drawio", V1, "add b");
  assert.deepEqual(changedDrawios("HEAD~1", "HEAD", tmp), [["b.drawio", "added"]]);
});

test("changedDrawios: removed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prdiff-"));
  makeRepo(tmp);
  writeCommit(tmp, "a.drawio", V1, "v1");
  fs.rmSync(path.join(tmp, "a.drawio"));
  execFileSync("git", ["-C", tmp, "add", "-A"]);
  execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "remove a"]);
  assert.deepEqual(changedDrawios("HEAD~1", "HEAD", tmp), [["a.drawio", "removed"]]);
});

test("changedDrawios: non-drawio files ignored", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prdiff-"));
  makeRepo(tmp);
  writeCommit(tmp, "a.drawio", V1, "v1");
  writeCommit(tmp, "notes.txt", "hello", "add notes");
  assert.deepEqual(changedDrawios("HEAD~1", "HEAD", tmp), []);
});

test("renderMarkdown: sections, statuses, and links", () => {
  const entries = [
    {
      path: "a.drawio",
      status: "modified",
      base_png: "/out/a.base.png",
      head_png: "/out/a.head.png",
      diff_png: "/out/a.diff.png",
    },
    { path: "b.drawio", status: "added", head_png: "/out/b.head.png" },
    { path: "c.drawio", status: "removed", base_png: "/out/c.base.png" },
  ];
  const md = renderMarkdown(entries, "/out");
  assert.match(md, /## a\.drawio \(modified\)/);
  assert.match(md, /## b\.drawio \(added\)/);
  assert.match(md, /## c\.drawio \(removed\)/);
  assert.match(md, /!\[base\]\(a\.base\.png\)/);
  assert.match(md, /!\[head\]\(a\.head\.png\)/);
  assert.match(md, /!\[diff\]\(a\.diff\.png\)/);
  assert.match(md, /!\[head\]\(b\.head\.png\)/);
  assert.match(md, /!\[base\]\(c\.base\.png\)/);
  assert.match(md, /3 file\(s\) changed/);
  assert.match(md, /\+1 added/);
  assert.match(md, /-1 removed/);
  assert.match(md, /~1 modified/);
});

test("renderMarkdown: no changes", () => {
  const md = renderMarkdown([], "/out");
  assert.match(md, /No `\.drawio` files changed/);
});

test("renderMarkdown: skipped CLI note", () => {
  const entries = [{ path: "a.drawio", status: "modified", skipped: true }];
  const md = renderMarkdown(entries, "/out");
  assert.match(md, /## a\.drawio \(modified\)/);
  assert.match(md, /images skipped/);
  assert.ok(!md.includes("!["));
});

test(
  "full pipeline: buildEntry exports base/head/diff PNGs",
  { skip: !drawioOnPath() ? "draw.io CLI not installed" : false },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prdiff-"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    makeRepo(repo);
    writeCommit(repo, "a.drawio", V1, "v1");
    writeCommit(repo, "a.drawio", V2, "v2");
    const outDir = path.join(tmp, "out");
    fs.mkdirSync(outDir);
    const entry = buildEntry(repo, "HEAD~1", "HEAD", "a.drawio", "modified", outDir, true);
    assert.ok(fs.existsSync(entry.base_png));
    assert.ok(fs.existsSync(entry.head_png));
    assert.ok(fs.existsSync(entry.diff_png));
  }
);

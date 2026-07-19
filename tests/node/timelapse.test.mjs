// Node-native tests for timelapse.mjs. There is no tests/test_timelapse.py in
// this repo (the Python original was never given a pytest suite), so these
// tests were written directly against timelapse.py's documented behavior
// instead of being a line-for-line port. They cover the pure helpers
// (sampleIndices, history parsing, buildHtml) plus CLI error paths and an
// end-to-end git-history run using the bundled pyimports importer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sampleIndices, history, buildHtml } from "../../skills/drawio-skill/scripts/timelapse.mjs";

const SCRIPTS = new URL("../../skills/drawio-skill/scripts/", import.meta.url).pathname;
const TIMELAPSE = path.join(SCRIPTS, "timelapse.mjs");

function drawioOnPath() {
  try {
    execFileSync("drawio", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("sampleIndices: total <= n keeps every index", () => {
  assert.deepEqual(sampleIndices(3, 10), [0, 1, 2]);
  assert.deepEqual(sampleIndices(0, 10), []);
});

test("sampleIndices: n <= 1 keeps every index", () => {
  assert.deepEqual(sampleIndices(5, 1), [0, 1, 2, 3, 4]);
  assert.deepEqual(sampleIndices(5, 0), [0, 1, 2, 3, 4]);
});

test("sampleIndices: always includes first and last, evenly spread", () => {
  const idx = sampleIndices(20, 5);
  assert.equal(idx[0], 0);
  assert.equal(idx[idx.length - 1], 19);
  assert.ok(idx.length <= 5);
  // strictly increasing
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1]);
});

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

test("history: chronological (oldest first), one row per commit touching path", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-")));
  makeRepo(tmp);
  writeCommit(tmp, "a.py", "x = 1\n", "first");
  writeCommit(tmp, "a.py", "x = 2\n", "second");
  writeCommit(tmp, "unrelated.txt", "hi", "unrelated change");
  const rows = history(tmp, "a.py");
  assert.equal(rows.length, 2);
  assert.equal(rows[0][2], "first");
  assert.equal(rows[1][2], "second");
  for (const [hash, date] of rows) {
    assert.match(hash, /^[0-9a-f]{40}$/);
    assert.ok(date.length > 0);
  }
});

test("history: empty for a repo with no commits touching path", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-")));
  makeRepo(tmp);
  writeCommit(tmp, "a.py", "x = 1\n", "first");
  assert.deepEqual(history(tmp, "does-not-exist.py"), []);
});

test("buildHtml: self-contained, embeds frames, exposes player controls", () => {
  const frames = [
    [Buffer.from("\x89PNG-1"), "abcdef0123456789", "2024-01-01T00:00:00Z", "first commit", 2, 1],
    [Buffer.from("\x89PNG-2"), "1234567890abcdef", "2024-01-02T00:00:00Z", "second commit", 4, 3],
  ];
  const html = buildHtml(frames, "Architecture evolution — demo");
  assert.equal((html.match(/data:image\/png;base64,/g) || []).length, 2);
  assert.ok(!html.includes("http://"));
  assert.ok(!html.includes("https://"));
  assert.match(html, /id="play"/);
  assert.match(html, /id="scrub"/);
  assert.match(html, /id="bar"/);
  assert.match(html, /"hash":"abcdef012"/); // truncated to 9 chars
  assert.match(html, /"date":"2024-01-02"/); // truncated to 10 chars
  assert.match(html, /"n":4/);
  assert.match(html, /"e":3/);
});

test("CLI: unknown importer is a fatal error", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-")));
  makeRepo(tmp);
  writeCommit(tmp, "a.py", "x = 1\n", "first");
  assert.throws(() => {
    execFileSync("node", [TIMELAPSE, tmp, "--importer", "bogus"], { stdio: "pipe" });
  }, /unknown importer/);
});

test("CLI: invalid --direction is a fatal error", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-")));
  makeRepo(tmp);
  writeCommit(tmp, "a.py", "x = 1\n", "first");
  assert.throws(() => {
    execFileSync("node", [TIMELAPSE, tmp, "--direction", "XY"], { stdio: "pipe" });
  }, /invalid choice/);
});

test("CLI: non-directory path is a fatal error", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-")));
  const file = path.join(tmp, "notadir");
  fs.writeFileSync(file, "x", "utf8");
  assert.throws(() => {
    execFileSync("node", [TIMELAPSE, file], { stdio: "pipe" });
  }, /not a directory/);
});

test("CLI: path outside a git repository is a fatal error", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-nogit-"));
  assert.throws(() => {
    execFileSync("node", [TIMELAPSE, tmp], { stdio: "pipe" });
  }, /not inside a git repository/);
});

test("CLI: no commits touch path is a fatal error", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-")));
  makeRepo(tmp);
  writeCommit(tmp, "a.py", "x = 1\n", "first");
  const empty = path.join(tmp, "sub");
  fs.mkdirSync(empty);
  assert.throws(() => {
    execFileSync("node", [TIMELAPSE, empty], { stdio: "pipe" });
  }, /no commits touch/);
});

test(
  "CLI: full run over real git history produces an HTML player",
  { skip: !drawioOnPath() ? "draw.io CLI not installed" : false },
  () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-")));
    makeRepo(tmp);
    fs.writeFileSync(path.join(tmp, "a.py"), "import os\n", "utf8");
    execFileSync("git", ["-C", tmp, "add", "a.py"]);
    execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "add a"]);
    fs.writeFileSync(path.join(tmp, "b.py"), "import a\n", "utf8");
    execFileSync("git", ["-C", tmp, "add", "b.py"]);
    execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "add b importing a"]);
    const out = path.join(tmp, "evolution.html");
    execFileSync("node", [TIMELAPSE, tmp, "--importer", "pyimports", "-o", out], { stdio: "pipe" });
    const html = fs.readFileSync(out, "utf8");
    assert.ok(html.includes("data:image/png;base64,"));
  }
);

// No importer's requirements or draw.io CLI needed: with drawio absent from
// PATH, every commit's build_frame/buildFrame fails at the PNG export step,
// so frames stays empty on both the Python original and this port -- and
// both exit fatally with the same message. This exercises that shared
// "no tool available" failure path without needing the draw.io CLI.
test("CLI: without the draw.io CLI, no frames are produced (graceful failure)", { skip: drawioOnPath() }, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-")));
  makeRepo(tmp);
  fs.writeFileSync(path.join(tmp, "a.py"), "import os\n", "utf8");
  execFileSync("git", ["-C", tmp, "add", "a.py"]);
  execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "add a"]);
  assert.throws(() => {
    execFileSync("node", [TIMELAPSE, tmp, "--importer", "pyimports"], { stdio: "pipe" });
  }, /no frames produced/);
});

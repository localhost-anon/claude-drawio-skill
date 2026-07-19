import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse, serialize, find, findAll, esc, escAttr } from "../../skills/drawio-skill/scripts/lib/xml.mjs";
import { loadFile, saveFile, walkCells, styleToMap, mapToStyle, mxfileSkeleton } from "../../skills/drawio-skill/scripts/lib/drawio.mjs";
import { parseArgs } from "../../skills/drawio-skill/scripts/lib/args.mjs";

const fixturePath = new URL("../fixtures/basic.drawio", import.meta.url).pathname;

test("xml round-trip (inline)", () => {
  const src = `<a x="1"><b>hi &amp; bye</b><c/></a>`;
  assert.deepEqual(parse(serialize(parse(src))), parse(src));
});

test("xml round-trip of fixture file", () => {
  const text = fs.readFileSync(fixturePath, "utf8");
  const tree = parse(text);
  assert.deepEqual(parse(serialize(tree)), parse(text));
});

test("compressed page decodes", () => {
  const f = loadFile(fixturePath);
  assert.equal(f.pages.length, 2);
  assert.ok(f.pages[0].model);
  assert.ok(f.pages[1].model); // compressed page inflated
});

test("walkCells unwraps UserObject", () => {
  const f = loadFile(fixturePath);
  const cells = [...walkCells(f.pages[0].model)];
  const wrapped = cells.find((c) => c.wrapper && c.wrapper.attrs.id === "p1-e");
  assert.ok(wrapped);
  assert.equal(wrapped.wrapper.tag, "UserObject");
  assert.equal(wrapped.wrapper.attrs.label, "E");
});

test("style map round-trip", () => {
  const m = styleToMap("rounded=1;fillColor=#dae8fc;");
  assert.equal(m.rounded, "1");
  assert.match(mapToStyle(m), /fillColor=#dae8fc/);
});

test("mxfileSkeleton produces valid mxfile with pages", () => {
  const skeleton = mxfileSkeleton([{ name: "Page-1" }]);
  assert.equal(skeleton.tag, "mxfile");
  const diagrams = findAll(skeleton, "diagram");
  assert.equal(diagrams.length, 1);
  assert.equal(diagrams[0].attrs.name, "Page-1");
});

test("saveFile then loadFile round-trips a simple page", () => {
  const tmp = path.join(os.tmpdir(), `lib-test-${Date.now()}.drawio`);
  const model = parse(
    `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>`
  );
  saveFile(tmp, [{ name: "P1", model }]);
  const loaded = loadFile(tmp);
  assert.equal(loaded.pages.length, 1);
  assert.equal(loaded.pages[0].name, "P1");
  assert.ok(find(loaded.pages[0].model, "root"));
  fs.unlinkSync(tmp);
});

test("esc/escAttr escape entities", () => {
  assert.equal(esc("a & b < c"), "a &amp; b &lt; c");
  assert.equal(escAttr('say "hi"'), "say &quot;hi&quot;");
});

test("args: parseArgs handles flags and defaults", () => {
  const spec = {
    name: "prog",
    usage: "prog [options]",
    flags: {
      out: { short: "-o", takesValue: true, default: null },
      clusters: { takesValue: true, type: "int" },
      verbose: {},
    },
  };
  const r = parseArgs(spec, ["-o", "out.drawio", "--clusters", "3", "--verbose", "input.drawio"]);
  assert.equal(r.out, "out.drawio");
  assert.equal(r.clusters, 3);
  assert.equal(r.verbose, true);
  assert.deepEqual(r._, ["input.drawio"]);
});

test("args: default values used when flag absent", () => {
  const spec = { name: "prog", usage: "prog", flags: { out: { short: "-o", takesValue: true, default: "x.drawio" } } };
  const r = parseArgs(spec, []);
  assert.equal(r.out, "x.drawio");
});

test("args: repeat flag collects into array", () => {
  const spec = { name: "prog", usage: "prog", flags: { tag: { takesValue: true, repeat: true } } };
  const r = parseArgs(spec, ["--tag", "a", "--tag", "b"]);
  assert.deepEqual(r.tag, ["a", "b"]);
});

test("args: -h/--help prints usage and exits 0", () => {
  const script = new URL("./fixtures/args-cli.mjs", import.meta.url).pathname;
  const out = execFileSync("node", [script, "--help"], { encoding: "utf8" });
  assert.match(out, /Usage/i);
});

test("args: unknown flag exits 2 with usage on stderr", () => {
  assert.throws(
    () => {
      const script = new URL("./fixtures/args-cli.mjs", import.meta.url).pathname;
      execFileSync("node", [script, "--nope"], { encoding: "utf8" });
    },
    (err) => {
      assert.equal(err.status, 2);
      assert.match(err.stderr.toString(), /Usage/i);
      return true;
    }
  );
});

test("args: invalid int value exits 2 with usage on stderr", () => {
  assert.throws(
    () => {
      const script = new URL("./fixtures/args-cli.mjs", import.meta.url).pathname;
      execFileSync("node", [script, "--count", "notanumber"], { encoding: "utf8" });
    },
    (err) => {
      assert.equal(err.status, 2);
      assert.match(err.stderr.toString(), /error: invalid integer/);
      assert.match(err.stderr.toString(), /Usage/i);
      return true;
    }
  );
});

test("args: die() prints error and exits 1", () => {
  assert.throws(
    () => {
      const script = new URL("./fixtures/args-cli.mjs", import.meta.url).pathname;
      execFileSync("node", [script, "--die"], { encoding: "utf8" });
    },
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString(), /^error: /);
      return true;
    }
  );
});

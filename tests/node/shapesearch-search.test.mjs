// Port of TestShapeSearch from tests/test_scripts.py.orig.
// shapesearch.mjs exports buildTagMap/matchTerm/search directly, so we
// import the module rather than shell out (mirrors pytest's load()).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import * as shapesearch from "../../skills/drawio-skill/scripts/shapesearch.mjs";

// SKIPPED: test_soundex — soundex() is an unexported internal helper in
// shapesearch.mjs (no Node equivalent to call directly); its behaviour is
// exercised indirectly through the search()-based tests below.

const shapes = JSON.parse(zlib.gunzipSync(fs.readFileSync(shapesearch.INDEX)).toString("utf8"));
const tagMap = shapesearch.buildTagMap(shapes);

function search(q, n = 5) {
  return shapesearch.search(shapes, tagMap, q, n);
}

test("shapesearch: index loaded with >10000 shapes and a non-empty tag map", () => {
  assert.ok(shapes.length > 10000);
  assert.ok(Object.keys(tagMap).length > 0 || tagMap.size > 0);
});

test("shapesearch: known shapes rank via search", () => {
  assert.match(search("aws lambda")[0].title, /Lambda/);
  assert.match(search("uml actor")[0].title, /Actor/);
});

test("shapesearch: title-exact ranking puts literal DynamoDB shape first", () => {
  // The literally-titled "DynamoDB" shape ranks above tag-only neighbours.
  assert.equal(search("aws dynamodb")[0].title, "DynamoDB");
});

test("shapesearch: no match returns empty array", () => {
  assert.deepEqual(search("zzzznotashape"), []);
});

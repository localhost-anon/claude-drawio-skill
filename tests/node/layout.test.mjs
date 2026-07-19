import { test } from "node:test";
import assert from "node:assert/strict";
import { layout } from "../../skills/drawio-skill/scripts/lib/layout.mjs";

test("chain a->b->c->d DOWN produces strictly increasing y, no NaN", async () => {
  const nodes = [
    { id: "a", width: 100, height: 40, label: "a" },
    { id: "b", width: 100, height: 40, label: "b" },
    { id: "c", width: 100, height: 40, label: "c" },
    { id: "d", width: 100, height: 40, label: "d" },
  ];
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "d" },
  ];

  const result = await layout(nodes, edges, { direction: "DOWN", spacing: 60 });

  assert.equal(result.length, 4);
  const byId = Object.fromEntries(result.map((r) => [r.id, r]));
  for (const id of ["a", "b", "c", "d"]) {
    assert.ok(byId[id], `missing node ${id}`);
    assert.ok(!Number.isNaN(byId[id].x), `x is NaN for ${id}`);
    assert.ok(!Number.isNaN(byId[id].y), `y is NaN for ${id}`);
  }
  assert.ok(byId.a.y < byId.b.y, "a.y should be < b.y");
  assert.ok(byId.b.y < byId.c.y, "b.y should be < c.y");
  assert.ok(byId.c.y < byId.d.y, "c.y should be < d.y");
});

test("two unconnected nodes do not overlap", async () => {
  const nodes = [
    { id: "x", width: 100, height: 50 },
    { id: "y", width: 100, height: 50 },
  ];
  const edges = [];

  const result = await layout(nodes, edges, { direction: "DOWN", spacing: 60 });
  assert.equal(result.length, 2);
  const [nx, ny] = result;

  const box = (n, w, h) => ({ left: n.x, right: n.x + w, top: n.y, bottom: n.y + h });
  const bx = box(nx, 100, 50);
  const by = box(ny, 100, 50);

  const overlap = !(
    bx.right <= by.left ||
    by.right <= bx.left ||
    bx.bottom <= by.top ||
    by.bottom <= bx.top
  );
  assert.equal(overlap, false, "bounding boxes should not overlap");
});

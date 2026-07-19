import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ELK = require("./vendor/elk.js");

/**
 * Compute a graph layout using elkjs (layered algorithm), replacing Graphviz `dot`.
 *
 * @param {Array<{id: string, width: number, height: number, label?: string}>} nodes
 * @param {Array<{source: string, target: string}>} edges
 * @param {{direction?: "DOWN"|"RIGHT", spacing?: number}} [opts]
 * @returns {Promise<Array<{id: string, x: number, y: number}>>}
 */
export async function layout(nodes, edges, opts = {}) {
  const direction = opts.direction ?? "DOWN";
  const spacing = opts.spacing ?? 60;

  const elk = new ELK();

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.spacing.nodeNode": String(spacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(spacing),
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
    })),
    edges: edges.map((e, i) => ({
      id: `e${i}`,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const result = await elk.layout(graph);

  return result.children.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
  }));
}

import fs from "node:fs";
import zlib from "node:zlib";
import { parse, serialize, find, findAll } from "./xml.mjs";

const WRAPPER_TAGS = new Set(["UserObject", "object"]);

/**
 * Decode a <diagram> element's text content into an mxGraphModel node.
 * draw.io compresses page payloads as: XML -> URI-encode -> deflate (raw)
 * -> base64. If the diagram element already has <mxGraphModel> children
 * (uncompressed), those are used directly.
 */
function decodeDiagram(diagramEl) {
  const inlineModel = find(diagramEl, "mxGraphModel");
  if (inlineModel) return inlineModel;

  const text = (diagramEl.text || "").trim();
  if (!text) {
    // empty page — synthesize an empty model
    return parse(`<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>`);
  }

  const compressed = Buffer.from(text, "base64");
  const inflated = zlib.inflateRawSync(compressed);
  const xml = decodeURIComponent(inflated.toString("utf8"));
  return parse(xml);
}

/**
 * Load a .drawio file. Returns { pages: [{ name, model }] } where `model`
 * is the parsed <mxGraphModel> node for each page (decompressed if needed).
 */
export function loadFile(path) {
  const text = fs.readFileSync(path, "utf8");
  const root = parse(text);

  // Pages are the root's <diagram> children; if the root itself is a
  // <diagram> (rare/standalone), treat it as a single page.
  let diagramEls = root.tag === "mxfile" ? findAll(root, "diagram") : null;
  if (!diagramEls || diagramEls.length === 0) {
    if (root.tag === "diagram") {
      diagramEls = [root];
    } else {
      // fall back: root might already be an mxGraphModel with no <diagram> wrapper
      const model = root.tag === "mxGraphModel" ? root : find(root, "mxGraphModel");
      return { pages: [{ name: "Page-1", model }] };
    }
  }

  const pages = diagramEls.map((el, idx) => ({
    name: el.attrs.name || `Page-${idx + 1}`,
    model: decodeDiagram(el),
  }));

  return { pages };
}

/**
 * Build an <mxfile> skeleton node from a list of pages ({name, model}).
 * Page payloads are always written uncompressed (model nested directly).
 */
export function mxfileSkeleton(pages) {
  const mxfile = { tag: "mxfile", attrs: { host: "drawio" }, children: [], text: "" };
  for (const page of pages) {
    const diagram = {
      tag: "diagram",
      attrs: { name: page.name || "Page-1" },
      children: page.model ? [page.model] : [],
      text: "",
    };
    mxfile.children.push(diagram);
  }
  return mxfile;
}

/**
 * Save pages to a .drawio file. Always writes uncompressed XML payloads
 * (compressed saving is not required — draw.io itself will happily open
 * uncompressed pages).
 */
export function saveFile(path, pages) {
  const skeleton = mxfileSkeleton(pages);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` + serialize(skeleton, { indent: 2 }) + "\n";
  fs.writeFileSync(path, xml, "utf8");
}

/**
 * Iterate all mxCell nodes under a model's <root>, unwrapping
 * UserObject/object wrappers. Yields { cell, wrapper } where `wrapper`
 * is the UserObject/object element if the cell was wrapped, else null.
 */
export function* walkCells(model) {
  const root = find(model, "root");
  if (!root) return;
  for (const child of root.children) {
    if (child.tag === "mxCell") {
      yield { cell: child, wrapper: null };
    } else if (WRAPPER_TAGS.has(child.tag)) {
      const inner = find(child, "mxCell");
      if (inner) yield { cell: inner, wrapper: child };
    }
  }
}

/** Parse a draw.io style string ("k1=v1;k2=v2;shape;") into a map. */
export function styleToMap(styleStr) {
  const map = {};
  if (!styleStr) return map;
  for (const part of styleStr.split(";")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq === -1) {
      map[part] = "";
    } else {
      map[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return map;
}

/** Serialize a style map back into a draw.io style string. */
export function mapToStyle(map) {
  let out = "";
  for (const [k, v] of Object.entries(map)) {
    out += v === "" ? `${k};` : `${k}=${v};`;
  }
  return out;
}

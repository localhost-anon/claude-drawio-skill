#!/usr/bin/env node
// Search 10k+ official draw.io shapes for their exact style strings.
//
// Usage: shapesearch.mjs "aws lambda" [--limit N] [--json]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "./lib/args.mjs";

const SKILL_DIR = path.dirname(import.meta.dirname);
export const INDEX = path.join(SKILL_DIR, "data", "shape-index.json.gz");
const SOUNDEX_MAP = "01230120022455012603010202"; // A..Z digit codes
const TRAIL = /\.*\d*$/;

function soundex(name) {
  if (!name) return "";
  const s = [name[0].toUpperCase()];
  let si = 1;
  for (const ch of name.slice(1)) {
    const c = ch.toUpperCase().charCodeAt(0) - 65;
    if (c >= 0 && c <= 25 && SOUNDEX_MAP[c] !== "0") {
      const code = SOUNDEX_MAP[c];
      if (code !== s[si - 1]) {
        s.push(code);
        si++;
        if (si > 3) break;
      }
    }
  }
  while (s.length < 4) s.push("0");
  return s.slice(0, 4).join("");
}

// tag (and its Soundex) -> Set of shape indices.
export function buildTagMap(shapes) {
  const tagMap = new Map();
  shapes.forEach((shape, i) => {
    const raw = shape.tags;
    if (!raw) return;
    const seen = new Set();
    for (const token of raw.toLowerCase().replace(/[/,()]/g, " ").split(" ")) {
      if (token.length < 2 || seen.has(token)) continue;
      seen.add(token);
      if (!tagMap.has(token)) tagMap.set(token, new Set());
      tagMap.get(token).add(i);
      const sx = soundex(token.replace(TRAIL, ""));
      if (sx && sx !== token && !seen.has(sx)) {
        seen.add(sx);
        if (!tagMap.has(sx)) tagMap.set(sx, new Set());
        tagMap.get(sx).add(i);
      }
    }
  });
  return tagMap;
}

// 'pid2misc' -> ['pid','misc']; 'discInst' -> ['disc','inst'].
function splitCompound(token) {
  let spaced = token.replace(/([a-z])([A-Z])/g, "$1 $2");
  spaced = spaced.replace(/([a-zA-Z])(\d)/g, "$1 $2");
  spaced = spaced.replace(/(\d)([a-zA-Z])/g, "$1 $2");
  return spaced
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length >= 2);
}

export function matchTerm(tagMap, term) {
  const exact = new Set(tagMap.get(term) || []);
  let phonetic = new Set();
  const sx = soundex(term.replace(TRAIL, ""));
  if (sx && sx !== term) {
    for (const i of tagMap.get(sx) || []) {
      if (!exact.has(i)) phonetic.add(i);
    }
  }
  return [exact, phonetic];
}

export function search(shapes, tagMap, query, limit) {
  if (!query) return [];
  const terms = [];
  const seen = new Set();
  for (const raw of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const subs = splitCompound(raw).length ? splitCompound(raw) : raw.length >= 2 ? [raw] : [];
    for (const t of subs) {
      if (!seen.has(t)) {
        seen.add(t);
        terms.push(t);
      }
    }
  }
  if (!terms.length) return [];

  const termMatches = terms.map((t) => matchTerm(tagMap, t));

  // Strict AND across all terms first.
  let andSet = null;
  for (const [exact, phonetic] of termMatches) {
    const combined = new Set([...exact, ...phonetic]);
    if (andSet === null) {
      andSet = combined;
    } else {
      andSet = new Set([...andSet].filter((i) => combined.has(i)));
    }
    if (andSet.size === 0) break;
  }

  // Score: +1.0 exact, +0.5 Soundex-only, per term. AND results if any, else OR.
  const scores = new Map();
  const pool = andSet && andSet.size ? andSet : null;
  for (const [exact, phonetic] of termMatches) {
    for (const idx of exact) {
      if (pool === null || pool.has(idx)) {
        scores.set(idx, (scores.get(idx) || 0) + 1.0);
      }
    }
    for (const idx of phonetic) {
      if ((pool === null || pool.has(idx)) && !exact.has(idx)) {
        scores.set(idx, (scores.get(idx) || 0) + 0.5);
      }
    }
  }

  const termSet = new Set(terms);
  function titleHits(idx) {
    const toks = new Set((shapes[idx].title || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    let n = 0;
    for (const t of termSet) if (toks.has(t)) n++;
    return n;
  }

  const ranked = [...scores.keys()].sort((a, b) => {
    const sa = scores.get(a);
    const sb = scores.get(b);
    if (sa !== sb) return sb - sa;
    const ha = titleHits(a);
    const hb = titleHits(b);
    if (ha !== hb) return hb - ha;
    const ta = (shapes[a].title || "").toLowerCase();
    const tb = (shapes[b].title || "").toLowerCase();
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a - b;
  });

  return ranked
    .slice(0, limit)
    .map((i) => ({ style: shapes[i].style, w: shapes[i].w, h: shapes[i].h, title: shapes[i].title }));
}

// Only run the CLI when this file is executed directly (not when imported as
// a module by tfimports.mjs/tfstate.mjs, mirroring the Python original's
// `if __name__ == "__main__":` guard around its CLI-only code).
function isMainModule() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}
if (isMainModule()) {
  const a = parseArgs({
    name: "shapesearch",
    usage: 'Usage: shapesearch.mjs "aws lambda" [--limit N] [--json]',
    flags: {
      limit: { takesValue: true },
      json: {},
    },
  }, process.argv.slice(2));

  if (a._.length !== 1) die('need exactly one query, e.g. "aws lambda"');
  const query = a._[0];
  const limit = a.limit != null ? parseInt(a.limit, 10) : 10;

  if (!fs.existsSync(INDEX)) {
    process.stderr.write(`error: shape index not found at ${INDEX}\n`);
    process.exit(1);
  }
  const shapes = JSON.parse(zlib.gunzipSync(fs.readFileSync(INDEX)).toString("utf8"));

  const results = search(shapes, buildTagMap(shapes), query, limit);
  if (!results.length) {
    process.stderr.write(`no shapes matched '${query}'\n`);
    process.exit(1);
  }
  if (a.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.title}  (${r.w}x${r.h})\n  ${r.style}`);
    }
  }
}

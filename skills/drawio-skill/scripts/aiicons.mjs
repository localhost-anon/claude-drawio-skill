#!/usr/bin/env node
// Find AI / LLM brand logos (OpenAI, Claude, Gemini, ...) as draw.io styles.
//
// draw.io's bundled shape libraries have no modern AI/LLM brand logos, so an
// "LLM app architecture" renders as generic boxes. This resolves a brand name to a
// draw.io `image` style that references the matching SVG from the lobe-icons set
// (https://github.com/lobehub/lobe-icons, MIT) on the unpkg CDN.
//
//   node aiicons.mjs "openai"
//   node aiicons.mjs "claude" --json
//   node aiicons.mjs "langchain" --variant mono --size 48
//
// The icon is referenced by URL (data/lobe-icons.json carries only the name list,
// not the assets), so draw.io fetches it from the CDN when the diagram is rendered
// or opened. That means **network is required at render time**; an offline export
// draws a blank box. Use --embed to fetch the SVG once and inline it as a
// self-contained data URI instead (portable, no network at render time).
//
// The logos are trademarks of their respective owners and are referenced here for
// identification only — the same basis on which draw.io ships AWS/Azure icons.
//
// Usage: aiicons.mjs <query> [--limit N] [--variant color|mono|text]
//                            [--size PX] [--embed] [--json] [--list]
import fs from "node:fs";
import path from "node:path";
import { parseArgs, die } from "./lib/args.mjs";

const SKILL_DIR = path.dirname(import.meta.dirname);
const MANIFEST = path.join(SKILL_DIR, "data", "lobe-icons.json");
const STYLE = "shape=image;html=1;imageAspect=0;aspect=fixed;" +
  "verticalLabelPosition=bottom;verticalAlign=top;image=";
const VARIANT_RE = /-(?:color|text(?:-[a-z]{2})?|brand(?:-color)?)$/;

// Common RAG/LLM data stores that lobe-icons lacks, mapped to simple-icons
// slugs (https://simpleicons.org, CC0). Served from the simple-icons CDN. Each
// slug below is verified to return HTTP 200 at https://cdn.simpleicons.org/<slug>.
const SIMPLEICONS_CDN = "https://cdn.simpleicons.org/";
const SUPPLEMENT = {
  qdrant: "qdrant",
  milvus: "milvus",
  supabase: "supabase",
  redis: "redis",
  postgresql: "postgresql",
  mongodb: "mongodb",
  elasticsearch: "elasticsearch",
  neo4j: "neo4j",
  kafka: "apachekafka",
  clickhouse: "clickhouse",
  duckdb: "duckdb",
  mysql: "mysql",
  sqlite: "sqlite",
  cassandra: "apachecassandra",
  snowflake: "snowflake",
  databricks: "databricks",
  mariadb: "mariadb",
  couchbase: "couchbase",
};

// base brand name -> Set of its variant filenames (without .svg).
function families(icons) {
  const fam = new Map();
  for (const name of icons) {
    const base = name.replace(VARIANT_RE, "");
    if (!fam.has(base)) fam.set(base, new Set());
    fam.get(base).add(name);
  }
  return fam;
}

function squish(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Rank brand bases against the query (squished + per-token matching).
function search(fam, query, limit) {
  const q = squish(query);
  const tokens = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter(Boolean);
  const scored = new Map();
  for (const base of fam.keys()) {
    const b = squish(base);
    let s = 0;
    if (q && q === b) {
      s = 100;
    } else if (q && b.startsWith(q)) {
      s = 60;
    } else if (q && b.includes(q)) {
      s = 40;
    }
    for (const t of tokens) {
      if (t === b) {
        s = Math.max(s, 90);
      } else if (t.length >= 3 && b.startsWith(t)) {
        s = Math.max(s, 50);
      } else if (t.length >= 3 && b.includes(t)) {
        s = Math.max(s, 30);
      }
    }
    if (s) scored.set(base, s);
  }
  return [...scored.keys()]
    .sort((x, y) => scored.get(y) - scored.get(x) || (x < y ? -1 : x > y ? 1 : 0))
    .slice(0, limit);
}

// Fall back to the simple-icons supplement (exact or substring match).
function searchSupplement(query) {
  const q = squish(query);
  if (!q) return null;
  if (Object.prototype.hasOwnProperty.call(SUPPLEMENT, q)) return q;
  for (const brand of Object.keys(SUPPLEMENT)) {
    if (q.includes(brand) || brand.includes(q)) return brand;
  }
  return null;
}

function pickVariant(base, variants, prefer) {
  const order = {
    color: ["-color", "-brand-color", "", "-brand", "-text", "-text-cn"],
    mono: ["", "-brand", "-color", "-brand-color", "-text", "-text-cn"],
    text: ["-text", "-text-cn", "-brand", "-brand-color", "-color", ""],
  }[prefer];
  for (const suffix of order) {
    const cand = base + suffix;
    if (variants.has(cand)) return cand;
  }
  const sorted = [...variants].sort();
  return sorted.length ? sorted[0] : null;
}

async function main() {
  const a = parseArgs({
    name: "aiicons",
    usage: "Usage: aiicons.mjs <query> [--limit N] [--variant color|mono|text]\n" +
      "                            [--size PX] [--embed] [--json] [--list]",
    flags: {
      limit: { takesValue: true },
      variant: { takesValue: true },
      size: { takesValue: true },
      embed: {},
      json: {},
      list: {},
    },
  }, process.argv.slice(2));

  if (a._.length > 1) die("too many arguments");

  if (!fs.existsSync(MANIFEST)) {
    process.stderr.write(`error: manifest not found at ${MANIFEST}\n`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const fam = families(manifest.icons);
  const cdn = manifest.cdn;

  if (a.list) {
    for (const base of [...fam.keys()].sort()) console.log(base);
    return;
  }
  const query = a._[0];
  if (!query) die("a query is required (or use --list)");

  const limit = a.limit != null ? parseInt(a.limit, 10) : 8;
  const variant = a.variant != null ? a.variant : "color";
  if (variant !== "color" && variant !== "mono" && variant !== "text") {
    die(`argument --variant: invalid choice: '${variant}' (choose from 'color', 'mono', 'text')`);
  }
  const size = a.size != null ? parseInt(a.size, 10) : 48;

  const matches = search(fam, query, limit);

  const results = [];
  if (matches.length) {
    for (const base of matches) {
      const file = pickVariant(base, fam.get(base), variant);
      const url = `${cdn}${file}.svg`;
      let image;
      if (a.embed) {
        let svg;
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          svg = Buffer.from(await resp.arrayBuffer());
        } catch (exc) {
          process.stderr.write(`warning: could not fetch ${url} (${exc.message || exc})\n`);
          continue;
        }
        // Rewrite the 1em intrinsic size so draw.io scales the inlined SVG.
        svg = Buffer.from(
          svg.toString("latin1").split('width="1em"').join('width="24"').split('height="1em"').join('height="24"'),
          "latin1"
        );
        // Marker-less base64: draw.io splits style values on ';', so a
        // ';base64,' marker would truncate the image= value (issue #80).
        image = "data:image/svg+xml," + svg.toString("base64");
      } else {
        image = url;
      }
      results.push({ brand: base, file, w: size, h: size, style: STYLE + image });
    }
  } else {
    // lobe has no logo for this brand; fall back to the simple-icons supplement.
    const brand = searchSupplement(query);
    if (brand) {
      const slug = SUPPLEMENT[brand];
      const url = SIMPLEICONS_CDN + slug;
      let image = url;
      if (a.embed) {
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const svg = Buffer.from(await resp.arrayBuffer());
          // Marker-less base64 (see issue #80 note above).
          image = "data:image/svg+xml," + svg.toString("base64");
        } catch (exc) {
          process.stderr.write(`warning: could not fetch ${url} (${exc.message || exc}); using CDN URL\n`);
        }
      }
      results.push({ brand, file: `simpleicons:${slug}`, w: size, h: size, style: STYLE + image });
    }
  }

  if (!results.length) {
    process.stderr.write(
      `no logo for '${query}' — for a data store try a cylinder (shape=cylinder3) or shapesearch.py '${query} database'\n`
    );
    process.exit(1);
  }

  if (a.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const shown = r.style.length < 160 ? r.style : r.style.slice(0, 157) + "...";
      console.log(`${r.brand}  (${r.file}, ${r.w}x${r.h})\n  ${shown}`);
    }
  }
}

main();

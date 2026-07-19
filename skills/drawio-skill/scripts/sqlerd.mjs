#!/usr/bin/env node
// Extract an ER diagram from SQL DDL as autolayout graph JSON.
// Direct port of sqlerd.py.
//
// Parses CREATE TABLE statements (regex + paren matching -- no SQL library),
// one node per table listing its columns with PK/FK markers, and one
// crow's-foot edge per foreign key (many side at the referencing table).
// The output feeds autolayout.mjs:
//
//   node sqlerd.mjs schema.sql -o graph.json
//   node autolayout.mjs graph.json -o erd.drawio
//
// Understood per table: column name + type, inline PRIMARY KEY /
// REFERENCES tab(col), table-level PRIMARY KEY (...) and
// [CONSTRAINT x] FOREIGN KEY (col) REFERENCES tab(col). Quoted identifiers
// ("t", `t`, [t]) and schema.table prefixes are normalized; edges land only
// on tables defined in the scanned files. Dialect-specific clauses beyond
// that (partitioning, generated columns, ...) are simply ignored -- worst
// case a column line is skipped, never a wrong edge.
//
// Usage: sqlerd.mjs <file.sql-or-dir> [-o graph.json]
//        [--direction TB|LR] [--group] [--no-types]
import fs from "node:fs";
import path from "node:path";
import { parseArgs, die } from "./lib/args.mjs";

const TABLE_STYLE =
  "rounded=0;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacingLeft=6;spacingTop=4;fillColor=#dae8fc;strokeColor=#6c8ebf;";
// orthogonalEdgeStyle (not entityRelationEdgeStyle) so the edge honours the
// obstacle-avoiding waypoints dot computed; ER arrows give the crow's foot.
const ER_EDGE =
  "edgeStyle=orthogonalEdgeStyle;html=1;rounded=0;fontSize=11;labelBackgroundColor=#ffffff;startArrow=ERmany;startFill=0;endArrow=ERone;endFill=0;";

const COMMENT_RE = /\/\*[\s\S]*?\*\/|--[^\n]*/g;
const CREATE_RE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`[\]]+)\s*\(/gi;
const FK_RE = /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([\w."`[\]]+)\s*(?:\(([^)]+)\))?/i;
const PK_RE = /PRIMARY\s+KEY\s*\(([^)]+)\)/i;
const INLINE_REF_RE = /\bREFERENCES\s+([\w."`[\]]+)/i;
const SKIP_RE = /^\s*(CONSTRAINT|UNIQUE|CHECK|KEY|INDEX|FULLTEXT|SPATIAL|EXCLUDE|LIKE)\b/i;
const PRIMARY_KEY_ANYWHERE_RE = /\bPRIMARY\s+KEY\b/i;

// Normalize an identifier: strip quoting, keep the last dotted part.
function ident(raw) {
  const stripped = raw.trim().replace(/^["`[\]]+|["`[\]]+$/g, "");
  const parts = stripped.split(".");
  const name = parts[parts.length - 1].replace(/^["`[\]]+|["`[\]]+$/g, "");
  return name.toLowerCase();
}

// Split a CREATE TABLE body on top-level commas.
function splitColumns(body) {
  const items = [];
  let depth = 0;
  let cur = [];
  for (const ch of body) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      items.push(cur.join("").trim());
      cur = [];
    } else {
      cur.push(ch);
    }
  }
  if (cur.join("").trim()) items.push(cur.join("").trim());
  return items;
}

// {table: {schema, columns: [[name, type]], pks: Set, fks: [[col, table]]}}
function parseTables(rawText) {
  const text = rawText.replace(COMMENT_RE, "");
  const tables = {};
  CREATE_RE.lastIndex = 0;
  let m;
  while ((m = CREATE_RE.exec(text))) {
    const rawName = m[1];
    let depth = 1;
    let i = CREATE_RE.lastIndex;
    while (i < text.length && depth) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
      i += 1;
    }
    const body = text.slice(CREATE_RE.lastIndex, i - 1);
    CREATE_RE.lastIndex = i;
    const name = ident(rawName);
    const parts = rawName.trim().replace(/^["`[\]]+|["`[\]]+$/g, "").split(".");
    const schema = parts.length > 1 ? ident(parts[parts.length - 2]) : "";
    const cols = [];
    const pks = new Set();
    const fks = [];
    for (const item of splitColumns(body)) {
      const fk = FK_RE.exec(item);
      if (fk) {
        for (const col of fk[1].split(",")) fks.push([ident(col), ident(fk[2])]);
        continue;
      }
      const pk = PK_RE.exec(item);
      if (pk && SKIP_RE.test(item) === false && /^\s*PRIMARY/i.test(item.toUpperCase().trimStart())) {
        for (const c of pk[1].split(",")) pks.add(ident(c));
        continue;
      }
      if (SKIP_RE.test(item)) continue;
      const toks = item.split(/\s+/).filter(Boolean);
      if (toks.length < 2) continue;
      const col = ident(toks[0]);
      const ctype = toks[1].replace(/,$/, "");
      cols.push([col, ctype]);
      if (PRIMARY_KEY_ANYWHERE_RE.test(item)) pks.add(col);
      const ref = INLINE_REF_RE.exec(item);
      if (ref) fks.push([col, ident(ref[1])]);
    }
    tables[name] = { schema, columns: cols, pks, fks };
  }
  return tables;
}

function discoverSqlFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".sql")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function main() {
  const a = parseArgs(
    {
      name: "sqlerd",
      usage: "Usage: sqlerd.mjs <file.sql-or-dir> [-o graph.json] [--direction TB|LR] [--group] [--no-types]",
      flags: {
        output: { short: "-o", takesValue: true },
        direction: { takesValue: true, default: "TB" },
        group: {},
        "no-types": {},
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("the following arguments are required: path");
  if (!["TB", "LR"].includes(a.direction)) die(`argument --direction: invalid choice: '${a.direction}' (choose from 'TB', 'LR')`);

  const p = a._[0];
  const isFile = fs.existsSync(p) && fs.statSync(p).isFile();
  const files = isFile ? [p] : discoverSqlFiles(p);

  let tables = {};
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    tables = { ...tables, ...parseTables(text) };
  }
  if (!Object.keys(tables).length) die(`no CREATE TABLE statements found under ${p}`);

  const nodes = [];
  const edges = [];
  for (const [name, t] of Object.entries(tables)) {
    const fkCols = new Set(t.fks.map(([c]) => c));
    const lines = [name];
    for (const [col, ctype] of t.columns) {
      const mark = t.pks.has(col) ? "PK " : fkCols.has(col) ? "FK " : "";
      lines.push(`${mark}${col}` + (a["no-types"] ? "" : `: ${ctype}`));
    }
    const width = Math.max(160, Math.ceil(Math.max(...lines.map((l) => 7 * l.length + 30)) / 10) * 10);
    const height = Math.ceil((30 + 20 * t.columns.length) / 10) * 10;
    const node = { id: name, label: lines.join("\n"), style: TABLE_STYLE, width, height };
    if (a.group && t.schema) node.group = t.schema;
    nodes.push(node);
    for (const [col, ref] of t.fks) {
      if (Object.prototype.hasOwnProperty.call(tables, ref) && ref !== name) {
        edges.push({ source: name, target: ref, label: col, style: ER_EDGE });
      }
    }
  }

  const graph = { direction: a.direction, nodes, edges };
  const text = JSON.stringify(graph, null, 2);
  if (a.output) {
    fs.writeFileSync(a.output, text, "utf8");
    process.stderr.write(`wrote ${a.output}\n`);
  } else {
    process.stdout.write(text);
  }
  process.stderr.write(`${nodes.length} tables, ${edges.length} foreign keys\n`);
}

main();

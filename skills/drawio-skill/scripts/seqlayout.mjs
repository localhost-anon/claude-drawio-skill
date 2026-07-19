#!/usr/bin/env node
// Deterministic sequence-diagram layout: message list JSON -> .drawio XML.
//
// Node port of seqlayout.py. Pure arithmetic (no Graphviz), so this is a
// byte-for-byte port of the Python output.
//
// Input JSON:
//   {
//     "title": "Login flow",
//     "participants": [ {"id":"u","label":"User","actor":true}, {"id":"s","label":"Server"} ],
//     "messages": [
//       {"from":"u","to":"s","label":"POST /login"},
//       {"from":"s","to":"s","label":"validate()"},
//       {"from":"s","to":"u","label":"200 OK","return":true},
//       {"from":"u","to":"s","label":"notify","async":true},
//       {"note":"token cached","over":"s"}
//     ]
//   }
//
// Usage: seqlayout.mjs <seq.json> [-o diagram.drawio]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";

const LIFELINE_W = 100, HEADER_H = 40;
const BAR_W = 10;
const TOP = 40, ROW = 50, SELF_ROW = 70, NOTE_ROW = 60, BOTTOM_PAD = 40;
const MIN_SPACING = 200;

const LIFELINE =
  "shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;" +
  "container=1;dropTarget=0;collapsible=0;recursiveResize=0;outlineConnect=0;" +
  `portConstraint=eastwest;size=${HEADER_H};`;
const ACTOR = LIFELINE + "participant=umlActor;verticalAlign=bottom;spacingBottom=-14;labelBackgroundColor=#ffffff;";
const BAR = "html=1;points=[];perimeter=orthogonalPerimeter;outlineConnect=0;fillColor=#ffffff;";
const NOTE = "shape=note;whiteSpace=wrap;html=1;size=14;fillColor=#fff2cc;strokeColor=#d6b656;";
const SYNC = "html=1;verticalAlign=bottom;endArrow=block;curved=0;rounded=0;";
const ASYNC = "html=1;verticalAlign=bottom;endArrow=open;dashed=1;curved=0;rounded=0;";
const RETURN =
  "html=1;verticalAlign=bottom;endArrow=open;dashed=1;curved=0;rounded=0;" +
  "strokeColor=#999999;fontColor=#999999;";

function attr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#xa;");
}

function sysExit(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// Round half-to-even to `nd` decimals, matching Python's round().
function roundHalfEven(x, nd) {
  const m = 10 ** nd;
  const v = x * m;
  const f = Math.floor(v);
  const diff = v - f;
  let r;
  if (diff > 0.5) r = f + 1;
  else if (diff < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  return r / m;
}

// Format a float the way Python str(float) does for values produced by frac():
// integral values render with a trailing ".0"; others use the shortest repr.
function pyFloatStr(r) {
  if (Number.isInteger(r)) return `${r}.0`;
  return String(r);
}

function frac(y, top, height) {
  const v = Math.max(0.0, Math.min(1.0, (y - top) / height));
  return pyFloatStr(roundHalfEven(v, 4));
}

function layout(spec) {
  const parts = spec.participants;
  if (!parts || parts.length === 0) sysExit("error: no participants");
  const order = new Map();
  parts.forEach((p, i) => order.set(p.id, i));
  if (order.size !== parts.length) sysExit("error: duplicate participant ids");

  let spacing = Math.max(MIN_SPACING, ...parts.map((p) => 7 * String(p.label ?? p.id).length + 80));
  spacing = Math.ceil(spacing / 10) * 10;
  const cx = new Map();
  parts.forEach((p, i) => cx.set(p.id, TOP + i * spacing + Math.floor(LIFELINE_W / 2)));

  let y = TOP + HEADER_H + 50;
  const rows = [];
  const openBar = new Map();
  const bars = [];

  const close = (pid, at) => {
    if (openBar.has(pid)) {
      bars.push([pid, openBar.get(pid), at]);
      openBar.delete(pid);
    }
  };

  const messages = spec.messages || [];
  messages.forEach((m, i) => {
    if ("note" in m) {
      rows.push(["note", m, y]);
      y += NOTE_ROW;
      return;
    }
    const src = m.from, dst = m.to;
    if (!order.has(src) || !order.has(dst)) sysExit(`error: message ${i} references unknown participant`);
    const isReturn = m.return ?? false;
    if (src === dst) {
      rows.push(["self", m, y]);
      y += SELF_ROW;
      return;
    }
    rows.push(["msg", m, y]);
    if (isReturn) {
      close(src, y);
    } else if ((m.activate ?? true) && !openBar.has(dst)) {
      openBar.set(dst, y);
    }
    if (m.deactivate) close(src, y);
    y += ROW;
  });
  const height = y + BOTTOM_PAD - TOP;
  for (const pid of [...openBar.keys()]) close(pid, TOP + height - BOTTOM_PAD);

  const cells = [];
  for (const p of parts) {
    const style = p.actor ? ACTOR : LIFELINE;
    cells.push(
      `        <mxCell id="${attr(p.id)}" value="${attr(p.label ?? p.id)}" ` +
        `style="${style}" vertex="1" parent="1">\n` +
        `          <mxGeometry x="${cx.get(p.id) - Math.floor(LIFELINE_W / 2)}" y="${TOP}" ` +
        `width="${LIFELINE_W}" height="${height}" as="geometry"/>\n` +
        "        </mxCell>"
    );
  }

  const barOf = new Map(); // pid -> [[y0, y1, id], ...]
  bars.forEach(([pid, y0, y1], n) => {
    const bid = `act${n}`;
    if (!barOf.has(pid)) barOf.set(pid, []);
    barOf.get(pid).push([y0, y1, bid]);
    cells.push(
      `        <mxCell id="${bid}" value="" style="${BAR}" vertex="1" ` +
        `parent="${attr(pid)}">\n` +
        `          <mxGeometry x="${Math.floor(LIFELINE_W / 2) - Math.floor(BAR_W / 2)}" y="${y0 - TOP}" ` +
        `width="${BAR_W}" height="${y1 - y0}" as="geometry"/>\n` +
        "        </mxCell>"
    );
  });

  // Returns [cell_id, sideValueStr, fracStr].
  const anchor = (pid, my, side) => {
    for (const [y0, y1, bid] of barOf.get(pid) || []) {
      if (y0 <= my && my <= y1) {
        return [bid, side === "right" ? "1" : "0", frac(my, y0, y1 - y0)];
      }
    }
    return [pid, "0.5", frac(my, TOP, height)];
  };

  rows.forEach(([kind, m, my], i) => {
    if (kind === "note") {
      const pid = m.over;
      if (!cx.has(pid)) sysExit(`error: note ${i} is over unknown participant ${pyRepr(pid)}`);
      const w = Math.max(120, 7 * String(m.note).length + 30);
      cells.push(
        `        <mxCell id="note${i}" value="${attr(m.note)}" style="${NOTE}" ` +
          `vertex="1" parent="1">\n` +
          `          <mxGeometry x="${cx.get(pid) + 20}" y="${my - 20}" ` +
          `width="${Math.min(w, spacing - 60)}" height="40" as="geometry"/>\n` +
          "        </mxCell>"
      );
      return;
    }
    const src = m.from, dst = m.to;
    const style = m.return ? RETURN : m.async ? ASYNC : SYNC;
    if (kind === "self") {
      const [sid, sx, sy] = anchor(src, my, "right");
      const [, tx, ty] = anchor(src, my + 30, "right");
      const loopX = cx.get(src) + 60;
      cells.push(
        `        <mxCell id="m${i}" value="${attr(m.label ?? "")}" ` +
          `style="${style}exitX=${sx};exitY=${sy};entryX=${tx};entryY=${ty};" ` +
          `edge="1" parent="1" source="${attr(sid)}" target="${attr(sid)}">\n` +
          `          <mxGeometry relative="1" as="geometry">\n` +
          `            <Array as="points">` +
          `<mxPoint x="${loopX}" y="${my}"/><mxPoint x="${loopX}" y="${my + 30}"/>` +
          `</Array>\n` +
          "          </mxGeometry>\n" +
          "        </mxCell>"
      );
      return;
    }
    const rightward = order.get(src) < order.get(dst);
    const [sid, sx, sy] = anchor(src, my, rightward ? "right" : "left");
    const [tid, tx, ty] = anchor(dst, my, rightward ? "left" : "right");
    cells.push(
      `        <mxCell id="m${i}" value="${attr(m.label ?? "")}" ` +
        `style="${style}exitX=${sx};exitY=${sy};entryX=${tx};entryY=${ty};" ` +
        `edge="1" parent="1" source="${attr(sid)}" target="${attr(tid)}">\n` +
        `          <mxGeometry relative="1" as="geometry"/>\n` +
        "        </mxCell>"
    );
  });

  const name = attr(spec.title ?? "Sequence");
  return (
    `<mxfile>\n  <diagram id="seqlayout" name="${name}">\n` +
    '    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" ' +
    'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ' +
    'pageWidth="850" pageHeight="1100" math="0" shadow="0">\n' +
    "      <root>\n" +
    '        <mxCell id="0"/>\n' +
    '        <mxCell id="1" parent="0"/>\n' +
    cells.join("\n") +
    "\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n"
  );
}

// Python repr() of a string, used in one error message.
function pyRepr(s) {
  if (s === null || s === undefined) return "None";
  return `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

async function main() {
  const a = parseArgs(
    {
      name: "seqlayout",
      usage: "Usage: seqlayout.mjs <seq.json> [-o diagram.drawio]",
      flags: { output: { short: "-o", takesValue: true } },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("need exactly one <seq.json>");
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(a._[0], "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") die(`[Errno 2] No such file or directory: '${a._[0]}'`);
    die(String(e.message || e));
  }
  const xml = layout(spec);
  if (a.output) {
    fs.writeFileSync(a.output, xml, "utf8");
    process.stderr.write(
      `wrote ${a.output} (${spec.participants.length} participants, ${(spec.messages || []).length} messages)\n`
    );
  } else {
    process.stdout.write(xml);
  }
}

await main();

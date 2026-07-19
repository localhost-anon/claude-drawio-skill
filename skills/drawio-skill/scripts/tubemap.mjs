#!/usr/bin/env node
// Restyle a graph as a London-Underground-style metro map (Tube-Map Mode).
//
// Node port of tubemap.py. Input JSON describes coloured *lines* (each an
// ordered list of station ids) and the *stations* they pass through, placed
// on an integer grid. The script snaps stations to a pixel grid, routes
// every line segment octilinearly (horizontal / vertical / 45° diagonal,
// inserting one bend when two stations are not already aligned), draws
// thick coloured line strokes, marks interchange stations as white-fill
// black-ring circles and regular stops as small white circles, and labels
// each station — the classic tube-map look — as an editable `.drawio`.
//
// Pure and deterministic (no dot / no elkjs layout): builds XML directly
// from the metro description, same as the Python original.
//
// Usage: tubemap.mjs <metro.json> [-o out.drawio] [--grid N]
import fs from "node:fs";
import { parseArgs, die } from "./lib/args.mjs";

// Default palette (approx. real tube-line colours), cycled for lines lacking a "color".
export const TUBE_PALETTE = [
  "#0098d4", // blue
  "#007d32", // green
  "#e1251b", // red
  "#ee7c0e", // orange
  "#9b0056", // magenta
  "#00a4a7", // teal
  "#ffce00", // yellow
  "#894e24", // brown
];

export function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Waypoints so the path is horizontal, vertical, or 45°: diagonal then
 * straight. Returns [] when the two points are already octilinearly
 * aligned, else a single bend point (run the 45° diagonal for the shorter
 * delta, then a straight axis segment).
 */
export function octilinearWaypoints(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) return [];
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const d = Math.min(Math.abs(dx), Math.abs(dy));
  if (Math.abs(dx) > Math.abs(dy)) return [[x1 + sx * d, y2]]; // diagonal first, then horizontal into the target
  return [[x2, y1 + sy * d]]; // diagonal first, then vertical into the target
}

/** Build the tube-map `.drawio` XML string from the parsed metro description. */
export function build(data, grid = 110) {
  const stations = data.stations || {};
  const lines = data.lines || [];
  if (!Object.keys(stations).length) throw new Error("no stations in input");
  for (const ln of lines) {
    for (const sid of ln.stations || []) {
      if (!(sid in stations)) throw new Error(`line ${JSON.stringify(ln.name || "?")} references unknown station id ${JSON.stringify(sid)}`);
    }
  }

  const ox = 80, oy = 80;
  const G = grid;

  function px(sid) {
    const s = stations[sid];
    return [ox + parseInt(s.gx, 10) * G, oy + parseInt(s.gy, 10) * G];
  }

  const maxx = ox + Math.max(...Object.values(stations).map((s) => parseInt(s.gx, 10))) * G + 220;
  const maxy = oy + Math.max(...Object.values(stations).map((s) => parseInt(s.gy, 10))) * G + 120;
  const lw = Math.max(8, Math.trunc(G / 12));

  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mxfile host="drawio-skill" type="device">',
    '  <diagram id="tube" name="Tube Map">',
    `    <mxGraphModel dx="0" dy="0" grid="0" gridSize="10" pageWidth="${maxx}" ` +
      `pageHeight="${maxy}" math="0" shadow="0" background="#ffffff">`,
    "      <root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>",
  ];

  let nid = 2;
  function cid() {
    return nid++;
  }

  // 1) Line strokes first, so station markers sit on top of them.
  lines.forEach((ln, i) => {
    const col = ln.color || TUBE_PALETTE[i % TUBE_PALETTE.length];
    const sts = ln.stations || [];
    for (let j = 0; j < sts.length - 1; j++) {
      const a = sts[j], b = sts[j + 1];
      const [x1, y1] = px(a);
      const [x2, y2] = px(b);
      const wps = octilinearWaypoints(x1, y1, x2, y2);
      let arr = "";
      if (wps.length) {
        const pts = wps.map(([wx, wy]) => `<mxPoint x="${wx}" y="${wy}"/>`).join("");
        arr = `<Array as="points">${pts}</Array>`;
      }
      out.push(
        `        <mxCell id="e${cid()}" edge="1" parent="1" ` +
          `style="endArrow=none;startArrow=none;strokeColor=${col};strokeWidth=${lw};` +
          `rounded=1;html=1;edgeStyle=none;">` +
          `<mxGeometry relative="1" as="geometry">` +
          `<mxPoint x="${x1}" y="${y1}" as="sourcePoint"/>` +
          `<mxPoint x="${x2}" y="${y2}" as="targetPoint"/>${arr}</mxGeometry></mxCell>`
      );
    }
  });

  // 2) Station markers + labels.
  for (const [sid, s] of Object.entries(stations)) {
    const [x, y] = px(sid);
    const label = esc(String(s.label !== undefined ? s.label : sid));
    let r, marker;
    if (s.interchange) {
      r = lw + 6;
      marker = "ellipse;fillColor=#ffffff;strokeColor=#111111;strokeWidth=3;html=1;";
    } else {
      r = lw - 1;
      marker = "ellipse;fillColor=#ffffff;strokeColor=#555555;strokeWidth=2;html=1;";
    }
    out.push(
      `        <mxCell id="s${cid()}" vertex="1" parent="1" style="${marker}" ` +
        `value=""><mxGeometry x="${x - r}" y="${y - r}" width="${2 * r}" ` +
        `height="${2 * r}" as="geometry"/></mxCell>`
    );
    out.push(
      `        <mxCell id="l${cid()}" vertex="1" parent="1" ` +
        `style="text;html=1;align=left;verticalAlign=middle;fontSize=13;fontStyle=1;` +
        `fontColor=#222222;labelBackgroundColor=#ffffff;" value="${label}">` +
        `<mxGeometry x="${x + lw + 8}" y="${y - 12}" width="170" height="24" ` +
        `as="geometry"/></mxCell>`
    );
  }

  out.push("      </root></mxGraphModel></diagram></mxfile>");
  return [out.join("\n"), Object.keys(stations).length, lines.length];
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

async function main() {
  const a = parseArgs(
    {
      name: "tubemap",
      usage: "Usage: tubemap.mjs <metro.json> [-o out.drawio] [--grid N]",
      flags: {
        output: { short: "-o", takesValue: true },
        grid: { takesValue: true, type: "int", default: 110 },
      },
    },
    process.argv.slice(2)
  );
  if (a._.length !== 1) die("need exactly one <metro.json>");
  const input = a._[0];

  const raw = input === "-" ? readStdin() : fs.readFileSync(input, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (exc) {
    die(`bad JSON in ${input}: ${exc.message || exc}`);
  }

  let xml, nSt, nLn;
  try {
    [xml, nSt, nLn] = build(data, a.grid);
  } catch (exc) {
    die(exc.message || String(exc));
  }
  if (a.output) {
    fs.writeFileSync(a.output, xml, "utf8");
    process.stderr.write(`wrote ${a.output} (${nSt} stations, ${nLn} lines)\n`);
  } else {
    process.stdout.write(xml);
  }
}

import path from "node:path";
import { fileURLToPath } from "node:url";
function isMainModule() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}
if (isMainModule()) {
  await main();
}

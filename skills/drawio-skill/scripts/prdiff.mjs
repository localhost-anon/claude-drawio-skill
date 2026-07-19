#!/usr/bin/env node
// Render base/head/diff PNGs for every .drawio changed between two git refs.
//
// Node port of prdiff.py.
//
// For each `.drawio` that differs between `--base` and `--head`, exports the
// base and head pages as PNGs via the draw.io CLI, and — for files present on
// both sides — chains `drawiodiff.mjs` -> `autolayout.mjs` -> CLI export into a
// third colour-coded diff PNG. Added/removed files just get the one side that
// exists. Emits a Markdown report with one section per changed file (status +
// image links) and a summary count, suitable for a PR comment or CI job
// summary; pair with `.github/actions/drawio-diff/`.
//
//   node prdiff.mjs --base origin/main --head HEAD -o drawio-pr/report.md
//
// Missing draw.io CLI degrades gracefully: the Markdown still lists every
// changed file, just without images (a review comment listing the files is
// still useful). Missing git, or `--repo` not a git repository, is fatal.
//
// Usage: prdiff.mjs --base <ref> [--head <ref>] [--repo <dir>] [--out-dir <dir>] [-o report.md]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "./lib/args.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * List of {path, status} for .drawio files that differ between base and head.
 *
 * status is "added", "removed", or "modified" (renames/copies count as
 * modified, keyed on the new path). Shells to `git diff --name-status`.
 */
export function changedDrawios(base, head, repo) {
  let r;
  try {
    r = execFileSync(
      "git",
      ["-C", repo, "diff", "--name-status", `${base}..${head}`, "--", "*.drawio"],
      { encoding: "utf8" }
    );
  } catch (e) {
    if (e.code === "ENOENT") {
      die("not a git repo / git not found (git not on PATH)");
    }
    die(`not a git repo / git not found: ${(e.stderr || "").toString().trim()}`);
  }
  const entries = [];
  for (const line of r.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0];
    const p = parts[parts.length - 1];
    const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "removed" : "modified";
    entries.push([p, status]);
  }
  return entries;
}

/** Write the blob at ref:path (in repo) to dest. False if it doesn't exist there. */
export function gitShowFile(repo, ref, filePath, dest) {
  let out;
  try {
    out = execFileSync("git", ["-C", repo, "show", `${ref}:${filePath}`], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return false;
  }
  fs.writeFileSync(dest, out);
  return true;
}

/** CLI-export page 1 of srcDrawio to outPng. True on success. */
export function exportPng(srcDrawio, outPng) {
  try {
    execFileSync("drawio", ["-x", "-f", "png", "--page-index", "1", "-o", outPng, srcDrawio], { stdio: "pipe" });
  } catch {
    return false;
  }
  return fs.existsSync(outPng);
}

/** drawiodiff.mjs -> autolayout.mjs -> CLI export a coloured diff PNG. True on success. */
export function exportDiffPng(baseDrawio, headDrawio, outPng, tmp) {
  const diffJson = path.join(tmp, "diff.json");
  const diffDrawio = path.join(tmp, "diff.drawio");
  try {
    execFileSync(
      process.execPath,
      [path.join(HERE, "drawiodiff.mjs"), baseDrawio, headDrawio, "-o", diffJson],
      { stdio: "pipe" }
    );
  } catch {
    return false;
  }
  if (!fs.existsSync(diffJson)) return false;
  try {
    execFileSync(process.execPath, [path.join(HERE, "autolayout.mjs"), diffJson, "-o", diffDrawio], {
      stdio: "pipe",
    });
  } catch {
    return false;
  }
  if (!fs.existsSync(diffDrawio)) return false;
  return exportPng(diffDrawio, outPng);
}

/** One render_markdown entry: fetch both sides, export whatever PNGs it can. */
export function buildEntry(repo, base, head, filePath, status, outDir, drawioAvailable) {
  const entry = { path: filePath, status };
  if (!drawioAvailable) {
    entry.skipped = true;
    return entry;
  }
  const slug = filePath.replace(/\//g, "__");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prdiff-"));
  try {
    const baseDrawio = path.join(tmp, "base.drawio");
    const headDrawio = path.join(tmp, "head.drawio");
    const haveBase = gitShowFile(repo, base, filePath, baseDrawio);
    const haveHead = gitShowFile(repo, head, filePath, headDrawio);
    if (haveBase) {
      const p = path.join(outDir, `${slug}.base.png`);
      if (exportPng(baseDrawio, p)) entry.base_png = p;
    }
    if (haveHead) {
      const p = path.join(outDir, `${slug}.head.png`);
      if (exportPng(headDrawio, p)) entry.head_png = p;
    }
    if (haveBase && haveHead) {
      const p = path.join(outDir, `${slug}.diff.png`);
      if (exportDiffPng(baseDrawio, headDrawio, p, tmp)) entry.diff_png = p;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return entry;
}

/**
 * Pure: Markdown PR report from prdiff entries. No I/O, no CLI.
 *
 * entries: list of {path, status, base_png?, head_png?, diff_png?, skipped?}
 * — image paths (if any) are made relative to outDir for the Markdown links.
 * "skipped" means the draw.io CLI was unavailable.
 */
export function renderMarkdown(entries, outDir) {
  const counts = { added: 0, removed: 0, modified: 0 };
  for (const e of entries) counts[e.status] = (counts[e.status] || 0) + 1;
  const lines = [
    "# draw.io diagram changes",
    "",
    `${entries.length} file(s) changed: +${counts.added || 0} added, ` +
      `-${counts.removed || 0} removed, ~${counts.modified || 0} modified`,
  ];
  if (!entries.length) {
    lines.push("");
    lines.push("No `.drawio` files changed.");
    return lines.join("\n") + "\n";
  }

  const rel = (png) => (png ? path.relative(outDir, png).split(path.sep).join("/") : null);

  for (const e of entries) {
    lines.push("");
    lines.push(`## ${e.path} (${e.status})`);
    if (e.skipped) {
      lines.push("");
      lines.push("_draw.io CLI not available — images skipped._");
      continue;
    }
    const baseR = rel(e.base_png);
    const headR = rel(e.head_png);
    const diffR = rel(e.diff_png);
    lines.push("");
    if (baseR) lines.push(`![base](${baseR})`);
    if (headR) lines.push(`![head](${headR})`);
    if (diffR) lines.push(`![diff](${diffR})`);
    if (!baseR && !headR && !diffR) lines.push("_no image produced._");
  }
  return lines.join("\n") + "\n";
}

function drawioOnPath() {
  try {
    execFileSync("drawio", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const a = parseArgs(
    {
      name: "prdiff.mjs",
      usage:
        "Usage: prdiff.mjs --base <ref> [--head <ref>] [--repo <dir>] [--out-dir <dir>] [-o report.md]",
      flags: {
        base: { takesValue: true, default: null },
        head: { takesValue: true, default: "HEAD" },
        repo: { takesValue: true, default: "." },
        "out-dir": { takesValue: true, default: "drawio-pr" },
        output: { short: "-o", takesValue: true, default: null },
      },
    },
    process.argv.slice(2)
  );
  if (!a.base) die("the --base argument is required");

  const changed = changedDrawios(a.base, a.head, a.repo);
  if (!changed.length) process.stderr.write("no .drawio files changed\n");

  const drawioAvailable = drawioOnPath();
  if (!drawioAvailable && changed.length) {
    process.stderr.write(
      "warning: draw.io CLI not found - image export skipped, " +
        "Markdown will list files only (is the draw.io CLI installed?)\n"
    );
  }
  fs.mkdirSync(a["out-dir"], { recursive: true });

  const entries = changed.map(([p, status]) =>
    buildEntry(a.repo, a.base, a.head, p, status, a["out-dir"], drawioAvailable)
  );
  const report = renderMarkdown(entries, a["out-dir"]);

  if (a.output) {
    fs.writeFileSync(a.output, report, "utf8");
    process.stderr.write(`wrote ${a.output}\n`);
  } else {
    process.stdout.write(report);
  }
}

function isMainModule() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}
if (isMainModule()) {
  main();
}

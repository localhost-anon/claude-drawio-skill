# Contributing

Thanks for your interest in improving claude-drawio-skill!

## Project scope

This project is deliberately narrow. Before opening a PR, make sure it fits:

- **Claude Code only.** Support for other agents (Cursor, Copilot, Codex, OpenClaw, …)
  is out of scope and PRs adding it will be declined. The upstream
  [Agents365-ai/drawio-skill](https://github.com/Agents365-ai/drawio-skill) project
  targets multiple agents — contribute multi-agent features there.
- **Zero runtime dependencies.** Scripts run on the Node ≥ 20 standard library plus the
  single vendored `elkjs` bundle. PRs that add a `package.json` dependency, an `npx`
  call, or a runtime network fetch will be declined. If a feature truly cannot be built
  zero-dep, open an issue first to discuss.
- **The draw.io desktop CLI is the only external tool** the skill may shell out to.

## Prerequisites

- Node ≥ 20
- draw.io desktop CLI on PATH (`brew install --cask drawio` on macOS) — only needed for
  export-related work; most of the test suite runs without it.

## Development setup

```bash
git clone https://github.com/localhost-anon/claude-drawio-skill
cd claude-drawio-skill
ln -s "$PWD/skills/drawio-skill" ~/.claude/skills/drawio-skill   # optional: live-install
```

There is no build step and nothing to install.

## Running tests

```bash
node --test tests/node/*.test.mjs
```

Use the glob form — `node --test tests/node/` is flaky on some Node versions. The full
suite is ~193 tests; a handful auto-skip when the draw.io CLI is absent.

## Conventions

- Scripts live in `skills/drawio-skill/scripts/*.mjs`, start with `#!/usr/bin/env node`,
  and use the shared helpers in `scripts/lib/` (`args.mjs` for CLI parsing, `xml.mjs` /
  `drawio.mjs` for .drawio files, `layout.mjs` for auto-layout). Don't reimplement these.
- CLI behavior: errors go to stderr; usage errors exit 2, runtime errors exit 1
  (`die()`), success exits 0. `--help` always exits 0 with usage on stdout.
- Entry-point guards must be symlink-safe — use the `isMainModule()` pattern
  (`fs.realpathSync`) found in existing scripts, never compare `import.meta.url` to
  `process.argv[1]` directly (the skill is installed via symlink).
- Every behavioral change needs a test in `tests/node/`. Fixtures live in
  `tests/fixtures/` — keep them tiny and synthetic (never real infrastructure configs).
- Watch for NUL bytes: use the `\0` escape in source strings, never a raw 0x00 byte.

## Pull requests

1. One logical change per PR.
2. `node --test tests/node/*.test.mjs` must pass.
3. Describe what the change does and why; link an issue for anything non-obvious.
4. New scripts or flags must be documented in `skills/drawio-skill/SKILL.md`
   (and `references/toolbox.md` if user-facing).

## Reporting bugs

Use the bug-report issue template. The most useful bug report includes the exact
command, the input file (or a minimal reproduction), the full stderr output, and your
Node + draw.io CLI versions.

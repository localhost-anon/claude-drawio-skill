# Changelog

All notable changes to this project are documented in this file.

This project's history begins at **2.0.0** — a fresh Node.js, Claude Code-only rewrite.
Prior history (the Python-based project this was ported from) lives in that upstream
project's own changelog — see the Credits section of README.md for the link.

## [2.0.0] - 2026-07-19

### Changed
- Rewrote the skill in pure Node.js (zero external dependencies, vendored `elkjs` for
  auto-layout) — no Python, no Graphviz required.
- Narrowed scope to Claude Code only — removed multi-agent installers and marketplace
  integrations aimed at other tools.
- Republished as a standalone repo at `github.com/localhost-anon/claude-drawio-skill`.

[2.0.0]: https://github.com/localhost-anon/claude-drawio-skill/releases/tag/v2.0.0

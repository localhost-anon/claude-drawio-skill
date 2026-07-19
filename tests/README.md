# Tests

Zero-dependency regression tests for the bundled scripts (Node's built-in
`node:test` runner only — no npm install). They live at the repo root so they
are **not** shipped with the skill package.

```bash
# from the repo root
node --test tests/node/*.test.mjs
```

Use the explicit glob form (`tests/node/*.test.mjs`), not plain
`node --test tests/node/` — directory-mode discovery is flaky on some Node
versions.

## Coverage

| Area | What's locked in |
|---|---|
| `scripts.test.mjs` | every bundled `.mjs` in `skills/drawio-skill/scripts/` responds to `--help` with exit 0 and non-empty usage |
| `skill_metadata.test.mjs` | `SKILL.md` frontmatter has a non-empty name/description, a semver `version`, and `license: MIT` |
| `shapesearch` (via `lib.test.mjs` / related) | Soundex codes, index loads, known queries resolve, **title-exact ranking** (`dynamodb` → *DynamoDB*), empty on no match |
| `aiicons` | variant families, brand/token matching, `-color` preference with mono fallback (OpenAI) |
| `encode_drawio_url` | **CJK + `%` round-trip** (the encodeURIComponent-before-deflate fix), viewer vs editor URLs |
| `autolayout` | palette sourced from `default.json` (not the fallback), group tinting, explicit-style wins, `--mono` |
| `validate` | good `.drawio` passes (exit 0), dangling edge fails (exit 1) |
| importers | `pyimports`/`jsimports`/`goimports`/`k8simports`/`dockerimports`/etc. intra-project edges, `pyclasses` inheritance edge + no hard-coded colour |
| `buildup`, `c4`, `runbook`, `prdiff`, `compress`, `drawiodiff`, `seqlayout`, `timelapse`, `tubemap` | one `tests/node/<name>.test.mjs` each |

Fixtures used by these tests live in `tests/fixtures/`. Auto-layout is
exercised through `to_drawio()`-equivalent helpers with synthetic positions,
so the suite needs **no Graphviz or draw.io** to run.

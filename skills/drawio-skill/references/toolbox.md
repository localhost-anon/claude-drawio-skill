# Toolbox — every bundled script, by use-case

A map of the 31 bundled scripts grouped by what you're trying to do. The
per-task routing table in `SKILL.md` says *when* to reach for each; this says
*how they fit together*. Read it when you're not sure which script a request
maps to, or you want to chain several.

The recurring backbone is one pipeline — an **extractor** emits graph JSON, then
`autolayout.mjs` places it, then `validate.mjs` lints it, then the draw.io CLI
exports it:

```
<extractor> → graph.json → autolayout.mjs → diagram.drawio → validate.mjs → (export PNG/SVG/PDF)
```

## Quick decision guide

| I have… | I want… | Use |
|---|---|---|
| a description in words | a styled diagram | hand-write XML (`references/xml-authoring.md`) or `autolayout.mjs` |
| a big/complex graph | it laid out for me | `autolayout.mjs` (`--tune` picks direction) |
| a Python/JS/Go/Rust project | its module/class structure | `pyimports` · `jsimports` · `goimports` · `rustimports` · `pyclasses` |
| Terraform/K8s/compose files | the **declared** architecture | `tfimports` · `k8simports` · `composeimports` |
| a running cluster/stack/cloud | what's **actually deployed** | `tfstate` · `dockerimports` · `k8simports -` |
| a SQL schema | an ER diagram | `sqlerd` |
| an OpenAPI / Swagger spec | an API diagram (by method) | `openapiimports` |
| CI workflows (GH Actions / GitLab) | the pipeline as a DAG | `ciimports` |
| a diagram + a metrics file | it coloured by the data | `heatmap` |
| a sequence of interactions | a UML sequence diagram | `seqlayout` |
| a system at 3 zoom levels | a C4 model with drill-down | `c4` |
| two diagrams / two snapshots | what changed (drift) | `drawiodiff` |
| a repo's git history | how its architecture grew | `timelapse` |
| a `.drawio` | a shareable interactive viewer | `drawiohtml` (→ HTML: pan/zoom/search/tabs) |
| a `.drawio` | a written description | `explain` (→ Markdown) |
| a `.drawio` | a slide deck | `drawio2pptx` (→ PPTX) |
| a `.drawio` | an animated data-flow | `svgflow` (→ SVG) |
| a `.drawio` | diagrams-as-code | `drawio2mermaid` (→ Mermaid) |
| a `.drawio` | the same diagram in another language | `relabel` (extract → translate → apply) |
| a `.drawio` | it re-themed (dark / corporate preset) | `restyle` |
| a shape/icon need | the exact style string | `shapesearch` · `aiicons` (AI/LLM logos) |
| a photo/screenshot of a diagram | an editable `.drawio` | `raster2drawio` (your vision → JSON → draw.io) |
| ONE `.drawio` | it building itself, as a video/GIF | `buildup` (→ HTML player; `--gif`) |
| a big/sprawling diagram | a boardroom exec summary + drill-down | `compress` |
| a decision-tree flowchart | a click-through triage app | `runbook` (→ HTML, no CLI) |
| a PR touching `.drawio` | rendered before/after/diff for reviewers | `prdiff` (+ GitHub Action) |
| a pipeline / journey / subsystem map | it drawn as a metro / subway map | `tubemap` (coloured lines, octilinear, interchanges) |

## 1. Author & place

- **`autolayout.mjs`** — graph JSON → placed `.drawio` (built-in ELK layout; orthogonal routing, `--group` containers, `--tune` best direction). The hub every extractor feeds. See `references/autolayout.md`.
- **`seqlayout.mjs`** — participants + messages JSON → sequence diagram with computed lifelines/activation bars.
- **`c4.mjs`** — levels JSON → one multi-page `.drawio` (Context→Container→Component) with click-to-drill-down links.
- **`tubemap.mjs`** — metro JSON (coloured lines + grid-placed stations) → a London-Underground-style **tube map**: octilinear (H/V/45°) routing, white interchange circles, station stops. See `references/tubemap.md`.
- **`shapesearch.mjs`** — search 10k+ official shapes for their exact `style=` string. **`aiicons.mjs`** — draw.io `image` styles for AI/LLM brand logos.
- **`raster2drawio.mjs`** — a vision-extracted image graph JSON (from a whiteboard photo / legacy PNG / Visio screenshot) → editable `.drawio` honouring the read coordinates; missing positions fall back to `autolayout.mjs`. See `references/derasterize.md`.

## 2. Code → diagram

- **`pyimports` · `jsimports` · `goimports` · `rustimports`** — a project's intra-module import graph (transitive-reduced; `--group` boxes by sub-package).
- **`pyclasses.mjs`** — a Python class-inheritance graph.

All emit graph JSON → `autolayout.mjs`.

## 3. Infrastructure → diagram (declared config)

- **`tfimports.mjs`** — Terraform `.tf` → resources as official AWS/Azure/GCP icons.
- **`k8simports.mjs`** — K8s manifests → objects as official kind icons (edges: Ingress→Service→workload→ConfigMap/Secret/PVC).
- **`composeimports.mjs`** — docker-compose → service boxes + volume cylinders.
- **`sqlerd.mjs`** — SQL DDL (`CREATE TABLE`) → ERD with crow's-foot FK edges.
- **`ciimports.mjs`** — GitHub Actions (`.github/workflows/*.yml`) and/or `.gitlab-ci.yml` -> pipeline DAG: job nodes (runner, `matrix xN`, reusable-workflow calls in purple), `needs:` edges, an `on:` trigger node per workflow, jobs boxed per workflow / per GitLab stage.
- **`openapiimports.mjs`** — OpenAPI 3 / Swagger 2 spec → API diagram: one node per operation (coloured by HTTP method) + one per component schema, with edges to the schemas each operation uses and between nested schemas. `--group` by tag.

## 4. Live infrastructure → diagram (actually running)

The **actual** counterpart to §3 — see `references/live-infra.md`.

- **`tfstate.mjs`** — `terraform show -json | tfstate.mjs -` → deployed resources (provider-agnostic; expands `count`/`for_each`).
- **`dockerimports.mjs`** — `docker inspect $(docker ps -q) | dockerimports.mjs -` → running containers + networks + volumes.
- **`k8simports.mjs -`** — `kubectl get all,ing,cm,secret,pvc -o json | k8simports.mjs -` → live cluster.

## 5. Compare & evolve

- **`drawiodiff.mjs`** — diff two `.drawio` (or two live snapshots) → colour-coded graph (added=green, removed=red, changed=orange). Pairs with §4 for drift.
- **`timelapse.mjs`** — re-run an extractor across git history → a self-contained HTML player of how the architecture grew.
- **`heatmap.mjs`** — recolour any `.drawio` by a metrics file (CSV/JSON): each node shaded low→high on a gradient by its value (`--palette`, optional `--size`, auto legend). Turns a static architecture into a cost / latency / traffic / error-rate heat map.
- **`buildup.mjs`** — reveal ONE diagram's cells in dependency order (topological over its edges) → self-contained HTML player (embedded PNG frames, play/pause/step/scrub); optional `--gif`. Needs the draw.io CLI.
- **`compress.mjs`** — big `.drawio` → 2-page executive summary. Label-propagation clustering, one auto-named node per cluster with a drill-down link to the full original on page 2, aggregated cross-cluster edges.
- **`prdiff.mjs`** — for every `.drawio` changed between two git refs, render base/head/`drawiodiff`-diff PNGs + a Markdown report for a PR comment; ships a composite GitHub Action (`.github/actions/drawio-diff/`). See `references/pr-bot.md`.

## 6. Diagram → other formats (reverse / interop)

The skill runs both directions — these turn a `.drawio` back into something else:

- **`drawiohtml.mjs`** — → a self-contained **interactive HTML viewer**: every page inlined as SVG with tabs, drag-pan, wheel-zoom, node search, and working drill-down links (C4 `data:page/id` links switch tabs). Share one file; no draw.io, no server.
- **`explain.mjs`** — → structured **Markdown** (components by tier, relations, per-page C4).
- **`drawio2pptx.mjs`** — → a 16:9 **PowerPoint** deck, one page per slide.
- **`svgflow.mjs`** — → an **animated SVG** (edges flow as marching ants); renders on GitHub.
- **`drawio2mermaid.mjs`** — → **Mermaid** `flowchart` text (diagrams-as-code GitHub renders).
- **`runbook.mjs`** — a flowchart/decision-tree → a self-contained **click-through HTML runbook** (current-step text, per-edge choice buttons, breadcrumb, Back/Restart). Reads the XML directly — no draw.io CLI needed.

## 7. Utilities & quality

- **`relabel.mjs`** — swap every label via a JSON map, layout untouched — `--extract` dumps an identity map of all labels (vertices, edges, UserObjects, page names), translate the values, `--map` applies them. Built for bilingual (EN/CN) variants of one diagram.
- **`restyle.mjs`** — apply a style preset (user or built-in, e.g. `dark`) to an existing `.drawio`: palette remap by hue, font, dark-theme extras, page background. Layout, shapes, and edge routing stay put.
- **`validate.mjs`** — deterministic structural lint (dangling edges, dup/reserved ids, overlaps; `--score` for layout readability). Run before exporting.
- **`repair_png.mjs`** — fix draw.io's truncated IEND chunk after every `-e` PNG export (issue #8).
- **`encode_drawio_url.mjs`** — encode a `.drawio` into a diagrams.net browser URL when the CLI is unavailable (`--edit` for an editable editor URL).

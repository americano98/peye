---
name: peye
description: Use this skill when you need to compare an implemented UI against a Figma frame or another screenshot with the local `peye` CLI. Trigger for requests about pixel-perfect validation, screenshot-vs-design comparison, Figma-to-implementation diffing, live preview URL capture, hash-fragment element capture, or machine-readable visual validation reports.
---

# `peye` Skill

Use `peye` to produce a deterministic visual diff report from a preview and a reference.

## Use This Workflow

1. Identify the preview source.
2. Identify the reference source.
3. Choose an output directory.
4. Run `peye compare`.
5. Read `report.json` first.
6. Use `heatmap.png`, `overlay.png`, and `diff.png` to explain the mismatch cause.

Prefer `report.json` for machine decisions. Prefer `heatmap.png` and `overlay.png` for human triage.
If `report.json` contains `error`, trust `error.code` before any heuristic interpretation of mismatch metrics.

## Inputs

Preview:

- Local screenshot path
- HTTP or HTTPS URL

Reference:

- Local screenshot path
- Figma URL with `node-id`

Viewport:

- Required when preview is a URL
- Accept `WIDTH` or `WIDTHxHEIGHT`
- If only width is passed, use default height `900`
- Optional when preview is a local image

Selector behavior:

- If preview URL contains a hash fragment, for example `https://example.com/#road-map`, treat it as selector `#road-map` unless `--selector` is explicitly passed.
- If `--selector` is passed, it overrides the hash-derived selector.
- Do not combine `--full-page` with selector-based capture.

Figma behavior:

- Prefer Figma MCP when reference is a Figma URL.
- Require `node-id` in the Figma URL.
- If MCP returns a screenshot smaller than the node metadata size, expect `peye` to upscale the reference back to the node dimensions before diffing.
- Fall back to `FIGMA_TOKEN` only when MCP is unavailable or explicitly forced through `PEYE_FIGMA_SOURCE=rest`.
- If a strict original export raster is required, prefer `PEYE_FIGMA_SOURCE=rest` with `FIGMA_TOKEN`.

## Command

Use the built CLI in published or built environments:

```bash
peye compare \
  --preview <url|path> \
  --reference <figma-url|path> \
  --output <dir> \
  [--viewport 1920|1920x900] \
  [--mode all|pixel|layout|color] \
  [--selector <css>] \
  [--full-page] \
  [--quiet] \
  [--report-stdout] \
  [--threshold-pass 0.5] \
  [--threshold-tolerated 1.5] \
  [--threshold-retry 5]
```

When working inside this repository before publish, prefer:

```bash
node dist/bin.js compare ...
```

If the build is stale, run:

```bash
pnpm build
```

## Recommended Invocation Patterns

Compare two local images:

```bash
peye compare \
  --preview ./preview.png \
  --reference ./reference.png \
  --output ./tmp/peye
```

Compare a live page section against Figma:

```bash
peye compare \
  --preview http://localhost:3000/#hero \
  --reference "https://www.figma.com/design/FILE_KEY/Frame?node-id=1-2" \
  --viewport 1920 \
  --output ./tmp/peye
```

Force REST fallback when needed:

```bash
PEYE_FIGMA_SOURCE=rest \
FIGMA_TOKEN=... \
peye compare \
  --preview http://localhost:3000/#hero \
  --reference "https://www.figma.com/design/FILE_KEY/Frame?node-id=1-2" \
  --viewport 1920 \
  --output ./tmp/peye
```

Compare a live page with an explicit selector:

```bash
peye compare \
  --preview http://localhost:3000 \
  --selector "#pricing-card" \
  --reference ./figma/pricing-card.png \
  --viewport 1280 \
  --output ./tmp/peye
```

Emit the full report JSON to stdout for automation:

```bash
peye compare \
  --preview ./preview.png \
  --reference ./reference.png \
  --output ./tmp/peye \
  --report-stdout
```

## Interpret Results

Read `summary.recommendation`:

- `pass`: strict match
- `pass_with_tolerated_differences`: small acceptable drift
- `retry_fix`: localized fixable issues
- `needs_human_review`: strong size mismatch, ambiguous diff, or invalid target

Read `metrics`:

- `mismatchPercent`: overall mismatch percentage
- `meanColorDelta` and `maxColorDelta`: color drift
- `structuralMismatchPercent`: layout or edge mismatch
- `dimensionMismatch`: width, height, and aspect-ratio differences
- `findingsCount`: total actionable findings before capping
- `affectedElementCount`: number of DOM elements implicated in URL mode

Read `images`:

- `preview` and `reference`: normalized dimensions of each input used by the comparison
- `canvas`: padded comparison canvas after normalization
- Use these fields to detect wrong viewport, wrong frame selection, or large size drift before reading screenshots

Read `analysisMode`:

- `dom-elements`: preview came from a URL and mismatches were grouped by DOM element
- `visual-clusters`: preview came from an image and mismatches were grouped by visual cluster

Read `rollups`:

- `rawRegionCount`: total internal mismatch fragments before aggregation
- `bySeverity` and `byKind`: compact breakdown of actionable findings
- `byTag`: top affected HTML tags in DOM mode
- `omittedFindings`: how many lower-priority findings were truncated from the top list

Read `findings`:

- Use `kind` to separate `pixel`, `color`, `layout`, `mixed`, and `dimension` issues
- Use `summary`, `issueTypes`, `signals`, `bbox`, and `hotspots` to drive the next fix
- In URL mode, use `element.tag`, `element.selector`, and `element.textSnippet` to identify the exact target in code
- Treat `signals[].code` as the stable automation key and `signals[].confidence` as the reliability hint for the heuristic

Read `signals`:

- `probable_text_clipping`: text in the captured preview element overflowed its box and the CSS indicates it is being clipped. This is usually a medium-confidence signal and becomes stronger when the element uses explicit clipping such as `overflow: hidden`, `overflow: clip`, `text-overflow: ellipsis`, or line clamping.
- `possible_capture_crop`: the preview capture clipped the element bounds at the selector or screenshot boundary. This is a high-confidence signal for capture framing problems and should usually be investigated before tweaking implementation styles.
- `possible_viewport_mismatch`: a dimension mismatch reaches the comparison canvas edge, suggesting the viewport, selected frame, or target region may be wrong. This is a medium-confidence setup signal, not proof that the rendered UI itself is wrong.

Signal validity guidance:

- Prefer `possible_capture_crop` over lower-level mismatch interpretation when it is present.
- Treat `probable_text_clipping` as evidence about the preview capture only. It does not prove that the reference intended a longer visible string, but it is a strong hint when the affected element also has text and styling mismatch.
- Treat `possible_viewport_mismatch` as a rerun/setup-check signal. Verify viewport, frame selection, and selector scope before making code edits based on it.

Read `error`:

- `null` on successful compare runs
- On failure reports, use `error.code` as the stable automation key and `error.message` as the human-readable explanation
- Treat exit code `1` plus `error.code` as an input or environment problem to fix before rerunning

Read `artifacts`:

- `heatmap.png`: best first image for triage
- `overlay.png`: best image for alignment issues
- `diff.png`: best image for raw pixel mismatch inspection

## Exit Codes

- `0`: pass or tolerated pass
- `2`: retry fix
- `3`: needs human review
- `1`: operational error

## Practical Guidance

- Keep output directories per run to avoid mixing artifacts.
- Fix selector or viewport issues before trusting visual mismatch metrics.
- Prefer `--mode all` unless the user wants a narrower diagnostic pass.
- If the task is to automate a validate-and-fix loop, use `report.json` as the contract and the images as supporting evidence.
- Use `--report-stdout` when another tool needs the report directly from stdout.
- Use `--quiet` when the caller only cares about exit code plus on-disk artifacts.
- Suggested loop: exit code `0` accept, exit code `2` fix top finding and rerun, exit code `3` stop for human review, exit code `1` inspect `error.code` and repair inputs or environment before retrying.

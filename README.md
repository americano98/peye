# peye

`peye` is a standalone CLI for visual diffing an implemented UI against a Figma reference or another screenshot. It is designed for agent-driven workflows and local terminal use: feed it a preview URL or image, feed it a reference URL or image, and it will produce deterministic artifacts plus a machine-readable JSON report.

The comparison core is intentionally separated from screenshot acquisition so the tool stays scriptable, predictable, and easy to embed into automation pipelines.

## What It Does

- Compare `preview` from a local screenshot or live URL
- Compare `reference` from a local screenshot or Figma URL
- Capture only a target element when the preview URL contains `#fragment`
- Ignore selector-matched preview noise such as fixed, sticky, or third-party overlays during diffing
- Generate a compact LLM-friendly `report.json`, `overlay.png`, `diff.png`, `heatmap.png`, plus normalized input images
- Group mismatches by DOM element for URL previews and by visual cluster for local image previews
- Expose structured failure metadata, normalized image dimensions, and per-finding hotspots for agent triage
- Return a recommendation:
  - `pass`
  - `pass_with_tolerated_differences`
  - `retry_fix`
  - `needs_human_review`

## Requirements

- Node.js `>= 22`
- A Chromium browser available to Playwright for URL capture
- One of these when `--reference` is a Figma URL:
  - Figma desktop MCP running locally
  - remote Figma MCP authorization in an interactive terminal
  - `FIGMA_TOKEN` as a fallback for CI or REST-only workflows

When Figma MCP returns a screenshot that is smaller than the selected node's metadata size, `peye` automatically upscales the reference image back to the node dimensions before diffing. If you need a strict export raster from Figma, force REST with `PEYE_FIGMA_SOURCE=rest`.

If you plan to capture a live preview URL, install the bundled Playwright Chromium once with:

```bash
peye install chromium
```

## Install

From the repository:

```bash
pnpm install
pnpm build
node dist/bin.js --help
node dist/bin.js --version
```

After publishing, install the CLI globally with:

```bash
npm install -g @americano98/peye
peye install chromium
peye --help
```

`peye install chromium` is only needed for live URL capture. Pure image-to-image comparison works without a browser download.

`npm install` only installs the CLI. Agent integration files are kept in [`agents/`](./agents) and are not part of the published npm package.

## Agent Integration

If your agent runtime supports reusable skill or instruction files, copy or vendor [`agents/SKILL.md`](./agents/SKILL.md) into that runtime's skill registry.

Recommended practice:

- Install `peye` separately so the `peye` executable is available in `PATH`.
- Treat [`agents/SKILL.md`](./agents/SKILL.md) as an optional integration asset, not part of the CLI install step.
- Keep the skill file versioned alongside the CLI, so updates to command flags and report shape stay in sync.
- Adapt the file to your agent runtime if it expects a different frontmatter format or install location.

[`agents/openai.yaml`](./agents/openai.yaml) is included as a small example of agent-facing metadata and prompt wiring.

## CLI

```bash
peye compare \
  --preview <url|path> \
  --reference <figma-url|path> \
  --output <dir> \
  [--viewport 1920|1920x900] \
  [--mode all|pixel|layout|color] \
  [--selector <css>] \
  [--ignore-selector <css>] \
  [--full-page] \
  [--quiet] \
  [--report-stdout] \
  [--threshold-pass 0.5] \
  [--threshold-tolerated 1.5] \
  [--threshold-retry 5]
```

### Important Rules

- `--viewport` is required when `--preview` is a URL.
- `--viewport 1920` is valid and means `width=1920`, `height=900` by default.
- Use explicit `WIDTHxHEIGHT` only when exact viewport height matters for the comparison.
- If `--preview` is a local image and `--viewport` is omitted, viewport is inferred from the image dimensions.
- If `--preview` contains a hash, for example `https://example.com/#road-map`, `peye` automatically treats it as selector `#road-map` unless `--selector` is passed explicitly.
- `--full-page` is allowed only for URL preview capture without a selector.
- `--ignore-selector` is allowed only when `--preview` is a URL.
- Repeat `--ignore-selector` to ignore multiple selectors.
- Ignore selectors are normalized by trimming whitespace and dropping exact duplicates while preserving order.
- If `--reference` is a Figma URL, it must include `node-id`.
- `--quiet` suppresses the human-readable terminal summary.
- `--report-stdout` writes the compact JSON report to stdout and suppresses the human-readable summary.

## Examples

Compare two local screenshots:

```bash
peye compare \
  --preview ./artifacts/preview.png \
  --reference ./artifacts/reference.png \
  --output ./peye-output
```

Capture a live preview page at a fixed viewport:

```bash
peye compare \
  --preview http://localhost:3000 \
  --reference ./figma-export/home.png \
  --viewport 1920 \
  --output ./peye-output
```

Capture only a single element via URL hash:

```bash
peye compare \
  --preview https://example.com/#road-map \
  --reference ./figma-export/road-map.png \
  --viewport 1920 \
  --output ./peye-output
```

Compare against a Figma node:

```bash
peye compare \
  --preview http://localhost:3000/#hero \
  --reference "https://www.figma.com/design/FILE_KEY/Mockup?node-id=1-2" \
  --viewport 1920 \
  --output ./peye-output
```

By default this prefers Figma MCP. If MCP returns a downscaled screenshot, `peye` upsizes it to the node's Figma metadata dimensions before comparison so the reference stays aligned with the selected frame size.

Ignore a fixed preview banner during comparison:

```bash
peye compare \
  --preview http://localhost:3000/#hero \
  --reference ./figma-export/hero.png \
  --viewport 1920 \
  --ignore-selector "#cookie-banner" \
  --ignore-selector ".intercom-launcher" \
  --output ./peye-output
```

Force REST fallback explicitly, for example in CI:

```bash
PEYE_FIGMA_SOURCE=rest \
FIGMA_TOKEN=your_token_here \
peye compare \
  --preview http://localhost:3000/#hero \
  --reference "https://www.figma.com/design/FILE_KEY/Mockup?node-id=1-2" \
  --viewport 1920 \
  --output ./peye-output
```

Write the machine-readable report to stdout for automation:

```bash
peye compare \
  --preview ./artifacts/preview.png \
  --reference ./artifacts/reference.png \
  --output ./peye-output \
  --report-stdout
```

Keep the CLI silent while still writing artifacts to disk:

```bash
peye compare \
  --preview ./artifacts/preview.png \
  --reference ./artifacts/reference.png \
  --output ./peye-output \
  --quiet
```

## Output

`peye` writes these files into `--output`:

- `preview.png`: normalized preview image used for analysis
- `reference.png`: normalized reference image used for analysis
- `overlay.png`: blended reference + preview image
- `diff.png`: raw pixel diff image
- `heatmap.png`: mismatch heatmap with highlighted findings
- `report.json`: compact machine-readable result optimized for agent workflows

`report.json` is versioned and compact by default:

- `analysisMode` is `dom-elements` for URL captures and `visual-clusters` for local image inputs
- `images` preserves normalized preview, reference, and padded canvas dimensions for fast debugging
- `inputs.preview.ignoreSelectors` records requested ignore selectors and how many visible elements actually intersected the capture area
- `findings` is capped to the top actionable mismatches
- `findings[].signals` adds stable heuristic hints such as probable text clipping, capture crop, and viewport mismatch
- `findings[].hotspots` exposes the top mismatch subregions without forcing the caller to inspect images first
- `rollups.rawRegionCount` preserves the internal mismatch count without emitting every low-level region
- `error` is `null` on successful comparisons and contains a stable `code`, `message`, and `exitCode` for failure reports

## Automation

For agent workflows, prefer one of these modes:

- Default mode: writes `report.json` to `--output` and prints a short human summary to stdout
- `--quiet`: writes files to `--output` and keeps stdout empty on success
- `--report-stdout`: writes files to `--output` and also emits the full report JSON as a single stdout payload

`--report-stdout` is the most stable mode when another tool is parsing the command result directly.

Suggested orchestration policy:

- exit code `0`: accept or continue to the next step
- exit code `2`: fix the top finding and rerun
- exit code `3`: stop the auto-fix loop and inspect the report plus artifacts
- exit code `1`: treat as an operational or input error, read `error.code`, fix inputs or environment, and retry

Example `report.json` shape:

```json
{
  "analysisMode": "dom-elements",
  "summary": {
    "recommendation": "retry_fix",
    "severity": "medium",
    "reason": "Mismatch is 3.21%; localized issues were detected and should be fixed before retrying."
  },
  "inputs": {
    "preview": {
      "input": "http://localhost:3000/#hero",
      "kind": "url",
      "resolved": "http://localhost:3000/#hero",
      "selector": "#hero",
      "ignoreSelectors": [
        { "selector": "#cookie-banner", "matchedElementCount": 1 },
        { "selector": ".intercom-launcher", "matchedElementCount": 0 }
      ]
    },
    "reference": {
      "input": "https://www.figma.com/design/FILE_KEY/Mockup?node-id=1-2",
      "kind": "figma-url",
      "resolved": "https://www.figma.com/design/FILE_KEY/Mockup?node-id=1-2",
      "selector": null,
      "transport": "figma-mcp-desktop"
    },
    "viewport": {
      "width": 1920,
      "height": 900
    },
    "mode": "all",
    "fullPage": false
  },
  "images": {
    "preview": { "width": 1920, "height": 900 },
    "reference": { "width": 1920, "height": 900 },
    "canvas": { "width": 1920, "height": 900 }
  },
  "metrics": {
    "mismatchPixels": 1234,
    "mismatchPercent": 3.21,
    "ignoredPixels": 6720,
    "ignoredPercent": 0.39,
    "meanColorDelta": 7.42,
    "maxColorDelta": 24.5,
    "structuralMismatchPercent": 8.13,
    "findingsCount": 2,
    "affectedElementCount": 2,
    "dimensionMismatch": {
      "widthDelta": 0,
      "heightDelta": 0,
      "aspectRatioDelta": 0,
      "hasMismatch": false
    }
  },
  "rollups": {
    "bySeverity": [{ "severity": "medium", "count": 2 }],
    "byKind": [
      { "kind": "mixed", "count": 1 },
      { "kind": "color", "count": 1 }
    ],
    "byTag": [
      { "tag": "button", "count": 1 },
      { "tag": "h1", "count": 1 }
    ],
    "rawRegionCount": 18,
    "findingsCount": 2,
    "affectedElementCount": 2,
    "omittedFindings": 0
  },
  "findings": [
    {
      "id": "finding-001",
      "source": "dom-element",
      "severity": "medium",
      "kind": "mixed",
      "summary": "Element <button> differs in both layout and styling.",
      "bbox": {
        "x": 20,
        "y": 80,
        "width": 120,
        "height": 36
      },
      "regionCount": 11,
      "mismatchPixels": 519,
      "mismatchPercentOfCanvas": 1.54,
      "issueTypes": ["position", "spacing", "style"],
      "signals": [
        {
          "code": "probable_text_clipping",
          "confidence": "medium",
          "message": "Text content likely overflows the element bounds and is being clipped on the horizontal axis."
        }
      ],
      "hotspots": [{ "x": 20, "y": 80, "width": 52, "height": 36 }],
      "element": {
        "tag": "button",
        "selector": "section#hero > button#cta",
        "role": null,
        "textSnippet": "Buy",
        "bbox": {
          "x": 20,
          "y": 80,
          "width": 120,
          "height": 36
        }
      }
    }
  ],
  "artifacts": {
    "reference": "/abs/path/reference.png",
    "preview": "/abs/path/preview.png",
    "overlay": "/abs/path/overlay.png",
    "diff": "/abs/path/diff.png",
    "heatmap": "/abs/path/heatmap.png",
    "report": "/abs/path/report.json"
  },
  "error": null
}
```

Failure reports keep the same top-level shape and set `error` to a structured object, for example:

```json
{
  "summary": {
    "recommendation": "needs_human_review",
    "severity": "medium",
    "reason": "Preview URL requires --viewport so the browser screenshot is deterministic."
  },
  "error": {
    "code": "preview_viewport_required",
    "message": "Preview URL requires --viewport so the browser screenshot is deterministic.",
    "exitCode": 1
  }
}
```

## Exit Codes

- `0`: `pass` or `pass_with_tolerated_differences`
- `2`: `retry_fix`
- `3`: `needs_human_review`
- `1`: operational error

## Troubleshooting

- `Preview URL requires --viewport`: pass `--viewport 1920` or `--viewport 1920x900` when `--preview` is a URL.
- `--ignore-selector can only be used when --preview is a URL`: ignore selectors are resolved from live DOM elements, so local preview images are not supported.
- `inputs.preview.ignoreSelectors[].matchedElementCount` is `0`: the selector matched no visible elements inside the captured area, so it had no effect on diffing.
- `preview_browser_missing`: install the bundled browser with `peye install chromium`.
- Figma URL falls back to REST unexpectedly: check `inputs.reference.transport` in `report.json` and ensure `PEYE_FIGMA_SOURCE` is not forcing `rest`.
- Remote Figma MCP requires authorization: run `peye compare` in an interactive terminal so it can complete the OAuth callback flow.
- `FIGMA_TOKEN is required`: either export `FIGMA_TOKEN`, or make sure a Figma MCP source is reachable for Figma URLs.
- Figma MCP reference still looks softer than a manual export: MCP screenshots may be downscaled by Figma first; `peye` upscales them back to the node size for comparison, but if you need the original export raster use `PEYE_FIGMA_SOURCE=rest` with `FIGMA_TOKEN`.
- Selector capture fails: verify the selector exists at capture time and do not combine selector capture with `--full-page`.
- Large dimension mismatch triggers `needs_human_review`: check that preview and reference target the same frame, selector, and viewport.

## Limitations

- No config file support yet; inputs are provided through CLI flags only.
- No arbitrary pixel mask file support yet; selector-based ignore masks only work for URL previews.
- `--ignore-selector` ignores the matched element bounding boxes, not a pixel-perfect DOM silhouette.
- No automatic geometric alignment step yet; mismatches are evaluated on the captured canvas as-is.
- Browser capture currently uses Playwright Chromium.
- DOM-based findings are heuristic and depend on the element boxes collected during capture.
- Exit code `1` can still happen before the CLI is able to produce comparison artifacts; use `error.code` when `report.json` is present and stderr otherwise.

## Uninstall

If `peye` was installed globally, remove it with your package manager:

```bash
npm uninstall -g @americano98/peye
```

```bash
pnpm remove -g @americano98/peye
```

If it was installed in a project, use:

```bash
npm uninstall @americano98/peye
```

or:

```bash
pnpm remove @americano98/peye
```

## Development

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run the full quality gate with:

```bash
pnpm check
```

Clean generated local artifacts with:

```bash
pnpm clean
```

For local development without building every time:

```bash
pnpm dev compare --preview ./preview.png --reference ./reference.png --output ./tmp/peye
```

# CLI Guide

## Commands

### `peye install [browser]`

Installs the Playwright browser binary required for preview URL capture.

Supported values:

- `chromium` (default and currently the only supported browser)

Example:

```bash
peye install chromium
```

### `peye compare`

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

## Options

| Option                             | Required         | Description                                                            |
| ---------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `--preview <url\|path>`            | yes              | Preview URL or local screenshot path                                   |
| `--reference <figma-url\|path>`    | yes              | Figma URL or local reference screenshot path                           |
| `--output <dir>`                   | yes              | Output directory for report and generated artifacts                    |
| `--viewport <width\|widthxheight>` | URL preview only | Capture viewport, for example `1920` or `1920x900`                     |
| `--mode <mode>`                    | no               | Analysis mode: `all`, `pixel`, `layout`, `color`                       |
| `--selector <css>`                 | no               | CSS selector for preview element capture                               |
| `--ignore-selector <css>`          | no               | Ignore visible preview elements matched by CSS selector during diffing |
| `--full-page`                      | no               | Capture the full preview page when preview is a URL                    |
| `--quiet`                          | no               | Suppress the human-readable terminal summary                           |
| `--report-stdout`                  | no               | Emit the compact report JSON to stdout instead of the human summary    |
| `--threshold-pass <number>`        | no               | Pass threshold in percent, default `0.5`                               |
| `--threshold-tolerated <number>`   | no               | Tolerated threshold in percent, default `1.5`                          |
| `--threshold-retry <number>`       | no               | Retry threshold in percent, default `5`                                |

## Important Rules

- `--viewport` is required when `--preview` is a URL.
- `--viewport 1920` means `width=1920` and `height=900` by default.
- Use `WIDTHxHEIGHT` only when exact viewport height matters.
- If `--preview` is a local image and `--viewport` is omitted, the viewport is inferred from the image dimensions.
- If the preview URL contains a hash, for example `https://example.com/#road-map`, `peye` treats it as the selector unless `--selector` is passed explicitly.
- `--full-page` is allowed only for URL capture without a selector.
- `--ignore-selector` is allowed only when `--preview` is a URL.
- Repeat `--ignore-selector` to ignore multiple selectors.
- Ignore selectors are normalized by trimming whitespace and dropping exact duplicates while preserving order.
- If `--reference` is a Figma URL, it must include `node-id`.

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

## Output Modes

For automation, prefer one of these modes:

- default: write files to `--output` and print a short human summary to stdout
- `--quiet`: write files to `--output` and keep stdout empty on success
- `--report-stdout`: write files to `--output` and emit the full report JSON as a single stdout payload

`--report-stdout` is the most stable mode when another tool parses the command result directly.

## Exit Codes

- `0`: pass or tolerated pass
- `2`: retry fix
- `3`: needs human review
- `1`: operational or input error

## Troubleshooting

- `Preview URL requires --viewport`: pass `--viewport 1920` or `--viewport 1920x900` when `--preview` is a URL.
- `--ignore-selector` only works for URL previews because it is resolved from live DOM elements.
- `preview_browser_missing`: run `peye install chromium`.
- Selector capture failures usually mean the selector does not exist at capture time or was combined with `--full-page`.
- Large dimension mismatches usually mean the preview and reference do not target the same frame, selector, or viewport.

## Current Limitations

- No config file support yet; inputs are provided through CLI flags only.
- No arbitrary pixel mask file support yet; ignore masks are selector-based and work only for URL previews.
- `--ignore-selector` ignores matched element bounding boxes, not pixel-perfect DOM silhouettes.
- No automatic geometric alignment step yet; mismatches are evaluated on the captured canvas as-is.
- Browser capture currently uses Playwright Chromium.
- DOM-based findings are heuristic and depend on the element boxes collected during capture.

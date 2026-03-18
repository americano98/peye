---
name: peye
description: Use this skill when you need to validate an implemented UI against a Figma frame or another screenshot with the local `peye` CLI. Trigger for visual validation, screenshot-vs-design comparison, Figma-to-implementation diffing, live preview URL capture, or agentic fix loops where the agent should compare, inspect the report, improve the implementation, and rerun.
---

# `peye` Skill

Use `peye` to compare a preview against a reference and decide what to do next.

This tool is for validation, not generation. The main contract is `report.json`.

## When To Use It

Use `peye` when an agent needs to:

- compare an implemented UI against Figma or another screenshot
- capture a live preview URL at a fixed viewport
- validate a single page section via URL hash or `--selector`
- run a compare -> inspect -> fix -> rerun loop

## Agent Stance

- Treat `report.json` as the primary result.
- Trust `summary.decisionTrace`, `summary.topActions`, `summary.agentChecks`, `summary.primaryBlockers`, `summary.safeToAutofix`, `summary.requiresRecapture`, `summary.requiresSanityCheck`, `error.code`, `findings`, and `rollups` more than your visual guess from the PNGs.
- Use `heatmap.png`, `overlay.png`, and `diff.png` as supporting evidence, not the main contract.
- If `recommendation` is `retry_fix` and the agent is actively implementing that UI, the default action is to try to improve the implementation and rerun.
- If `recommendation` is `needs_human_review`, do not keep auto-tuning blindly. First verify setup: viewport, selector, reference target, and capture scope.
- Remember that `findings` is intentionally capped to the top detailed mismatches. Use `summary.primaryBlockers` and omitted-tail rollups to understand the full problem before deciding that the issue is localized.

## Minimal Workflow

1. Choose the preview:
   - local screenshot path, or
   - `http://` / `https://` URL
2. Choose the reference:
   - local screenshot path, or
   - Figma URL with `node-id`
3. Pick one scratch output directory under `./tmp/peye/` for the current target.
4. Before each rerun, remove that scratch directory and recreate it so only the latest `peye` iteration remains.
5. Run `peye compare`.
6. Read `report.json` first.
7. If needed, inspect `heatmap.png` and `overlay.png`.

## Cleanup Rule

Do not keep every historical `peye` run.

- Always write `peye` artifacts under `./tmp/peye/<target>`.
- Reuse one scratch output directory per target, for example `./tmp/peye/hero`.
- Before rerunning, delete the old directory you created, then run again into the same path.
- Leave only the latest iteration artifacts unless the user explicitly asks to keep history.

Example pattern:

```bash
rm -rf ./tmp/peye/hero
peye compare ... --output ./tmp/peye/hero
```

Only delete scratch output directories created for `peye`. Do not delete user-owned assets or reference files.

## Command

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
  [--report-stdout]
```

Inside this repository, use:

```bash
node dist/bin.js compare ...
```

If needed:

```bash
pnpm build
```

## Important Rules

- `--viewport` is required when `--preview` is a URL.
- If preview URL has a hash fragment, `peye` treats it as the target selector unless `--selector` is passed explicitly.
- Do not combine `--full-page` with selector-based capture.
- `--ignore-selector` is for live-page noise such as fixed, sticky, cookie, chat, or third-party overlays.
- Repeat `--ignore-selector` for multiple selectors.
- `--ignore-selector` works only for URL previews.
- `--ignore-selector` ignores matched element bounding boxes, not pixel-perfect silhouettes.
- If Figma is the reference, prefer the exact frame/section the implementation is supposed to match.

## Recommended Patterns

Compare a live section against Figma:

```bash
rm -rf ./tmp/peye/hero
peye compare \
  --preview http://localhost:3000/#hero \
  --reference "https://www.figma.com/design/FILE_KEY/Frame?node-id=1-2" \
  --viewport 1920 \
  --output ./tmp/peye/hero
```

Ignore noisy overlays:

```bash
rm -rf ./tmp/peye/hero
peye compare \
  --preview http://localhost:3000/#hero \
  --reference ./figma/hero.png \
  --viewport 1920 \
  --ignore-selector "#cookie-banner" \
  --ignore-selector ".intercom-launcher" \
  --output ./tmp/peye/hero
```

Emit JSON to stdout for automation:

```bash
rm -rf ./tmp/peye/run
peye compare \
  --preview ./preview.png \
  --reference ./reference.png \
  --output ./tmp/peye/run \
  --report-stdout
```

## How To Read The Result

Read these first:

- `summary.recommendation`
- `summary.decisionTrace`
- `summary.topActions`
- `summary.agentChecks`
- `summary.primaryBlockers`
- `summary.safeToAutofix`
- `summary.requiresRecapture`
- `summary.requiresSanityCheck`
- `error`
- `findings`

Interpret `summary.recommendation` like this:

- `pass`: good enough, usually stop
- `pass_with_tolerated_differences`: small drift, usually stop unless the user wants a tighter match
- `retry_fix`: fix the top issue and rerun
- `needs_human_review`: likely setup problem, ambiguous comparison, or too-large mismatch

Use these fields for diagnosis:

- `metrics.mismatchPercent`: overall mismatch level
- `metrics.ignoredPixels` and `metrics.ignoredPercent`: excluded area from `--ignore-selector`
- `metrics.structuralMismatchPercent`: layout-sensitive drift
- `summary.decisionTrace[]`: fixed-order explanation of which matrix rules fired and why
- `summary.primaryBlockers[]`: report-level diagnostic grouping across both visible findings and omitted tail
- `summary.primaryBlockers[0].rootCauseGroupId`: the best compact statement of the main blocker
- `summary.agentChecks[]`: structured agent-only validation steps that should run before code changes or escalation
- `findings[]`: top detailed actionable mismatches
- `findings[].id`: stable across reruns for the same normalized issue, so agents can correlate iterations
- `findings[].code`: stable mismatch taxonomy
- `findings[].rootCauseGroupId`: diagnostic grouping for that specific finding
- `findings[].fixHint`: short next-step hint
- `findings[].bbox`: mismatch region bounds for geometry-aware reasoning
- `findings[].element`: the compact actionable anchor
- `findings[].element.selector`: the main DOM target in URL mode
- `findings[].context.binding`: assignment method, confidence, and non-default fallback mode
- `findings[].context.semantic.computedStyle`: preview-side computed styles that are useful for implementation fixes
- `findings[].context.semantic.textLayout`: text wrapping, overflow, ellipsis, and line-clamp hints when text is relevant
- `findings[].context.semantic.captureClippedEdges`: selector-capture clipping hint when framing is suspect
- `findings[].signals[].code`: stable automation hint
- `rollups.omittedFindings`: how many detailed findings were not emitted
- `rollups.omittedBySeverity` and `rollups.omittedByKind`: whether the hidden tail is mostly low-noise or still meaningful
- `rollups.topOmittedSelectors`: repeated DOM targets hidden by truncation
- `rollups.largestOmittedRegions`: the biggest omitted regions with `bbox`, `kind`, `severity`, `rootCauseGroupId`, and optional selector
- `rollups.tailAreaPercent`: how much canvas mismatch is hidden in the omitted tail

If `inputs.preview.ignoreSelectors[].matchedElementCount` is `0`, that ignore rule did nothing in the current capture.

If `error` is non-null, treat `error.code` as the stable automation key.

## Fix Loop Guidance

When using `peye` during implementation:

1. Run compare.
2. Read `report.json`.
3. If setup is wrong, fix setup first:
   - wrong viewport
   - wrong Figma node
   - wrong selector
   - wrong area captured
   - missing ignore selector for obvious page noise
4. If `summary.requiresSanityCheck` is `true`, run `summary.agentChecks[0]` first. This is the path for ambiguous framing/reference-match cases that should be validated by the agent before escalating to a human.
5. If `summary.requiresRecapture` is `true`, fix setup or recapture before changing implementation code.
6. If setup is sound, read `summary.decisionTrace[0]` to understand why the matrix chose the current verdict.
7. Read `summary.primaryBlockers[0]` before changing code. Use it to decide whether the run is dominated by text wrapping, viewport/crop risk, container sizing, layout displacement, or style drift.
8. Use `findings[].context.binding.assignmentConfidence` and `fallbackMarker` to decide how aggressively to trust a DOM target. Proxy bindings should push you to verify structure before patching code.
9. Use `findings[].context.semantic.computedStyle` to inspect likely style drift without opening devtools first.
10. Use `findings[].context.semantic.textLayout` when the issue looks text-related. Overflow, wrapping, ellipsis, or line-clamp mismatches usually map directly to CSS or container-width fixes.
11. If `findings[].context.semantic.captureClippedEdges` is present, suspect selector framing or capture scope before changing implementation code.
12. If setup is sound and the top finding exposes `element.selector`, use that as the default next fix target.
13. If `findings` looks small but `rollups.omittedFindings > 0` or `rollups.tailAreaPercent` is still substantial, treat the issue as broader than the visible top-N details.
14. Rerun `peye` into the same cleaned scratch directory.
15. Stop when the result is `pass`, `pass_with_tolerated_differences`, or escalates to `needs_human_review`.

Do not keep editing forever on a `needs_human_review` result unless the cause is clearly understood.

## Exit Codes

- `0`: pass or tolerated pass
- `2`: retry fix
- `3`: needs human review
- `1`: operational or input error

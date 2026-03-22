# Report Format

`report.json` is the main machine-readable contract of `peye`. Images are supporting artifacts; the report is the object automation should read first.

## Generated Artifacts

`peye` writes these files into `--output`:

- `preview.png`: normalized preview image used for analysis
- `reference.png`: normalized reference image used for analysis
- `overlay.png`: blended reference plus preview image
- `diff.png`: raw pixel diff image
- `heatmap.png`: mismatch heatmap with highlighted findings
- `report.json`: compact machine-readable result optimized for agent workflows
- `summary.md`: compact human-readable summary organized by finding

## High-Signal Fields

Read these first:

- `summary.recommendation`
- `summary.decisionTrace`
- `summary.topActions`
- `summary.primaryBlockers`
- `summary.safeToAutofix`
- `summary.requiresRecapture`
- `summary.correspondenceCoverage`
- `error`
- `findings`

## Recommendation Semantics

- `pass`: good enough, usually stop
- `pass_with_tolerated_differences`: small drift, usually stop unless a tighter match is required
- `retry_fix`: fix the top issue and rerun
- `needs_human_review`: likely setup problem, ambiguous comparison, or mismatch too large for blind auto-fixing

## Top-Level Structure

- `analysisMode`: `dom-elements` for URL captures and `visual-clusters` for local image inputs
- `summary`: recommendation, severity, reasoning, decision trace, blockers, and automation hints
- `inputs`: normalized preview and reference inputs, viewport, mode, and full-page setting
- `images`: normalized preview, reference, and canvas dimensions
- `metrics`: mismatch counts and percentages
- `rollups`: aggregate views of visible and omitted findings
- `findings`: top actionable mismatches
- `artifacts`: file paths for the generated images and report
- `error`: stable failure payload for operational and input errors

## Field Notes

### `summary`

- `decisionTrace` explains which matrix rules fired, in fixed axis order
- `topActions` turns the run into a next-step object instead of just a diff summary
- `primaryBlockers` groups the dominant causes across visible findings and omitted tail findings
- `safeToAutofix` helps automation decide whether another fix attempt is reasonable
- `requiresRecapture` tells the caller to fix setup before changing implementation code
- `correspondenceCoverage` and `correspondenceConfidence` summarize how many DOM groups were reliably localized on the reference side

### `metrics`

- `mismatchPercent` is the primary overall mismatch signal
- `ignoredPixels` and `ignoredPercent` reflect excluded areas from `--ignore-selector`
- `structuralMismatchPercent` highlights layout-sensitive drift
- `dimensionMismatch` reports width, height, and aspect-ratio differences

### `findings`

- `id` is stable across reruns for the same normalized issue
- `code` is the stable mismatch taxonomy
- `rootCauseGroupId` groups related symptoms into a diagnostic blocker
- `fixHint` provides the shortest actionable next step
- `element` is the compact actionable anchor
- `context.semantic.computedStyle` keeps the most useful preview-side style data for implementation fixes
- `context.binding` keeps only assignment method, confidence, and non-default fallback markers
- `context.semantic.textLayout` is preserved only for text-related findings
- `context.semantic.captureClippedEdges` is preserved only when selector capture framing looks clipped
- `signals` adds stable heuristics such as text clipping, capture crop, or viewport mismatch
- `matchedReferenceBBox`, `delta`, and `geometry` are available when a DOM finding was reliably localized against the reference
- `geometry` turns the raw `delta` into normalized position and size drift that is easier for automation to rank
- `siblingRelation` describes spacing and alignment drift against the nearest reliably localized sibling under the same parent group

### `rollups`

- `rawRegionCount` preserves the internal mismatch count without emitting every low-level region
- `omittedFindings` shows how many detailed findings were truncated
- `omittedBySeverity`, `omittedByKind`, and `topOmittedSelectors` tell you what is hidden in the tail
- `largestOmittedRegions` gives a compact sample of the omitted area
- `tailAreaPercent` estimates how much canvas mismatch is not represented in detailed findings

## Minimal Example

```json
{
  "analysisMode": "dom-elements",
  "summary": {
    "recommendation": "retry_fix",
    "severity": "medium",
    "reason": "Mismatch is 3.21%; localized issues were detected and should be fixed before retrying.",
    "safeToAutofix": true,
    "requiresRecapture": false
  },
  "metrics": {
    "mismatchPixels": 1234,
    "mismatchPercent": 3.21,
    "ignoredPixels": 6720,
    "ignoredPercent": 0.39,
    "structuralMismatchPercent": 8.13,
    "findingsCount": 2,
    "affectedElementCount": 2
  },
  "findings": [
    {
      "id": "finding-2e0f1e7f5f9d",
      "code": "text_clipping",
      "severity": "medium",
      "fixHint": "Fix text overflow, line clamp, or available width.",
      "rootCauseGroupId": "text-wrap-regression",
      "element": {
        "tag": "button",
        "selector": "section#hero > button#cta",
        "testId": "hero-cta",
        "textSnippet": "Buy now"
      },
      "context": {
        "binding": {
          "assignmentMethod": "center-hit",
          "assignmentConfidence": 0.91
        },
        "semantic": {
          "computedStyle": {
            "fontSize": "16px",
            "lineHeight": "24px",
            "fontWeight": "400",
            "color": "rgb(255, 255, 255)",
            "backgroundColor": "rgb(51, 51, 51)",
            "borderRadius": "8px",
            "gap": "normal",
            "padding": "0px",
            "width": "120px",
            "height": "36px",
            "margin": "0px"
          },
          "textLayout": {
            "lineCount": 1,
            "wrapState": "overflowing",
            "hasEllipsis": true,
            "lineClamp": "none",
            "overflowsX": true,
            "overflowsY": false
          }
        }
      }
    }
  ],
  "error": null
}
```

## Automation Guidance

Suggested orchestration policy:

- exit code `0`: accept or continue to the next step
- exit code `2`: fix the top finding and rerun
- exit code `3`: stop the auto-fix loop and inspect the report plus artifacts
- exit code `1`: treat as an operational or input error, read `error.code`, fix inputs or environment, and retry

Failure reports keep the same top-level shape where possible and populate `error` with a stable `code`, `message`, and `exitCode`.

# Agent Integration

This guide is for runtimes that use `peye` inside a compare, inspect, fix, and rerun loop.

## Repository Assets

If your runtime supports reusable skill or instruction files, copy or vendor [`agents/SKILL.md`](../agents/SKILL.md) into that runtime's skill registry.

Recommended practice:

- install `peye` separately so the executable is available in `PATH`
- treat [`agents/SKILL.md`](../agents/SKILL.md) as an integration asset, not part of the CLI install step
- keep the skill file versioned alongside the CLI so command flags and report shape stay in sync
- adapt the skill file if your runtime expects a different frontmatter format or install location

[`agents/openai.yaml`](../agents/openai.yaml) is included as a small example of agent-facing metadata and prompt wiring.

## Minimal Workflow

1. Choose the preview input: local screenshot path or `http://` or `https://` URL.
2. Choose the reference input: local screenshot path or Figma URL with `node-id`.
3. Pick one scratch output directory under `./tmp/peye/` for the current target.
4. Before each rerun, remove that scratch directory so only the latest iteration remains.
5. Run `peye compare`.
6. Read `report.json` first.
7. Inspect `heatmap.png` and `overlay.png` only when the report needs visual confirmation.

## Cleanup Rule

Do not keep every historical `peye` run.

- Always write artifacts under `./tmp/peye/<target>`.
- Reuse one scratch directory per target, for example `./tmp/peye/hero`.
- Before rerunning, delete the old scratch directory you created and write the new run into the same path.
- Leave only the latest iteration unless the user explicitly asks to keep history.

Example pattern:

```bash
rm -rf ./tmp/peye/hero
peye compare ... --output ./tmp/peye/hero
```

Only delete scratch directories created for `peye`. Do not delete user-owned assets or reference files.

## How To Read The Result

Trust structured fields more than the PNGs:

- `summary.decisionTrace`
- `summary.topActions`
- `summary.primaryBlockers`
- `summary.safeToAutofix`
- `summary.requiresRecapture`
- `error.code`
- `findings`
- `rollups`

Use `heatmap.png`, `overlay.png`, and `diff.png` as supporting evidence rather than the main contract.

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
4. If `summary.requiresRecapture` is `true`, fix setup or recapture before changing implementation code.
5. Read `summary.decisionTrace[0]` to understand why the current verdict was chosen.
6. Read `summary.primaryBlockers[0]` before changing code.
7. If setup is sound and the top finding exposes `element.selector`, use that as the default next fix target.
8. If `findings` looks small but `rollups.omittedFindings > 0` or `rollups.tailAreaPercent` is still substantial, treat the issue as broader than the visible top-N details.
9. Rerun `peye` into the same cleaned scratch directory.
10. Stop when the result is `pass`, `pass_with_tolerated_differences`, or `needs_human_review`.

Do not keep auto-editing indefinitely on `needs_human_review` unless the cause is clearly understood.

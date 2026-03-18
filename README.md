# peye

`peye` is a standalone CLI for visual diffing an implemented UI against a Figma reference or another screenshot. It is built for deterministic local execution and agent-driven validation workflows.

The comparison core is intentionally separated from screenshot acquisition, so the tool stays scriptable, predictable, and easy to embed into automation pipelines.

## Highlights

- Compare a live preview URL or a local screenshot against a Figma node or another image
- Capture a specific section with `--selector` or directly from a preview URL hash
- Ignore known preview noise such as sticky banners or third-party overlays
- Generate deterministic artifacts: `report.json`, `overlay.png`, `diff.png`, `heatmap.png`, and normalized inputs
- Return an actionable recommendation: `pass`, `pass_with_tolerated_differences`, `retry_fix`, or `needs_human_review`

## Typical Use Cases

- Validate a locally implemented section against a Figma frame
- Compare two screenshots in CI or local review workflows
- Run an agent loop: compare, inspect `report.json`, fix, and rerun
- Triage whether a mismatch is small, fixable, or should be escalated to human review

## Requirements

- Node.js `>= 22`
- Playwright Chromium for live URL capture
- One of these when `--reference` is a Figma URL:
  - Figma desktop MCP
  - remote Figma MCP authorization in an interactive terminal
  - `FIGMA_TOKEN` for REST fallback or CI

If you only compare local images, you do not need a browser download.

## Installation

Install the published CLI:

```bash
npm install -g @americano98/peye
peye install chromium
peye --help
```

Build from source:

```bash
pnpm install
pnpm build
node dist/bin.js --help
```

`peye install chromium` is only required for live URL capture. Pure image-to-image comparison works without a browser download.

## Quick Start

Compare a live section against a Figma node:

```bash
peye compare \
  --preview http://localhost:3000/#hero \
  --reference "https://www.figma.com/design/FILE_KEY/Mockup?node-id=1-2" \
  --viewport 1920 \
  --output ./tmp/peye/hero
```

`peye` writes the comparison artifacts into the output directory and uses `report.json` as the main machine-readable contract.

Compare two local images:

```bash
peye compare \
  --preview ./artifacts/preview.png \
  --reference ./artifacts/reference.png \
  --output ./tmp/peye/run
```

## Output

Each run writes a deterministic output bundle:

- `report.json`: primary machine-readable result
- `preview.png`: normalized preview image used for analysis
- `reference.png`: normalized reference image used for analysis
- `overlay.png`: blended reference plus preview image
- `diff.png`: raw pixel diff image
- `heatmap.png`: highlighted mismatch regions

For automation, the most important fields are:

- `summary.recommendation`
- `summary.decisionTrace`
- `summary.topActions`
- `summary.primaryBlockers`
- `summary.safeToAutofix`
- `summary.requiresRecapture`
- `findings`
- `error`

## Documentation

- [Documentation index](./docs/README.md)
- [CLI usage and examples](./docs/cli.md)
- [Figma reference sources and environment variables](./docs/figma.md)
- [Report format and artifacts](./docs/report.md)
- [Agent integration guide](./docs/agent-integration.md)

## Agent Integration

Reusable agent assets live in [`agents/`](./agents). The main file is [`agents/SKILL.md`](./agents/SKILL.md).

If you want AI agents to use `peye` correctly, you should add or vendor [`agents/SKILL.md`](./agents/SKILL.md) into your agent runtime or skill registry. That file tells the agent:

- when `peye` should be used
- how to run `peye compare`
- how to interpret `report.json`
- how to structure compare -> inspect -> fix -> rerun loops

Recommended setup:

- install the CLI so the `peye` executable is available in `PATH`
- copy or vendor [`agents/SKILL.md`](./agents/SKILL.md) into the agent environment
- keep the skill file versioned alongside the CLI version you use
- adapt the file if your runtime expects different metadata or frontmatter

[`agents/openai.yaml`](./agents/openai.yaml) is included as a small example of agent-facing metadata and prompt wiring.

Important: the published npm package installs the CLI, but it does not install the agent skill files for you. If your workflow depends on AI agents, you need to add [`agents/SKILL.md`](./agents/SKILL.md) yourself.

## Development

```bash
pnpm check
```

This runs formatting checks, type checking, linting, tests, and the production build.

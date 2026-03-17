# AGENTS.md

## `peye` project overview

This repository contains a local CLI tool for visual validation of implemented UI against a Figma design reference.

Primary use case:

1. An orchestration agent selects a Figma section to implement.
2. A coding agent implements the section in a target application.
3. This CLI captures or receives:
   - a Figma reference image
   - a browser screenshot of the implementation
   - validation settings such as viewport, thresholds, masks, and target region
4. The CLI computes visual and structural differences.
5. The CLI returns machine-readable results that can be used by an agent to decide whether:
   - the section passes
   - the section should be fixed
   - the section needs human review

This tool is not a design generator.  
This tool is a validation and analysis utility.

The output of this project must be stable, deterministic, scriptable, and friendly for agent-driven workflows.

---

## Core product goal

Build a robust local CLI that compares a Figma reference screenshot with a rendered browser screenshot and produces:

- a structured JSON report
- optional heatmap / diff images
- region-level mismatch information
- severity classification
- a final recommendation:
  - `pass`
  - `pass_with_tolerated_differences`
  - `retry_fix`
  - `needs_human_review`

The CLI must be usable both by humans and by automation systems.

---

## Non-goals

This repository must not attempt to:

- generate UI code
- directly edit application source code
- replace browser automation frameworks
- become a full visual regression SaaS
- depend on cloud-only infrastructure for core comparison
- require any product-specific runtime in order to function

The CLI should remain independently usable from a terminal.

---

## Intended users

### Primary users

- AI orchestration agents
- coding agents
- developers building automated Figma-to-code workflows

### Secondary users

- frontend engineers validating pixel-level implementation quality
- designers reviewing implementation fidelity
- teams building internal automation pipelines

---

## Repository expectations

This repository should be designed as a production-quality utility, not as a throwaway script.

Prioritize:

- deterministic outputs
- clear boundaries between modules
- well-defined data contracts
- composable architecture
- good developer ergonomics
- testability
- low-friction local execution

Avoid:

- oversized abstraction too early
- framework sprawl
- hidden magic
- hardcoded project-specific assumptions
- mixing browser orchestration with comparison logic unless clearly isolated

---

## Recommended stack

Preferred implementation language:

- TypeScript running on Node.js

Preferred package manager:

- pnpm

Recommended image/comparison tooling:

- pixelmatch and/or sharp
- optional Playwright integration only as an adapter layer if browser screenshot capture is included in this repository

Do not lock the implementation to a single browser automation framework unless required by a specific module.

The image comparison core should remain independent from screenshot acquisition.

---

## High-level architecture

The project should be organized into clearly separated layers:

### 1. CLI layer

Responsible for:

- parsing command-line arguments
- validating inputs
- selecting operation mode
- writing outputs
- mapping internal errors to user-friendly CLI errors

### 2. Input resolution layer

Responsible for:

- resolving local file paths
- resolving output paths
- reading config files
- normalizing viewport and region definitions
- optionally handling external reference acquisition if explicitly implemented

### 3. Screenshot acquisition layer

Responsible for:

- obtaining the implementation screenshot
- optionally capturing from a URL at a requested viewport
- optionally cropping to a region or selector
- remaining replaceable and isolated from diff logic

### 4. Reference preparation layer

Responsible for:

- loading Figma reference image
- normalizing dimensions
- applying masks
- optional cropping or alignment preparation

### 5. Alignment and normalization layer

Responsible for:

- image dimension normalization
- optional region-based alignment
- pre-processing for fair comparison
- handling acceptable rendering differences where possible

### 6. Comparison engine

Responsible for:

- computing pixel mismatch
- color difference metrics
- layout-sensitive mismatch signals
- optional bounding-box / region mismatch summaries

### 7. Analysis layer

Responsible for:

- classifying defects
- detecting probable text clipping or severe displacement
- grouping results by severity
- generating final recommendation

### 8. Output layer

Responsible for:

- JSON report
- heatmap image
- raw diff image
- terminal summary

---

## Suggested directory structure

Use a simple structure like this:

```txt
src/
  cli/
  config/
  core/
  compare/
  analysis/
  capture/
  io/
  types/
  utils/

test/
fixtures/
examples/
```

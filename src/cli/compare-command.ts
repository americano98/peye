import path from "node:path";
import type { Command } from "commander";
import { DEFAULT_MODE, DEFAULT_THRESHOLDS } from "../config/defaults.js";
import { runCompare } from "../core/run-compare.js";
import { COMPARE_MODES, type CompareCommandOptions } from "../types/report.js";
import { AppError, isAppError } from "../utils/errors.js";

interface CompareCliOptions extends CompareCommandOptions {
  quiet: boolean;
  reportStdout: boolean;
}

export function registerCompareCommand(program: Command): void {
  program
    .command("compare")
    .description("Compare a preview screenshot or URL against a Figma reference or local image.")
    .requiredOption("--preview <url|path>", "Preview URL or screenshot path")
    .requiredOption("--reference <figma-url|path>", "Figma URL or local reference screenshot path")
    .requiredOption("--output <dir>", "Output directory for report and generated artifacts")
    .option(
      "--viewport <width|widthxheight>",
      "Viewport width or widthxheight used for preview URL capture, for example 1920 or 1920x900",
    )
    .option("--mode <mode>", "Analysis mode: all, pixel, layout, color", DEFAULT_MODE)
    .option("--selector <css>", "CSS selector for preview element capture")
    .option("--full-page", "Capture the full preview page when preview is a URL", false)
    .option("--quiet", "Suppress the human-readable terminal summary", false)
    .option(
      "--report-stdout",
      "Write compact report JSON to stdout and suppress the human-readable summary",
      false,
    )
    .option(
      "--threshold-pass <number>",
      "Pass threshold in percent",
      parseFloat,
      DEFAULT_THRESHOLDS.pass,
    )
    .option(
      "--threshold-tolerated <number>",
      "Tolerated threshold in percent",
      parseFloat,
      DEFAULT_THRESHOLDS.tolerated,
    )
    .option(
      "--threshold-retry <number>",
      "Retry threshold in percent",
      parseFloat,
      DEFAULT_THRESHOLDS.retry,
    )
    .action(async (rawOptions: CompareCliOptions) => {
      const { quiet, reportStdout, ...options } = validateOptions(rawOptions);
      const result = await runCompare(options);

      writeCliOutput(result.report, { quiet, reportStdout });
      process.exitCode = result.exitCode;
    });
}

function validateOptions(options: CompareCliOptions): CompareCliOptions {
  if (!COMPARE_MODES.includes(options.mode)) {
    throw new AppError(
      `Invalid --mode value "${options.mode}". Expected one of: ${COMPARE_MODES.join(", ")}.`,
    );
  }

  for (const [label, value] of [
    ["threshold-pass", options.thresholdPass],
    ["threshold-tolerated", options.thresholdTolerated],
    ["threshold-retry", options.thresholdRetry],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new AppError(`--${label} must be a non-negative number.`);
    }
  }

  return options;
}

function writeCliOutput(
  report: Awaited<ReturnType<typeof runCompare>>["report"],
  options: Pick<CompareCliOptions, "quiet" | "reportStdout">,
): void {
  if (options.reportStdout) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  if (options.quiet) {
    return;
  }

  printSummary(report);
}

function printSummary(report: Awaited<ReturnType<typeof runCompare>>["report"]): void {
  console.log(`recommendation: ${report.summary.recommendation}`);
  console.log(`severity: ${report.summary.severity}`);
  console.log(`reason: ${report.summary.reason}`);
  console.log(`mismatchPercent: ${report.metrics.mismatchPercent.toFixed(4)}%`);
  console.log(`findings: ${report.findings.length}/${report.metrics.findingsCount}`);
  console.log(`output: ${path.dirname(report.artifacts.report)}`);
}

export function handleCliError(error: unknown): void {
  if (isAppError(error)) {
    console.error(error.message);
    process.exitCode = error.exitCode;
    return;
  }

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Unknown error");
  }

  process.exitCode = 1;
}

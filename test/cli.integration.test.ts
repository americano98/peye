import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { CompareReport } from "../src/types/report.js";
import { createPngFromSvg, createTempDir } from "./helpers/fixtures.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const distBinPath = path.join(repoRoot, "dist", "bin.js");
let buildPromise: Promise<void> | null = null;

interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function ensureBuiltCli(): Promise<void> {
  if (!buildPromise) {
    buildPromise = runProcess("pnpm", ["build"], repoRoot).then((result) => {
      if (result.code !== 0) {
        throw new Error(
          `Failed to build CLI for integration test.\n${result.stderr || result.stdout}`,
        );
      }
    });
  }

  await buildPromise;
}

async function runCli(args: string[]): Promise<CliRunResult> {
  await ensureBuiltCli();
  return runProcess(process.execPath, [distBinPath, ...args], repoRoot);
}

function runProcess(command: string, args: string[], cwd: string): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function readReport(reportPath: string): Promise<CompareReport> {
  return JSON.parse(await readFile(reportPath, "utf8")) as CompareReport;
}

describe("built CLI integration", () => {
  test("returns retry_fix exit code through the built binary", async () => {
    const dir = await createTempDir("peye-cli-retry");
    const previewPath = path.join(dir, "preview.png");
    const referencePath = path.join(dir, "reference.png");
    const outputPath = path.join(dir, "out");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 100,
      height: 100,
      body: `<rect x="10" y="10" width="30" height="30" fill="#0b84ff" />`,
    });
    await createPngFromSvg({
      outputPath: previewPath,
      width: 100,
      height: 100,
      body: `<rect x="20" y="10" width="30" height="30" fill="#0b84ff" />`,
    });

    const result = await runCli([
      "compare",
      "--preview",
      previewPath,
      "--reference",
      referencePath,
      "--output",
      outputPath,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("recommendation: retry_fix");
    expect(result.stdout).toContain(`output: ${outputPath}`);
  });

  test("--quiet suppresses the human-readable summary", async () => {
    const dir = await createTempDir("peye-cli-quiet");
    const previewPath = path.join(dir, "preview.png");
    const referencePath = path.join(dir, "reference.png");
    const outputPath = path.join(dir, "out");

    await createPngFromSvg({
      outputPath: previewPath,
      width: 80,
      height: 60,
      body: `<rect x="10" y="10" width="60" height="40" fill="#0b84ff" />`,
    });
    await createPngFromSvg({
      outputPath: referencePath,
      width: 80,
      height: 60,
      body: `<rect x="10" y="10" width="60" height="40" fill="#0b84ff" />`,
    });

    const result = await runCli([
      "compare",
      "--preview",
      previewPath,
      "--reference",
      referencePath,
      "--output",
      outputPath,
      "--quiet",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    await expect(readFile(path.join(outputPath, "report.json"), "utf8")).resolves.toContain(
      '"pass"',
    );
  });

  test("--report-stdout prints compact report JSON and suppresses the summary", async () => {
    const dir = await createTempDir("peye-cli-stdout");
    const previewPath = path.join(dir, "preview.png");
    const referencePath = path.join(dir, "reference.png");
    const outputPath = path.join(dir, "out");

    await createPngFromSvg({
      outputPath: previewPath,
      width: 80,
      height: 60,
      body: `<rect x="10" y="10" width="60" height="40" fill="#0b84ff" />`,
    });
    await createPngFromSvg({
      outputPath: referencePath,
      width: 80,
      height: 60,
      body: `<rect x="10" y="10" width="60" height="40" fill="#0b84ff" />`,
    });

    const result = await runCli([
      "compare",
      "--preview",
      previewPath,
      "--reference",
      referencePath,
      "--output",
      outputPath,
      "--report-stdout",
    ]);
    const writtenReport = await readReport(path.join(outputPath, "report.json"));
    const stdoutReport = JSON.parse(result.stdout) as CompareReport;

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("recommendation:");
    expect("reportVersion" in stdoutReport).toBe(false);
    expect(stdoutReport.summary.recommendation).toBe("pass");
    expect(stdoutReport.error).toBeNull();
    expect(stdoutReport).toEqual(writtenReport);
  });
});

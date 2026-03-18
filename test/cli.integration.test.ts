import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { CompareReport } from "../src/types/report.js";
import { createPngFromSvg, createTempDir } from "./helpers/fixtures.js";
import { startServer } from "./helpers/http.js";

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

  test("supports repeatable --ignore-selector and reports selector matches in stdout JSON", async () => {
    const dir = await createTempDir("peye-cli-ignore");
    const referencePath = path.join(dir, "reference.png");
    const outputPath = path.join(dir, "out");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 120,
      height: 80,
      body: `<rect x="20" y="20" width="80" height="24" rx="4" fill="#0b84ff" />`,
    });

    const server = await startServer((request, response) => {
      if (request.url === "/" || request.url === "/index.html" || request.url === "/#hero") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`
          <!doctype html>
          <html>
            <head>
              <style>
                html, body { margin: 0; padding: 0; background: #ffffff; }
                #hero { position: relative; width: 120px; height: 80px; }
                #hero button {
                  position: absolute;
                  left: 20px;
                  top: 20px;
                  width: 80px;
                  height: 24px;
                  border: 0;
                  border-radius: 4px;
                  background: #0b84ff;
                  color: transparent;
                  font-size: 0;
                }
                #noise {
                  position: fixed;
                  top: 0;
                  left: 0;
                  width: 120px;
                  height: 20px;
                  background: #ff6633;
                }
              </style>
            </head>
            <body>
              <section id="hero">
                <button>Buy</button>
              </section>
              <div id="noise" class="noise"></div>
            </body>
          </html>
        `);
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    });

    try {
      const result = await runCli([
        "compare",
        "--preview",
        `${server.baseUrl}/#hero`,
        "--reference",
        referencePath,
        "--output",
        outputPath,
        "--viewport",
        "320x240",
        "--ignore-selector",
        "#noise",
        "--ignore-selector",
        ".noise",
        "--report-stdout",
      ]);
      const stdoutReport = JSON.parse(result.stdout) as CompareReport;

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(stdoutReport.inputs.preview.ignoreSelectors).toEqual([
        { selector: "#noise", matchedElementCount: 1 },
        { selector: ".noise", matchedElementCount: 1 },
      ]);
      expect(stdoutReport.metrics.ignoredPixels).toBe(120 * 20);
      expect(stdoutReport.summary.recommendation).toBe("pass");
    } finally {
      await server.close();
    }
  });
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runCompare } from "../src/core/run-compare.js";
import type { CompareCommandOptions } from "../src/types/report.js";
import { createTempDir, createPngFromSvg } from "./helpers/fixtures.js";
import { startServer } from "./helpers/http.js";

async function buildOptions(
  overrides: Partial<CompareCommandOptions>,
): Promise<CompareCommandOptions> {
  const output =
    overrides.output ?? path.join(await createTempDir("peye-correspond-out"), "artifacts");

  return {
    preview: "",
    reference: "",
    output,
    mode: "all",
    ignoreSelectors: [],
    fullPage: false,
    thresholdPass: 0.5,
    thresholdTolerated: 1.5,
    thresholdRetry: 5,
    ...overrides,
  };
}

describe("runCompare correspondence integration", () => {
  test("adds localization fields to a shifted button finding", async () => {
    const dir = await createTempDir("peye-correspond-shift");
    const referencePath = path.join(dir, "reference.png");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 220,
      height: 100,
      body: `
        <rect x="20" y="32" width="120" height="32" rx="8" fill="#0b84ff" />
      `,
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
                #hero { position: relative; width: 220px; height: 100px; }
                #hero button {
                  position: absolute;
                  left: 32px;
                  top: 32px;
                  width: 120px;
                  height: 32px;
                  border: 0;
                  border-radius: 8px;
                  background: #333333;
                  color: transparent;
                  font-size: 0;
                }
              </style>
            </head>
            <body>
              <section id="hero">
                <button id="cta" data-testid="hero-cta">Buy</button>
              </section>
            </body>
          </html>
        `);
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    });

    try {
      const result = await runCompare(
        await buildOptions({
          preview: `${server.baseUrl}/#hero`,
          reference: referencePath,
          output: path.join(dir, "out"),
          viewport: "400x240",
        }),
      );
      const buttonFinding = result.report.findings.find(
        (finding) => finding.element?.selector === "section#hero > button#cta",
      );

      expect(result.report.summary.correspondenceCoverage).not.toBeNull();
      expect(result.report.summary.correspondenceConfidence).not.toBeNull();
      expect(result.report.summary.ambiguousCorrespondences).not.toBeNull();
      expect(buttonFinding?.granularity).toBe("group");
      expect(buttonFinding?.matchedReferenceBBox).toBeDefined();
      expect(buttonFinding?.correspondenceMethod).toMatch(/template|template\+edge/);
      expect(buttonFinding?.correspondenceConfidence).toBeGreaterThan(0);
      expect(Math.abs(buttonFinding?.delta?.dx ?? 0)).toBeGreaterThanOrEqual(8);
      expect(buttonFinding?.geometry).toEqual(
        expect.objectContaining({
          centerShiftPx: expect.any(Number),
          normalizedCenterShift: expect.any(Number),
          dominantDrift: expect.stringMatching(/position|size|mixed|none/),
        }),
      );
      const summary = await readFile(result.report.artifacts.summary, "utf8");
      expect(summary).toContain("## Findings");
      expect(summary).toContain("section#hero > button#cta");
      expect(summary).toContain("Current preview props");
    } finally {
      await server.close();
    }
  });

  test("writes profile.json when PEYE_DEBUG_TIMINGS=1", async () => {
    const dir = await createTempDir("peye-correspond-profile");
    const previousDebug = process.env.PEYE_DEBUG_TIMINGS;
    const referencePath = path.join(dir, "reference.png");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 180,
      height: 100,
      body: `<rect x="20" y="32" width="120" height="32" rx="8" fill="#0b84ff" />`,
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
                #hero { position: relative; width: 180px; height: 100px; }
                #hero button {
                  position: absolute;
                  left: 28px;
                  top: 32px;
                  width: 120px;
                  height: 32px;
                  border: 0;
                  border-radius: 8px;
                  background: #222222;
                  color: transparent;
                  font-size: 0;
                }
              </style>
            </head>
            <body>
              <section id="hero">
                <button id="cta">Buy</button>
              </section>
            </body>
          </html>
        `);
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    });

    try {
      process.env.PEYE_DEBUG_TIMINGS = "1";
      const output = path.join(dir, "out");
      await runCompare(
        await buildOptions({
          preview: `${server.baseUrl}/#hero`,
          reference: referencePath,
          output,
          viewport: "400x240",
        }),
      );

      const profile = JSON.parse(await readFile(path.join(output, "profile.json"), "utf8")) as {
        timingsMs: Record<string, number>;
        counts: Record<string, number>;
      };

      expect(profile.timingsMs.previewCapture).toBeGreaterThanOrEqual(0);
      expect(profile.timingsMs.referenceFetch).toBeGreaterThanOrEqual(0);
      expect(profile.timingsMs.compare).toBeGreaterThanOrEqual(0);
      expect(profile.timingsMs.alignment).toBeGreaterThanOrEqual(0);
      expect(profile.timingsMs.coarseSearch).toBeGreaterThanOrEqual(0);
      expect(profile.timingsMs.refinement).toBeGreaterThanOrEqual(0);
      expect(profile.timingsMs.findings).toBeGreaterThanOrEqual(0);
      expect(profile.counts.groupsBuilt).toBeGreaterThanOrEqual(1);
      expect(profile.counts.groupsSearched).toBeGreaterThanOrEqual(1);
    } finally {
      if (previousDebug === undefined) {
        delete process.env.PEYE_DEBUG_TIMINGS;
      } else {
        process.env.PEYE_DEBUG_TIMINGS = previousDebug;
      }

      await server.close();
    }
  });
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import sharp from "sharp";
import { runCompare } from "../src/core/run-compare.js";
import type { CompareCommandOptions, CompareReport } from "../src/types/report.js";
import { createTempDir, createPngFromSvg } from "./helpers/fixtures.js";
import { startServer } from "./helpers/http.js";
import { startMockFigmaMcpServer } from "./helpers/mcp.js";

async function buildOptions(
  overrides: Partial<CompareCommandOptions>,
): Promise<CompareCommandOptions> {
  const output = overrides.output ?? path.join(await createTempDir("peye-out"), "artifacts");

  return {
    preview: "",
    reference: "",
    output,
    mode: "all",
    fullPage: false,
    thresholdPass: 0.5,
    thresholdTolerated: 1.5,
    thresholdRetry: 5,
    ...overrides,
  };
}

async function readReport(reportPath: string): Promise<CompareReport> {
  return JSON.parse(await readFile(reportPath, "utf8")) as CompareReport;
}

function snapshotFigmaEnv(): Record<string, string | undefined> {
  return {
    FIGMA_API_BASE_URL: process.env.FIGMA_API_BASE_URL,
    FIGMA_TOKEN: process.env.FIGMA_TOKEN,
    PEYE_FIGMA_MCP_DESKTOP_URL: process.env.PEYE_FIGMA_MCP_DESKTOP_URL,
    PEYE_FIGMA_MCP_REMOTE_URL: process.env.PEYE_FIGMA_MCP_REMOTE_URL,
    PEYE_FIGMA_SOURCE: process.env.PEYE_FIGMA_SOURCE,
  };
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

function setInteractiveTerminal(value: boolean): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });

  return () => {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    } else {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: undefined,
      });
    }

    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    } else {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: undefined,
      });
    }
  };
}

describe("runCompare integration", () => {
  test("passes for identical local images without schema metadata noise", async () => {
    const dir = await createTempDir("peye-identical");
    const previewPath = path.join(dir, "preview.png");
    const referencePath = path.join(dir, "reference.png");

    await createPngFromSvg({
      outputPath: previewPath,
      width: 100,
      height: 100,
      body: `<rect x="10" y="10" width="80" height="80" fill="#0b84ff" />`,
    });

    await createPngFromSvg({
      outputPath: referencePath,
      width: 100,
      height: 100,
      body: `<rect x="10" y="10" width="80" height="80" fill="#0b84ff" />`,
    });

    const result = await runCompare(
      await buildOptions({
        preview: previewPath,
        reference: referencePath,
        output: path.join(dir, "out"),
      }),
    );

    expect("reportVersion" in result.report).toBe(false);
    expect(result.report.analysisMode).toBe("visual-clusters");
    expect(result.report.summary.recommendation).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.report.images).toEqual({
      preview: { width: 100, height: 100 },
      reference: { width: 100, height: 100 },
      canvas: { width: 100, height: 100 },
    });
    expect(result.report.error).toBeNull();
    expect(result.report.findings).toEqual([]);
    expect(result.report.rollups.rawRegionCount).toBe(0);
    expect(result.report.metrics.findingsCount).toBe(0);
  });

  test("returns tolerated differences with compact visual-cluster findings for local images", async () => {
    const dir = await createTempDir("peye-color");
    const previewPath = path.join(dir, "preview.png");
    const referencePath = path.join(dir, "reference.png");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 100,
      height: 100,
      body: `<rect x="10" y="10" width="80" height="80" fill="#0b84ff" />`,
    });

    await createPngFromSvg({
      outputPath: previewPath,
      width: 100,
      height: 100,
      body: `
        <rect x="10" y="10" width="80" height="80" fill="#0b84ff" />
        <rect x="10" y="10" width="10" height="10" fill="#ff6633" />
      `,
    });

    const result = await runCompare(
      await buildOptions({
        preview: previewPath,
        reference: referencePath,
        output: path.join(dir, "out"),
      }),
    );

    expect(result.report.summary.recommendation).toBe("pass_with_tolerated_differences");
    expect(result.report.analysisMode).toBe("visual-clusters");
    expect(result.exitCode).toBe(0);
    expect(result.report.metrics.mismatchPercent).toBeGreaterThan(0.5);
    expect(result.report.metrics.mismatchPercent).toBeLessThanOrEqual(1.5);
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]?.source).toBe("visual-cluster");
    expect(result.report.findings[0]?.element).toBeNull();
    expect(Array.isArray(result.report.findings[0]?.hotspots)).toBe(true);
  });

  test("groups selector capture mismatches by DOM element", async () => {
    const dir = await createTempDir("peye-dom");
    const referencePath = path.join(dir, "reference.png");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 240,
      height: 140,
      body: `
        <rect x="20" y="20" width="160" height="40" fill="#0b84ff" />
        <rect x="20" y="80" width="120" height="36" rx="8" fill="#333333" />
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
                #hero { position: relative; width: 240px; height: 140px; }
                #hero h1 {
                  position: absolute;
                  left: 20px;
                  top: 20px;
                  margin: 0;
                  width: 160px;
                  height: 40px;
                  background: #ff6633;
                  font-size: 0;
                  line-height: 0;
                }
                #hero button {
                  position: absolute;
                  left: 20px;
                  top: 80px;
                  width: 120px;
                  height: 36px;
                  border: 0;
                  border-radius: 8px;
                  background: #111111;
                  color: transparent;
                  font-size: 0;
                }
              </style>
            </head>
            <body>
              <section id="hero">
                <h1>Hero</h1>
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
      const result = await runCompare(
        await buildOptions({
          preview: `${server.baseUrl}/#hero`,
          reference: referencePath,
          output: path.join(dir, "out"),
          viewport: "400x240",
        }),
      );

      expect(result.report.analysisMode).toBe("dom-elements");
      expect(result.report.inputs.preview.selector).toBe("#hero");
      expect(result.report.findings).toHaveLength(2);
      expect(result.report.findings.map((finding) => finding.element?.tag)).toEqual([
        "h1",
        "button",
      ]);
      expect(result.report.rollups.byTag).toEqual([
        { tag: "button", count: 1 },
        { tag: "h1", count: 1 },
      ]);
      expect(result.report.findings[0]?.element?.bbox.x).toBeLessThan(240);
      expect(result.report.findings[0]?.element?.bbox.y).toBeLessThan(140);
      expect(result.report.images).toEqual({
        preview: { width: 240, height: 140 },
        reference: { width: 240, height: 140 },
        canvas: { width: 240, height: 140 },
      });
    } finally {
      await server.close();
    }
  });

  test("emits a text clipping signal for overflowing DOM text", async () => {
    const dir = await createTempDir("peye-text-clipping");
    const referencePath = path.join(dir, "reference.png");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 160,
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
                #hero { position: relative; width: 160px; height: 80px; }
                #hero button {
                  position: absolute;
                  left: 20px;
                  top: 20px;
                  width: 80px;
                  height: 24px;
                  padding: 0 6px;
                  border: 0;
                  border-radius: 4px;
                  overflow: hidden;
                  text-overflow: ellipsis;
                  white-space: nowrap;
                  background: #222222;
                  color: #ffffff;
                  font: 16px/24px monospace;
                  text-align: left;
                }
              </style>
            </head>
            <body>
              <section id="hero">
                <button id="cta">Very long button label</button>
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
          viewport: "240x160",
        }),
      );

      const buttonFinding = result.report.findings.find(
        (finding) => finding.element?.tag === "button",
      );

      expect(buttonFinding).toBeDefined();
      expect(buttonFinding?.signals).toContainEqual({
        code: "probable_text_clipping",
        confidence: "medium",
        message:
          "Text content likely overflows the element bounds and is being clipped on the horizontal axis.",
      });
    } finally {
      await server.close();
    }
  });

  test("emits a capture crop signal when selector capture clips an element at the boundary", async () => {
    const dir = await createTempDir("peye-capture-crop");
    const referencePath = path.join(dir, "reference.png");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 120,
      height: 60,
      body: `<rect x="20" y="18" width="80" height="24" rx="4" fill="#0b84ff" />`,
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
                #hero { position: relative; width: 120px; height: 60px; }
                #hero button {
                  position: absolute;
                  left: 70px;
                  top: 18px;
                  width: 80px;
                  height: 24px;
                  border: 0;
                  border-radius: 4px;
                  background: #222222;
                  color: #ffffff;
                  font: 14px/24px monospace;
                }
              </style>
            </head>
            <body>
              <section id="hero">
                <button id="cta">Buy now</button>
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
          viewport: "240x160",
        }),
      );

      const buttonFinding = result.report.findings.find(
        (finding) => finding.element?.tag === "button",
      );

      expect(buttonFinding).toBeDefined();
      expect(buttonFinding?.signals).toContainEqual({
        code: "possible_capture_crop",
        confidence: "high",
        message:
          "Element bounds were clipped by the preview capture on the right edge(s); check selector scope and capture framing.",
      });
    } finally {
      await server.close();
    }
  });

  test("writes a failure report when selector capture cannot find the target", async () => {
    const dir = await createTempDir("peye-selector-failure");
    const referencePath = path.join(dir, "reference.png");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 120,
      height: 80,
      body: `<rect x="10" y="10" width="100" height="60" fill="#0b84ff" />`,
    });

    const server = await startServer((request, response) => {
      if (request.url === "/" || request.url === "/index.html") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`
          <!doctype html>
          <html>
            <body>
              <main id="app">No matching selector here</main>
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
          preview: `${server.baseUrl}/`,
          selector: "#missing",
          reference: referencePath,
          output: path.join(dir, "out"),
          viewport: "400x240",
        }),
      );
      const report = await readReport(result.report.artifacts.report);

      expect(result.exitCode).toBe(3);
      expect(result.report.summary.recommendation).toBe("needs_human_review");
      expect(result.report.analysisMode).toBe("dom-elements");
      expect(result.report.inputs.preview.selector).toBe("#missing");
      expect(report.error).not.toBeNull();
      expect(report.error?.code).toBe("preview_selector_capture_failed");
      expect(report.error?.message).toContain("Preview selector could not be captured: #missing.");
      expect(report.error?.exitCode).toBe(3);
      expect(report.images).toEqual({
        preview: null,
        reference: null,
        canvas: null,
      });
      expect(result.report.findings).toEqual([]);
      expect(report.artifacts.preview).toBeNull();
      expect(report.artifacts.reference).toBeNull();
      expect(report.artifacts.overlay).toBeNull();
      expect(report.artifacts.diff).toBeNull();
      expect(report.artifacts.heatmap).toBeNull();
    } finally {
      await server.close();
    }
  });

  test("returns retry_fix for shifted local image with visual clusters", async () => {
    const dir = await createTempDir("peye-shifted");
    const previewPath = path.join(dir, "preview.png");
    const referencePath = path.join(dir, "reference.png");

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

    const result = await runCompare(
      await buildOptions({
        preview: previewPath,
        reference: referencePath,
        output: path.join(dir, "out"),
      }),
    );

    expect(result.report.summary.recommendation).toBe("retry_fix");
    expect(result.exitCode).toBe(2);
    expect(result.report.analysisMode).toBe("visual-clusters");
    expect(result.report.findings.length).toBeGreaterThan(0);
    expect(result.report.findings[0]?.element).toBeNull();
    expect(Array.isArray(result.report.findings[0]?.hotspots)).toBe(true);
  });

  test("returns a single dimension finding for large canvas mismatch", async () => {
    const dir = await createTempDir("peye-dimensions");
    const previewPath = path.join(dir, "preview.png");
    const referencePath = path.join(dir, "reference.png");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 100,
      height: 100,
      body: `<rect x="10" y="10" width="80" height="80" fill="#0b84ff" />`,
    });

    await createPngFromSvg({
      outputPath: previewPath,
      width: 220,
      height: 160,
      body: `<rect x="10" y="10" width="80" height="80" fill="#0b84ff" />`,
    });

    const result = await runCompare(
      await buildOptions({
        preview: previewPath,
        reference: referencePath,
        output: path.join(dir, "out"),
      }),
    );

    expect(result.report.summary.recommendation).toBe("needs_human_review");
    expect(result.exitCode).toBe(3);
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]?.kind).toBe("dimension");
    expect(result.report.findings[0]?.issueTypes).toEqual(["missing_or_extra", "size"]);
    expect(result.report.findings[0]?.signals).toContainEqual({
      code: "possible_viewport_mismatch",
      confidence: "medium",
      message:
        "Dimension mismatch reaches the top, right, bottom, and left edge(s) of the comparison canvas; verify viewport, selected frame, and capture target.",
    });
    expect(result.report.images).toEqual({
      preview: { width: 220, height: 160 },
      reference: { width: 100, height: 100 },
      canvas: { width: 220, height: 160 },
    });
  });

  test("caps noisy reports and keeps report.json compact", async () => {
    const dir = await createTempDir("peye-noisy");
    const previewPath = path.join(dir, "preview.png");
    const referencePath = path.join(dir, "reference.png");
    const noisyRects: string[] = [];

    for (let row = 0; row < 10; row += 1) {
      for (let column = 0; column < 10; column += 1) {
        noisyRects.push(
          `<rect x="${12 + column * 28}" y="${12 + row * 28}" width="4" height="4" fill="#ff6633" />`,
        );
      }
    }

    await createPngFromSvg({
      outputPath: referencePath,
      width: 320,
      height: 320,
      body: "",
    });

    await createPngFromSvg({
      outputPath: previewPath,
      width: 320,
      height: 320,
      body: noisyRects.join("\n"),
    });

    const result = await runCompare(
      await buildOptions({
        preview: previewPath,
        reference: referencePath,
        output: path.join(dir, "out"),
      }),
    );
    const reportBuffer = await readFile(result.report.artifacts.report);

    expect(result.report.analysisMode).toBe("visual-clusters");
    expect(result.report.rollups.rawRegionCount).toBe(100);
    expect(result.report.metrics.findingsCount).toBe(100);
    expect(result.report.findings).toHaveLength(25);
    expect(result.report.rollups.omittedFindings).toBe(75);
    expect(reportBuffer.byteLength).toBeLessThan(32_000);
  });

  test("emits deterministic report content across repeated runs", async () => {
    const dir = await createTempDir("peye-deterministic");
    const previewPath = path.join(dir, "preview.png");
    const referencePath = path.join(dir, "reference.png");
    const outputPath = path.join(dir, "out");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 200,
      height: 120,
      body: `<rect x="20" y="20" width="100" height="40" fill="#0b84ff" />`,
    });

    await createPngFromSvg({
      outputPath: previewPath,
      width: 200,
      height: 120,
      body: `<rect x="30" y="20" width="100" height="40" fill="#0b84ff" />`,
    });

    const firstRun = await runCompare(
      await buildOptions({
        preview: previewPath,
        reference: referencePath,
        output: outputPath,
      }),
    );
    const firstReport = await readFile(firstRun.report.artifacts.report, "utf8");

    const secondRun = await runCompare(
      await buildOptions({
        preview: previewPath,
        reference: referencePath,
        output: outputPath,
      }),
    );
    const secondReport = await readFile(secondRun.report.artifacts.report, "utf8");

    expect(secondReport).toBe(firstReport);
  });

  test("downloads a figma reference through the rest provider", async () => {
    const dir = await createTempDir("peye-figma");
    const previewPath = path.join(dir, "preview.png");
    const referenceBufferPath = path.join(dir, "mock-reference.png");

    await createPngFromSvg({
      outputPath: previewPath,
      width: 90,
      height: 60,
      body: `<rect x="0" y="0" width="90" height="60" fill="#ff6633" />`,
    });

    await createPngFromSvg({
      outputPath: referenceBufferPath,
      width: 90,
      height: 60,
      body: `<rect x="0" y="0" width="90" height="60" fill="#ff6633" />`,
    });

    const referenceBuffer = await readFile(referenceBufferPath);
    const server = await startServer((request, response) => {
      if (request.url?.startsWith("/v1/images/mock-file")) {
        if (request.headers["x-figma-token"] !== "test-token") {
          response.statusCode = 401;
          response.end(JSON.stringify({ err: "missing token" }));
          return;
        }

        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            images: {
              "1:2": `${server.baseUrl}/assets/reference.png`,
            },
          }),
        );
        return;
      }

      if (request.url === "/assets/reference.png") {
        response.setHeader("content-type", "image/png");
        response.end(referenceBuffer);
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    });

    const previousEnv = snapshotFigmaEnv();
    process.env.FIGMA_TOKEN = "test-token";
    process.env.FIGMA_API_BASE_URL = server.baseUrl;
    process.env.PEYE_FIGMA_SOURCE = "rest";

    try {
      const result = await runCompare(
        await buildOptions({
          preview: previewPath,
          reference: "https://www.figma.com/design/mock-file/Mock?node-id=1-2",
          output: path.join(dir, "out"),
        }),
      );

      expect(result.report.summary.recommendation).toBe("pass");
      expect(result.exitCode).toBe(0);
      expect(result.report.inputs.reference.kind).toBe("figma-url");
      expect(result.report.inputs.reference.transport).toBe("figma-rest");
      expect(result.report.images).toEqual({
        preview: { width: 90, height: 60 },
        reference: { width: 90, height: 60 },
        canvas: { width: 90, height: 60 },
      });
    } finally {
      restoreEnv(previousEnv);
      await server.close();
    }
  });

  test("writes a failure report when the figma export has no downloadable image", async () => {
    const dir = await createTempDir("peye-figma-missing-image");
    const previewPath = path.join(dir, "preview.png");

    await createPngFromSvg({
      outputPath: previewPath,
      width: 90,
      height: 60,
      body: `<rect x="0" y="0" width="90" height="60" fill="#ff6633" />`,
    });

    const server = await startServer((request, response) => {
      if (request.url?.startsWith("/v1/images/mock-file")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ images: {} }));
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    });

    const previousEnv = snapshotFigmaEnv();
    process.env.FIGMA_TOKEN = "test-token";
    process.env.FIGMA_API_BASE_URL = server.baseUrl;
    process.env.PEYE_FIGMA_SOURCE = "rest";

    try {
      const result = await runCompare(
        await buildOptions({
          preview: previewPath,
          reference: "https://www.figma.com/design/mock-file/Mock?node-id=1-2",
          output: path.join(dir, "out"),
        }),
      );
      const report = await readReport(result.report.artifacts.report);

      expect(result.exitCode).toBe(3);
      expect(result.report.summary.recommendation).toBe("needs_human_review");
      expect(result.report.analysisMode).toBe("visual-clusters");
      expect(report.error).toEqual({
        code: "figma_image_missing",
        message: "Figma did not return an image URL for node 1:2.",
        exitCode: 3,
      });
      expect(report.images).toEqual({
        preview: { width: 90, height: 60 },
        reference: null,
        canvas: null,
      });
      expect(report.artifacts.preview).toBe(result.report.artifacts.preview);
      expect(report.artifacts.reference).toBeNull();
      expect(report.artifacts.overlay).toBeNull();
      expect(report.artifacts.diff).toBeNull();
      expect(report.artifacts.heatmap).toBeNull();
    } finally {
      restoreEnv(previousEnv);
      await server.close();
    }
  });

  test("prefers desktop MCP for figma references without FIGMA_TOKEN", async () => {
    const dir = await createTempDir("peye-figma-mcp-desktop");
    const previewPath = path.join(dir, "preview.png");
    const referenceBufferPath = path.join(dir, "mock-reference.png");
    let remoteCalls = 0;

    await createPngFromSvg({
      outputPath: previewPath,
      width: 90,
      height: 60,
      body: `<rect x="0" y="0" width="90" height="60" fill="#ff6633" />`,
    });

    await createPngFromSvg({
      outputPath: referenceBufferPath,
      width: 90,
      height: 60,
      body: `<rect x="0" y="0" width="90" height="60" fill="#ff6633" />`,
    });

    const referenceBuffer = await readFile(referenceBufferPath);
    const desktopServer = await startMockFigmaMcpServer({
      responseFactory: () => ({
        content: [
          {
            type: "image",
            data: referenceBuffer.toString("base64"),
            mimeType: "image/png",
          },
        ],
      }),
    });
    const remoteServer = await startServer((request, response) => {
      if (request.url === "/mcp") {
        remoteCalls += 1;
      }

      response.statusCode = 500;
      response.end("remote should not be called");
    });
    const previousEnv = snapshotFigmaEnv();

    delete process.env.FIGMA_TOKEN;
    process.env.PEYE_FIGMA_SOURCE = "auto";
    process.env.PEYE_FIGMA_MCP_DESKTOP_URL = `${desktopServer.baseUrl}/mcp`;
    process.env.PEYE_FIGMA_MCP_REMOTE_URL = `${remoteServer.baseUrl}/mcp`;

    try {
      const result = await runCompare(
        await buildOptions({
          preview: previewPath,
          reference: "https://www.figma.com/design/mock-file/Mock?node-id=1-2",
          output: path.join(dir, "out"),
        }),
      );

      expect(result.report.summary.recommendation).toBe("pass");
      expect(result.report.inputs.reference.transport).toBe("figma-mcp-desktop");
      expect(remoteCalls).toBe(0);
    } finally {
      restoreEnv(previousEnv);
      await desktopServer.close();
      await remoteServer.close();
    }
  });

  test("upscales downscaled MCP screenshots to the Figma node size when metadata is available", async () => {
    const dir = await createTempDir("peye-figma-mcp-upscale");
    const previewPath = path.join(dir, "preview.png");
    const referenceBufferPath = path.join(dir, "reference-full.png");
    const screenshotBufferPath = path.join(dir, "reference-downscaled.png");
    const previousEnv = snapshotFigmaEnv();

    await createPngFromSvg({
      outputPath: previewPath,
      width: 1920,
      height: 1748,
      body: `<rect x="0" y="0" width="1920" height="1748" fill="#ff6633" />`,
    });

    await createPngFromSvg({
      outputPath: referenceBufferPath,
      width: 1920,
      height: 1748,
      body: `<rect x="0" y="0" width="1920" height="1748" fill="#ff6633" />`,
    });

    await sharp(referenceBufferPath)
      .resize(1024, 933, { fit: "fill" })
      .png()
      .toFile(screenshotBufferPath);

    const screenshotBuffer = await readFile(screenshotBufferPath);
    const desktopServer = await startMockFigmaMcpServer({
      responseFactory: () => ({
        content: [
          {
            type: "image",
            data: screenshotBuffer.toString("base64"),
            mimeType: "image/png",
          },
        ],
      }),
      metadataResponseFactory: () => ({
        content: [
          {
            type: "text",
            text: '<frame id="5618:8725" name="Features" width="1920" height="1748"></frame>',
          },
        ],
      }),
    });

    delete process.env.FIGMA_TOKEN;
    process.env.PEYE_FIGMA_SOURCE = "mcp";
    process.env.PEYE_FIGMA_MCP_DESKTOP_URL = `${desktopServer.baseUrl}/mcp`;
    delete process.env.PEYE_FIGMA_MCP_REMOTE_URL;
    delete process.env.FIGMA_API_BASE_URL;

    try {
      const result = await runCompare(
        await buildOptions({
          preview: previewPath,
          reference: "https://www.figma.com/design/mock-file/Mock?node-id=5618-8725",
          output: path.join(dir, "out"),
        }),
      );

      expect(result.report.summary.recommendation).toBe("pass");
      expect(result.report.inputs.reference.transport).toBe("figma-mcp-desktop");
      expect(result.report.images.reference).toEqual({
        width: 1920,
        height: 1748,
      });
      expect(result.report.images.canvas).toEqual({
        width: 1920,
        height: 1748,
      });
    } finally {
      restoreEnv(previousEnv);
      await desktopServer.close();
    }
  });

  test("falls back from desktop MCP to remote MCP before REST", async () => {
    const dir = await createTempDir("peye-figma-mcp-remote");
    const previewPath = path.join(dir, "preview.png");
    const referenceBufferPath = path.join(dir, "mock-reference.png");
    let desktopCalls = 0;
    let remoteCalls = 0;
    let restCalls = 0;

    await createPngFromSvg({
      outputPath: previewPath,
      width: 90,
      height: 60,
      body: `<rect x="0" y="0" width="90" height="60" fill="#ff6633" />`,
    });

    await createPngFromSvg({
      outputPath: referenceBufferPath,
      width: 90,
      height: 60,
      body: `<rect x="0" y="0" width="90" height="60" fill="#ff6633" />`,
    });

    const referenceBuffer = await readFile(referenceBufferPath);
    const desktopServer = await startServer((request, response) => {
      if (request.url === "/mcp") {
        desktopCalls += 1;
      }

      response.statusCode = 503;
      response.end("desktop unavailable");
    });
    const remoteServer = await startMockFigmaMcpServer({
      onScreenshotCall: () => {
        remoteCalls += 1;
      },
      responseFactory: () => ({
        content: [
          {
            type: "image",
            data: referenceBuffer.toString("base64"),
            mimeType: "image/png",
          },
        ],
      }),
    });
    const restServer = await startServer((request, response) => {
      if (request.url?.startsWith("/v1/images/mock-file")) {
        restCalls += 1;
      }

      response.statusCode = 500;
      response.end("rest should not be called");
    });
    const previousEnv = snapshotFigmaEnv();

    process.env.FIGMA_TOKEN = "test-token";
    process.env.FIGMA_API_BASE_URL = restServer.baseUrl;
    process.env.PEYE_FIGMA_SOURCE = "auto";
    process.env.PEYE_FIGMA_MCP_DESKTOP_URL = `${desktopServer.baseUrl}/mcp`;
    process.env.PEYE_FIGMA_MCP_REMOTE_URL = `${remoteServer.baseUrl}/mcp`;

    try {
      const result = await runCompare(
        await buildOptions({
          preview: previewPath,
          reference: "https://www.figma.com/design/mock-file/Mock?node-id=1-2",
          output: path.join(dir, "out"),
        }),
      );

      expect(result.report.summary.recommendation).toBe("pass");
      expect(result.report.inputs.reference.transport).toBe("figma-mcp-remote");
      expect(desktopCalls).toBeGreaterThan(0);
      expect(remoteCalls).toBe(1);
      expect(restCalls).toBe(0);
    } finally {
      restoreEnv(previousEnv);
      await desktopServer.close();
      await remoteServer.close();
      await restServer.close();
    }
  });

  test("falls back to REST when remote MCP requires auth in non-interactive mode", async () => {
    const dir = await createTempDir("peye-figma-mcp-rest-fallback");
    const previewPath = path.join(dir, "preview.png");
    const referenceBufferPath = path.join(dir, "mock-reference.png");
    let restCalls = 0;
    const restoreInteractive = setInteractiveTerminal(false);

    await createPngFromSvg({
      outputPath: previewPath,
      width: 90,
      height: 60,
      body: `<rect x="0" y="0" width="90" height="60" fill="#ff6633" />`,
    });

    await createPngFromSvg({
      outputPath: referenceBufferPath,
      width: 90,
      height: 60,
      body: `<rect x="0" y="0" width="90" height="60" fill="#ff6633" />`,
    });

    const referenceBuffer = await readFile(referenceBufferPath);
    const desktopServer = await startServer((_, response) => {
      response.statusCode = 503;
      response.end("desktop unavailable");
    });
    const remoteServer = await startServer((_, response) => {
      response.statusCode = 401;
      response.setHeader("WWW-Authenticate", 'Bearer realm="Figma"');
      response.end("authorization required");
    });
    const restServer = await startServer((request, response) => {
      if (request.url?.startsWith("/v1/images/mock-file")) {
        restCalls += 1;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            images: {
              "1:2": `${restServer.baseUrl}/assets/reference.png`,
            },
          }),
        );
        return;
      }

      if (request.url === "/assets/reference.png") {
        response.setHeader("content-type", "image/png");
        response.end(referenceBuffer);
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    });
    const previousEnv = snapshotFigmaEnv();

    process.env.FIGMA_TOKEN = "test-token";
    process.env.FIGMA_API_BASE_URL = restServer.baseUrl;
    process.env.PEYE_FIGMA_SOURCE = "auto";
    process.env.PEYE_FIGMA_MCP_DESKTOP_URL = `${desktopServer.baseUrl}/mcp`;
    process.env.PEYE_FIGMA_MCP_REMOTE_URL = `${remoteServer.baseUrl}/mcp`;

    try {
      const result = await runCompare(
        await buildOptions({
          preview: previewPath,
          reference: "https://www.figma.com/design/mock-file/Mock?node-id=1-2",
          output: path.join(dir, "out"),
        }),
      );

      expect(result.report.summary.recommendation).toBe("pass");
      expect(result.report.inputs.reference.transport).toBe("figma-rest");
      expect(restCalls).toBe(1);
    } finally {
      restoreEnv(previousEnv);
      restoreInteractive();
      await desktopServer.close();
      await remoteServer.close();
      await restServer.close();
    }
  });

  test("writes a stable error when MCP returns no image content", async () => {
    const dir = await createTempDir("peye-figma-mcp-invalid");
    const previewPath = path.join(dir, "preview.png");
    const desktopServer = await startMockFigmaMcpServer({
      responseFactory: () => ({
        content: [
          {
            type: "text",
            text: "no image here",
          },
        ],
      }),
    });
    const remoteServer = await startServer((_, response) => {
      response.statusCode = 503;
      response.end("remote unavailable");
    });
    const previousEnv = snapshotFigmaEnv();

    await createPngFromSvg({
      outputPath: previewPath,
      width: 90,
      height: 60,
      body: `<rect x="0" y="0" width="90" height="60" fill="#ff6633" />`,
    });

    process.env.PEYE_FIGMA_SOURCE = "mcp";
    process.env.PEYE_FIGMA_MCP_DESKTOP_URL = `${desktopServer.baseUrl}/mcp`;
    process.env.PEYE_FIGMA_MCP_REMOTE_URL = `${remoteServer.baseUrl}/mcp`;
    delete process.env.FIGMA_TOKEN;
    delete process.env.FIGMA_API_BASE_URL;

    try {
      const result = await runCompare(
        await buildOptions({
          preview: previewPath,
          reference: "https://www.figma.com/design/mock-file/Mock?node-id=1-2",
          output: path.join(dir, "out"),
        }),
      );
      const report = await readReport(result.report.artifacts.report);

      expect(result.exitCode).toBe(3);
      expect(report.error?.code).toBe("figma_mcp_invalid_response");
      expect(report.error?.message).toContain("returned no image content");
      expect(report.error?.exitCode).toBe(3);
      expect(report.summary.recommendation).toBe("needs_human_review");
    } finally {
      restoreEnv(previousEnv);
      await desktopServer.close();
      await remoteServer.close();
    }
  });

  test("writes a failure report for preflight errors before capture starts", async () => {
    const dir = await createTempDir("peye-missing-viewport");
    const referencePath = path.join(dir, "reference.png");

    await createPngFromSvg({
      outputPath: referencePath,
      width: 120,
      height: 80,
      body: `<rect x="10" y="10" width="100" height="60" fill="#0b84ff" />`,
    });

    const result = await runCompare(
      await buildOptions({
        preview: "http://localhost:3000",
        reference: referencePath,
        output: path.join(dir, "out"),
      }),
    );
    const report = await readReport(result.report.artifacts.report);

    expect(result.exitCode).toBe(1);
    expect(report.summary.recommendation).toBe("needs_human_review");
    expect(report.error).toEqual({
      code: "preview_viewport_required",
      message: "Preview URL requires --viewport so the browser screenshot is deterministic.",
      exitCode: 1,
    });
    expect(report.images).toEqual({
      preview: null,
      reference: null,
      canvas: null,
    });
    expect(report.findings).toEqual([]);
    expect(report.artifacts.preview).toBeNull();
    expect(report.artifacts.reference).toBeNull();
    expect(report.artifacts.overlay).toBeNull();
    expect(report.artifacts.diff).toBeNull();
    expect(report.artifacts.heatmap).toBeNull();
  });
});

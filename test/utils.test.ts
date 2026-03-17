import { describe, expect, test } from "vitest";
import { decideRecommendation } from "../src/analysis/recommendation.js";
import { parseReferenceInput } from "../src/io/inputs.js";
import type { FindingReport, MetricsReport } from "../src/types/report.js";
import { parseViewport } from "../src/utils/viewport.js";
import { hashToSelector, parseFigmaUrl } from "../src/utils/url.js";

function createMetrics(
  overrides: Partial<MetricsReport> & Pick<MetricsReport, "mismatchPixels" | "mismatchPercent">,
): MetricsReport {
  return {
    mismatchPixels: overrides.mismatchPixels,
    mismatchPercent: overrides.mismatchPercent,
    meanColorDelta: overrides.meanColorDelta ?? null,
    maxColorDelta: overrides.maxColorDelta ?? null,
    structuralMismatchPercent: overrides.structuralMismatchPercent ?? null,
    dimensionMismatch: overrides.dimensionMismatch ?? {
      widthDelta: 0,
      heightDelta: 0,
      aspectRatioDelta: 0,
      hasMismatch: false,
    },
    findingsCount: overrides.findingsCount ?? 1,
    affectedElementCount: overrides.affectedElementCount ?? 1,
  };
}

function createFinding(
  overrides: Partial<FindingReport> & Pick<FindingReport, "kind" | "severity">,
): FindingReport {
  return {
    id: overrides.id ?? "finding-001",
    source: overrides.source ?? "visual-cluster",
    kind: overrides.kind,
    severity: overrides.severity,
    summary: overrides.summary ?? "Finding summary",
    bbox: overrides.bbox ?? {
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    },
    regionCount: overrides.regionCount ?? 1,
    mismatchPixels: overrides.mismatchPixels ?? 20,
    mismatchPercentOfCanvas: overrides.mismatchPercentOfCanvas ?? 0.2,
    issueTypes: overrides.issueTypes ?? ["style"],
    signals: overrides.signals ?? [],
    hotspots: overrides.hotspots ?? [],
    element: overrides.element ?? null,
  };
}

describe("parseViewport", () => {
  test("parses width and height", () => {
    expect(parseViewport("1920x900")).toEqual({ width: 1920, height: 900 });
  });

  test("parses width only and applies default height", () => {
    expect(parseViewport("1920")).toEqual({ width: 1920, height: 900 });
  });

  test("throws on invalid viewport", () => {
    expect(() => parseViewport("1920x")).toThrow(/Invalid viewport/);
  });
});

describe("hashToSelector", () => {
  test("uses url hash as selector by default", () => {
    expect(hashToSelector("https://example.com/#road-map")).toBe("#road-map");
  });

  test("explicit selector wins over hash", () => {
    expect(hashToSelector("https://example.com/#road-map", ".card")).toBe(".card");
  });
});

describe("parseFigmaUrl", () => {
  test("parses design urls with node id", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/abc123/My-Frame?node-id=1-2")).toEqual({
      fileKey: "abc123",
      nodeId: "1:2",
      resolved: "https://www.figma.com/design/abc123/My-Frame?node-id=1-2",
    });
  });

  test("rejects deceptive non-figma domains", () => {
    expect(() => parseFigmaUrl("https://notfigma.com/design/abc123/My-Frame?node-id=1-2")).toThrow(
      /Reference URL must be a Figma URL/,
    );
  });
});

describe("parseReferenceInput", () => {
  test("returns normalized figma metadata", async () => {
    await expect(
      parseReferenceInput("https://www.figma.com/design/abc123/My-Frame?node-id=1-2"),
    ).resolves.toEqual({
      kind: "figma-url",
      input: "https://www.figma.com/design/abc123/My-Frame?node-id=1-2",
      resolved: "https://www.figma.com/design/abc123/My-Frame?node-id=1-2",
      fileKey: "abc123",
      nodeId: "1:2",
    });
  });
});

describe("decideRecommendation", () => {
  test("returns pass for small mismatch", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 20,
        mismatchPercent: 0.2,
        meanColorDelta: 1,
        maxColorDelta: 2,
        structuralMismatchPercent: 0,
      }),
      findings: [createFinding({ kind: "pixel", severity: "low" })],
    });

    expect(decision.recommendation).toBe("pass");
  });

  test("returns tolerated pass for low severity small drift", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 120,
        mismatchPercent: 1.2,
        meanColorDelta: 4,
        maxColorDelta: 5,
        structuralMismatchPercent: 0,
      }),
      findings: [createFinding({ kind: "color", severity: "low" })],
    });

    expect(decision.recommendation).toBe("pass_with_tolerated_differences");
  });

  test("returns retry fix for localized larger mismatch", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 350,
        mismatchPercent: 3.5,
        meanColorDelta: 10,
        maxColorDelta: 18,
        structuralMismatchPercent: 30,
      }),
      findings: [createFinding({ kind: "layout", severity: "medium" })],
    });

    expect(decision.recommendation).toBe("retry_fix");
  });

  test("returns needs human review for strong dimension mismatch", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 1_000,
        mismatchPercent: 10,
        meanColorDelta: 10,
        maxColorDelta: 18,
        structuralMismatchPercent: 30,
        dimensionMismatch: {
          widthDelta: 120,
          heightDelta: 0,
          aspectRatioDelta: 0.2,
          hasMismatch: true,
        },
        findingsCount: 0,
        affectedElementCount: 0,
      }),
      findings: [],
    });

    expect(decision.recommendation).toBe("needs_human_review");
  });
});

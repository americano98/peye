import { describe, expect, test } from "vitest";
import { decideRecommendation } from "../src/analysis/recommendation.js";
import { buildSummaryReport } from "../src/analysis/summary.js";
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
    ignoredPixels: overrides.ignoredPixels ?? 0,
    ignoredPercent: overrides.ignoredPercent ?? 0,
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
    code: overrides.code ?? "rendering_mismatch",
    severity: overrides.severity,
    confidence: overrides.confidence ?? 0.5,
    summary: overrides.summary ?? "Finding summary",
    fixHint: overrides.fixHint ?? "Fix hint",
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
    likelyAffectedProperties: overrides.likelyAffectedProperties ?? ["style.typography"],
    signals: overrides.signals ?? [],
    evidenceRefs: overrides.evidenceRefs ?? [],
    hotspots: overrides.hotspots ?? [],
    actionTarget: overrides.actionTarget ?? null,
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

describe("buildSummaryReport", () => {
  test("derives an autofixable text overflow action from DOM findings", () => {
    const summary = buildSummaryReport({
      baseDecision: {
        recommendation: "retry_fix",
        severity: "medium",
        reason: "Localized issues were detected.",
      },
      findings: [
        createFinding({
          kind: "pixel",
          severity: "medium",
          code: "text_clipping",
          confidence: 0.8,
          signals: [
            {
              code: "probable_text_clipping",
              confidence: "medium",
              message: "Text is clipped.",
            },
          ],
          actionTarget: {
            selector: "section#hero > button#cta",
            tag: "button",
            role: null,
            textSnippet: "Buy",
          },
        }),
      ],
      analysisMode: "dom-elements",
      omittedFindings: 0,
      error: null,
    });

    expect(summary.rootCauseCandidates[0]?.code).toBe("text_overflow");
    expect(summary.topActions[0]?.code).toBe("fix_text_overflow");
    expect(summary.topActions[0]?.findingIds).toEqual(["finding-001"]);
    expect(summary.safeToAutofix).toBe(true);
    expect(summary.requiresRecapture).toBe(false);
    expect(summary.overallConfidence).toBe(0.8);
  });

  test("keeps root causes and actions in stable order when mixed findings map to multiple causes", () => {
    const summary = buildSummaryReport({
      baseDecision: {
        recommendation: "retry_fix",
        severity: "high",
        reason: "Mixed layout and style issues were detected.",
      },
      findings: [
        createFinding({
          id: "finding-001",
          kind: "mixed",
          severity: "high",
          code: "layout_style_mismatch",
          confidence: 0.77,
        }),
        createFinding({
          id: "finding-002",
          kind: "color",
          severity: "medium",
          code: "style_mismatch",
          confidence: 0.77,
        }),
      ],
      analysisMode: "dom-elements",
      omittedFindings: 0,
      error: null,
    });

    expect(summary.rootCauseCandidates.map((candidate) => candidate.code)).toEqual([
      "layout_displacement",
      "visual_style_drift",
    ]);
    expect(summary.topActions.map((action) => action.code)).toEqual([
      "fix_layout_styles",
      "fix_visual_styles",
    ]);
    expect(summary.topActions[1]?.findingIds).toEqual(["finding-001", "finding-002"]);
  });

  test("keeps signal-derived root causes even when finding code comes from another signal or kind", () => {
    const summary = buildSummaryReport({
      baseDecision: {
        recommendation: "retry_fix",
        severity: "high",
        reason: "Setup or rendering issues were detected.",
      },
      findings: [
        createFinding({
          kind: "mixed",
          severity: "high",
          code: "text_clipping",
          confidence: 0.9,
          signals: [
            {
              code: "probable_text_clipping",
              confidence: "high",
              message: "Text is clipped.",
            },
            {
              code: "possible_capture_crop",
              confidence: "high",
              message: "Capture appears cropped.",
            },
          ],
          actionTarget: {
            selector: "section#hero > button#cta",
            tag: "button",
            role: null,
            textSnippet: "Buy",
          },
        }),
      ],
      analysisMode: "dom-elements",
      omittedFindings: 0,
      error: null,
    });

    expect(summary.rootCauseCandidates.map((candidate) => candidate.code)).toEqual([
      "capture_scope_too_tight",
      "text_overflow",
    ]);
    expect(summary.topActions.map((action) => action.code)).toEqual([
      "fix_text_overflow",
      "recapture_with_broader_scope",
    ]);
    expect(summary.safeToAutofix).toBe(false);
    expect(summary.requiresRecapture).toBe(true);
  });

  test("marks reference acquisition failures as requiring recapture/setup fixes", () => {
    const summary = buildSummaryReport({
      baseDecision: {
        recommendation: "needs_human_review",
        severity: "high",
        reason: "Figma did not return an image URL.",
      },
      findings: [],
      analysisMode: "visual-clusters",
      omittedFindings: 0,
      error: {
        code: "figma_image_missing",
        message: "Figma did not return an image URL.",
        exitCode: 3,
      },
      failureOrigin: "reference",
    });

    expect(summary.rootCauseCandidates[0]?.code).toBe("reference_input_or_acquisition_error");
    expect(summary.topActions[0]?.code).toBe("fix_reference_setup");
    expect(summary.safeToAutofix).toBe(false);
    expect(summary.requiresRecapture).toBe(true);
    expect(summary.overallConfidence).toBe(0.95);
  });

  test("reduces overall confidence for visual-cluster findings when findings are omitted", () => {
    const summary = buildSummaryReport({
      baseDecision: {
        recommendation: "retry_fix",
        severity: "medium",
        reason: "Clustered issues were detected.",
      },
      findings: [
        createFinding({
          kind: "pixel",
          severity: "medium",
          code: "rendering_mismatch",
          confidence: 0.6,
        }),
      ],
      analysisMode: "visual-clusters",
      omittedFindings: 4,
      error: null,
    });

    expect(summary.topActions[0]?.code).toBe("fix_visual_styles");
    expect(summary.overallConfidence).toBe(0.45);
  });
});

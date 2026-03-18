import { describe, expect, test } from "vitest";
import { decideRecommendation } from "../src/analysis/recommendation.js";
import { buildSummaryReport } from "../src/analysis/summary.js";
import { parseReferenceInput } from "../src/io/inputs.js";
import type { RecommendationDecision } from "../src/types/internal.js";
import type { DecisionTraceReport, FindingReport, MetricsReport } from "../src/types/report.js";
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

function createDecisionTrace(
  overrides: Partial<DecisionTraceReport> &
    Pick<DecisionTraceReport, "axis" | "code" | "outcome" | "strength">,
): DecisionTraceReport {
  return {
    axis: overrides.axis,
    code: overrides.code,
    outcome: overrides.outcome,
    strength: overrides.strength,
    reason: overrides.reason ?? "Decision trace reason",
    findingIds: overrides.findingIds ?? [],
    signalCodes: overrides.signalCodes ?? [],
    metricKeys: overrides.metricKeys ?? [],
  };
}

function createDecision(
  overrides: Partial<RecommendationDecision> &
    Pick<RecommendationDecision, "recommendation" | "severity" | "reason">,
): RecommendationDecision {
  return {
    recommendation: overrides.recommendation,
    severity: overrides.severity,
    reason: overrides.reason,
    decisionTrace: overrides.decisionTrace ?? [
      createDecisionTrace({
        axis: "final",
        code:
          overrides.recommendation === "pass"
            ? "final_pass"
            : overrides.recommendation === "pass_with_tolerated_differences"
              ? "final_pass_with_tolerated_differences"
              : overrides.recommendation === "retry_fix"
                ? "final_retry_fix"
                : "final_needs_human_review",
        outcome: overrides.recommendation,
        strength:
          overrides.severity === "critical"
            ? "critical"
            : overrides.severity === "high"
              ? "high"
              : overrides.severity === "medium"
                ? "medium"
                : "low",
        reason: overrides.reason,
      }),
    ],
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
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "pixel_strict_pass",
      "final_pass",
    ]);
    expect(decision.reason).toBe(decision.decisionTrace.at(-1)?.reason);
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
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "pixel_tolerated_pass",
      "final_pass_with_tolerated_differences",
    ]);
  });

  test("returns retry fix for localized larger mismatch", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 350,
        mismatchPercent: 3.5,
        meanColorDelta: 10,
        maxColorDelta: 18,
        structuralMismatchPercent: 12,
      }),
      findings: [createFinding({ kind: "layout", severity: "medium" })],
    });

    expect(decision.recommendation).toBe("retry_fix");
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "layout_localized_drift",
      "pixel_retry_range",
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
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
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "dimension_strong_mismatch",
      "final_needs_human_review",
    ]);
  });

  test("upgrades text clipping from low pixel drift to retry_fix", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 24,
        mismatchPercent: 0.24,
        meanColorDelta: 1,
        maxColorDelta: 2,
        structuralMismatchPercent: 0,
      }),
      findings: [
        createFinding({
          kind: "pixel",
          severity: "medium",
          code: "text_clipping",
          signals: [
            {
              code: "probable_text_clipping",
              confidence: "medium",
              message: "Text is clipped.",
            },
          ],
          actionTarget: {
            selector: "#cta",
            tag: "button",
            role: null,
            textSnippet: "Buy",
          },
        }),
      ],
    });

    expect(decision.recommendation).toBe("retry_fix");
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "pixel_strict_pass",
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
  });

  test("treats capture signals as a human review override even inside retry range", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 250,
        mismatchPercent: 2.5,
        meanColorDelta: 9,
        maxColorDelta: 16,
        structuralMismatchPercent: 8,
      }),
      findings: [
        createFinding({
          kind: "layout",
          severity: "medium",
          signals: [
            {
              code: "possible_capture_crop",
              confidence: "high",
              message: "Capture appears cropped.",
            },
          ],
          actionTarget: {
            selector: "#hero",
            tag: "section",
            role: null,
            textSnippet: null,
          },
        }),
      ],
    });

    expect(decision.recommendation).toBe("needs_human_review");
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "setup_capture_signal_risk",
      "layout_localized_drift",
      "pixel_retry_range",
      "fixability_localized_actionable",
      "final_needs_human_review",
    ]);
  });

  test("treats high ignored area as low-confidence human review", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 180,
        mismatchPercent: 1.8,
        ignoredPercent: 12,
        meanColorDelta: 3,
        maxColorDelta: 5,
        structuralMismatchPercent: 0,
      }),
      findings: [createFinding({ kind: "pixel", severity: "low" })],
    });

    expect(decision.recommendation).toBe("needs_human_review");
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "setup_ignored_area_risk",
      "pixel_retry_range",
      "fixability_localized_actionable",
      "final_needs_human_review",
    ]);
  });

  test("keeps localized color mismatch in retry_fix rather than human review", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 400,
        mismatchPercent: 4,
        meanColorDelta: 12,
        maxColorDelta: 24,
        structuralMismatchPercent: 0,
      }),
      findings: [createFinding({ kind: "color", severity: "medium" })],
    });

    expect(decision.recommendation).toBe("retry_fix");
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "color_localized_drift",
      "pixel_retry_range",
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
  });

  test("emits traces in axis order and keeps final reason aligned", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 400,
        mismatchPercent: 4,
        meanColorDelta: 12,
        maxColorDelta: 24,
        structuralMismatchPercent: 0,
      }),
      findings: [createFinding({ kind: "color", severity: "medium" })],
    });

    expect(decision.decisionTrace.map((trace) => trace.axis)).toEqual([
      "color",
      "pixel",
      "fixability",
      "final",
    ]);
    expect(decision.reason).toBe(decision.decisionTrace.at(-1)?.reason);
  });
});

describe("buildSummaryReport", () => {
  test("derives an autofixable text overflow action from DOM findings", () => {
    const summary = buildSummaryReport({
      baseDecision: createDecision({
        recommendation: "retry_fix",
        severity: "medium",
        reason: "Localized issues were detected.",
        decisionTrace: [
          createDecisionTrace({
            axis: "fixability",
            code: "fixability_localized_actionable",
            outcome: "retry_fix",
            strength: "high",
            reason: "Top findings are concentrated and actionable.",
            findingIds: ["finding-001"],
          }),
          createDecisionTrace({
            axis: "final",
            code: "final_retry_fix",
            outcome: "retry_fix",
            strength: "high",
            reason: "Localized issues were detected.",
            findingIds: ["finding-001"],
          }),
        ],
      }),
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
    expect(summary.decisionTrace.map((trace) => trace.code)).toEqual([
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
    expect(summary.overallConfidence).toBe(0.85);
  });

  test("keeps root causes and actions in stable order when mixed findings map to multiple causes", () => {
    const summary = buildSummaryReport({
      baseDecision: createDecision({
        recommendation: "retry_fix",
        severity: "high",
        reason: "Mixed layout and style issues were detected.",
      }),
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
      baseDecision: createDecision({
        recommendation: "needs_human_review",
        severity: "high",
        reason: "Setup or rendering issues were detected.",
        decisionTrace: [
          createDecisionTrace({
            axis: "setup_capture_risk",
            code: "setup_capture_signal_risk",
            outcome: "needs_human_review",
            strength: "high",
            reason: "Capture appears cropped.",
            findingIds: ["finding-001"],
            signalCodes: ["possible_capture_crop"],
          }),
          createDecisionTrace({
            axis: "final",
            code: "final_needs_human_review",
            outcome: "needs_human_review",
            strength: "high",
            reason: "Setup or rendering issues were detected.",
            findingIds: ["finding-001"],
            signalCodes: ["possible_capture_crop"],
          }),
        ],
      }),
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
      "recapture_with_broader_scope",
      "fix_text_overflow",
    ]);
    expect(summary.safeToAutofix).toBe(false);
    expect(summary.requiresRecapture).toBe(true);
  });

  test("marks reference acquisition failures as requiring recapture/setup fixes", () => {
    const summary = buildSummaryReport({
      baseDecision: createDecision({
        recommendation: "needs_human_review",
        severity: "high",
        reason: "Figma did not return an image URL.",
      }),
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
    expect(summary.decisionTrace.at(-1)?.code).toBe("final_needs_human_review");
    expect(summary.overallConfidence).toBe(0.85);
  });

  test("reduces overall confidence for visual-cluster findings when findings are omitted", () => {
    const summary = buildSummaryReport({
      baseDecision: createDecision({
        recommendation: "retry_fix",
        severity: "medium",
        reason: "Clustered issues were detected.",
        decisionTrace: [
          createDecisionTrace({
            axis: "fixability",
            code: "fixability_localized_actionable",
            outcome: "retry_fix",
            strength: "high",
            reason: "Top findings are concentrated and actionable.",
            findingIds: ["finding-001"],
          }),
          createDecisionTrace({
            axis: "final",
            code: "final_retry_fix",
            outcome: "retry_fix",
            strength: "high",
            reason: "Clustered issues were detected.",
            findingIds: ["finding-001"],
          }),
        ],
      }),
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
    expect(summary.overallConfidence).toBe(0.7);
  });

  test("keeps global layout drift in human review without forcing recapture", () => {
    const summary = buildSummaryReport({
      baseDecision: createDecision({
        recommendation: "needs_human_review",
        severity: "high",
        reason: "Layout drift appears global rather than localized.",
        decisionTrace: [
          createDecisionTrace({
            axis: "layout",
            code: "layout_global_drift",
            outcome: "needs_human_review",
            strength: "high",
            reason: "Layout drift appears global rather than localized.",
            findingIds: ["finding-001"],
          }),
          createDecisionTrace({
            axis: "final",
            code: "final_needs_human_review",
            outcome: "needs_human_review",
            strength: "high",
            reason: "Layout drift appears global rather than localized.",
            findingIds: ["finding-001"],
          }),
        ],
      }),
      findings: [createFinding({ kind: "layout", severity: "high" })],
      analysisMode: "visual-clusters",
      omittedFindings: 0,
      error: null,
    });

    expect(summary.requiresRecapture).toBe(false);
    expect(summary.rootCauseCandidates[0]?.code).toBe("layout_displacement");
    expect(summary.decisionTrace.map((trace) => trace.code)).toEqual([
      "layout_global_drift",
      "final_needs_human_review",
    ]);
  });
});

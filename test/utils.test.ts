import { buildGeometryDrift } from "../src/analysis/geometry.js";
import { buildFindingsAnalysis } from "../src/analysis/findings.js";
import { buildMarkdownTextReport } from "../src/analysis/text-report.js";
import { buildTextValidation } from "../src/analysis/text-validation.js";
import { buildSiblingRelationsIndex } from "../src/analysis/relations.js";
import { describe, expect, test } from "vitest";
import { decideRecommendation } from "../src/analysis/recommendation.js";
import { buildSummaryReport } from "../src/analysis/summary.js";
import type { GroupLocalization, GroupNode } from "../src/correspond/types.js";
import { parseReferenceInput } from "../src/io/inputs.js";
import type {
  ComparisonRegion,
  DomSnapshot,
  RecommendationDecision,
} from "../src/types/internal.js";
import type {
  DecisionTraceReport,
  FindingReport,
  FindingSignalReport,
  MetricsReport,
  RootCauseGroupId,
} from "../src/types/report.js";
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
  overrides: Omit<Partial<FindingReport>, "element" | "context"> & {
    element?: Partial<NonNullable<FindingReport["element"]>> | null;
    context?: FindingReport["context"];
  } & Pick<FindingReport, "kind" | "severity">,
): FindingReport {
  const code = overrides.code ?? "rendering_mismatch";
  const signals = overrides.signals ?? [];
  const element: NonNullable<FindingReport["element"]> | undefined =
    overrides.element === undefined || overrides.element === null
      ? undefined
      : {
          tag: overrides.element.tag ?? "button",
          selector: overrides.element.selector ?? "#target",
        };

  if (element) {
    if (overrides.element?.role !== undefined && overrides.element.role !== null) {
      element.role = overrides.element.role;
    }

    if (overrides.element?.testId !== undefined && overrides.element.testId !== null) {
      element.testId = overrides.element.testId;
    }

    if (overrides.element?.textSnippet !== undefined && overrides.element.textSnippet !== null) {
      element.textSnippet = overrides.element.textSnippet;
    }
  }

  return {
    id: overrides.id ?? "finding-test-001",
    rootCauseGroupId:
      overrides.rootCauseGroupId ?? rootCauseGroupIdForTestFinding(code, signals, element),
    source: overrides.source ?? "visual-cluster",
    kind: overrides.kind,
    code,
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
    signals,
    ...(element ? { element } : {}),
    ...(overrides.context ? { context: overrides.context } : {}),
    ...(overrides.granularity ? { granularity: overrides.granularity } : {}),
    ...(overrides.matchedReferenceBBox
      ? { matchedReferenceBBox: overrides.matchedReferenceBBox }
      : {}),
    ...(overrides.correspondenceMethod
      ? { correspondenceMethod: overrides.correspondenceMethod }
      : {}),
    ...(overrides.correspondenceConfidence !== undefined
      ? { correspondenceConfidence: overrides.correspondenceConfidence }
      : {}),
    ...(overrides.ambiguity !== undefined ? { ambiguity: overrides.ambiguity } : {}),
    ...(overrides.delta ? { delta: overrides.delta } : {}),
    ...(overrides.geometry ? { geometry: overrides.geometry } : {}),
    ...(overrides.siblingRelation ? { siblingRelation: overrides.siblingRelation } : {}),
    ...(overrides.textValidation ? { textValidation: overrides.textValidation } : {}),
  };
}

function rootCauseGroupIdForTestFinding(
  code: FindingReport["code"],
  signals: FindingSignalReport[],
  element: FindingReport["element"] | undefined,
): RootCauseGroupId {
  const signalCodes = new Set(signals.map((signal) => signal.code));

  if (code === "text_clipping" || signalCodes.has("probable_text_clipping")) {
    return "text-wrap-regression";
  }

  if (
    code === "capture_crop" ||
    code === "viewport_mismatch" ||
    signalCodes.has("possible_capture_crop") ||
    signalCodes.has("possible_viewport_mismatch")
  ) {
    return "viewport-crop-risk";
  }

  if (code === "missing_or_extra_content" && element) {
    return "container-size-mismatch";
  }

  if (code === "missing_or_extra_content") {
    return "content-presence-mismatch";
  }

  if (code === "layout_mismatch" || code === "layout_style_mismatch") {
    return "layout-displacement";
  }

  if (code === "style_mismatch") {
    return "visual-style-drift";
  }

  return "rendering-drift";
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

  test("treats strong text overflow findings as localized actionable text evidence", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 320,
        mismatchPercent: 3.2,
        meanColorDelta: 4,
        maxColorDelta: 6,
        structuralMismatchPercent: 2,
      }),
      findings: [
        createFinding({
          kind: "pixel",
          severity: "medium",
          code: "text_clipping",
          element: {
            selector: "section#hero > h2.title",
            tag: "h2",
            textSnippet: "Built for practical LLM training",
          },
          textValidation: {
            status: "matched",
            diagnosisKind: "text_overflow",
            confidence: 0.9,
            observations: ["Preview text overflows vertically.", "Preview text spans 2 line(s)."],
            allowsDirectionalClaim: true,
          },
          signals: [
            {
              code: "probable_text_clipping",
              confidence: "high",
              message: "Text content likely overflows the element bounds.",
            },
          ],
        }),
        createFinding({
          kind: "mixed",
          severity: "medium",
          code: "layout_style_mismatch",
          element: {
            selector: "section#hero > header",
            tag: "header",
          },
        }),
      ],
    });

    expect(decision.recommendation).toBe("retry_fix");
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "layout_localized_drift",
      "pixel_retry_range",
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
    expect(decision.reason).toContain("text blocks");
  });

  test("reduces setup-signal dominance when multiple strong text findings are localized", () => {
    const findings = [
      createFinding({
        id: "finding-text-a",
        kind: "pixel",
        severity: "medium",
        code: "text_clipping",
        element: {
          selector: "section#hero > h2.title",
          tag: "h2",
          textSnippet: "Built for practical LLM training",
        },
        textValidation: {
          status: "matched",
          diagnosisKind: "text_overflow",
          confidence: 0.9,
          observations: ["Preview text overflows vertically."],
          allowsDirectionalClaim: true,
        },
        signals: [
          {
            code: "probable_text_clipping",
            confidence: "high",
            message: "Text content likely overflows the element bounds.",
          },
        ],
      }),
      createFinding({
        id: "finding-text-b",
        kind: "color",
        severity: "medium",
        code: "style_mismatch",
        element: {
          selector: "section#hero > p.body",
          tag: "p",
          textSnippet: "Accelerate LLM training while maximizing GPU efficiency.",
        },
        textValidation: {
          status: "matched",
          diagnosisKind: "text_style_drift",
          confidence: 0.84,
          observations: [
            "Matched text block shape is broadly consistent, but typography may differ.",
          ],
          allowsDirectionalClaim: false,
        },
      }),
      createFinding({
        id: "finding-viewport",
        kind: "dimension",
        severity: "medium",
        code: "viewport_mismatch",
        source: "visual-cluster",
        signals: [
          {
            code: "possible_viewport_mismatch",
            confidence: "high",
            message: "Viewport mismatch detected.",
          },
        ],
        element: null,
      }),
    ];
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 340,
        mismatchPercent: 3.4,
        meanColorDelta: 5,
        maxColorDelta: 7,
        structuralMismatchPercent: 1,
      }),
      findings,
    });
    const summary = buildSummaryReport({
      baseDecision: decision,
      findings,
      fullFindings: findings,
      analysisMode: "dom-elements",
      omittedFindings: 0,
      error: null,
      correspondenceSummary: null,
    });

    expect(decision.reason).not.toContain("sanity check");
    expect(summary.agentChecks).toEqual([]);
    expect(summary.topActions[0]?.code).toBe("fix_text_overflow");
  });

  test("treats strong geometry drift as localized layout evidence even when structural mismatch is low", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 320,
        mismatchPercent: 3.2,
        meanColorDelta: 3,
        maxColorDelta: 4,
        structuralMismatchPercent: 0,
      }),
      findings: [
        createFinding({
          kind: "color",
          severity: "medium",
          code: "style_mismatch",
          element: {
            selector: "#cta",
            tag: "button",
          },
          geometry: {
            centerShiftPx: 18,
            normalizedCenterShift: 0.22,
            widthDeltaPx: 12,
            heightDeltaPx: 0,
            widthDeltaRatio: 0.18,
            heightDeltaRatio: 0,
            areaDeltaRatio: 0.18,
            aspectRatioDelta: 0.14,
            dominantDrift: "mixed",
            positionShiftLevel: "large",
            sizeShiftLevel: "large",
          },
        }),
      ],
    });

    expect(decision.recommendation).toBe("retry_fix");
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "layout_localized_drift",
      "pixel_retry_range",
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
    expect(decision.decisionTrace[0]?.reason).toContain("Position or size drift");
  });

  test("treats sibling spacing drift as localized layout evidence", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 360,
        mismatchPercent: 3.6,
        meanColorDelta: 2,
        maxColorDelta: 3,
        structuralMismatchPercent: 0,
      }),
      findings: [
        createFinding({
          kind: "pixel",
          severity: "medium",
          code: "rendering_mismatch",
          element: {
            selector: "#feature-a",
            tag: "div",
          },
          siblingRelation: {
            siblingSelector: "#feature-b",
            axis: "horizontal",
            previewGapPx: 24,
            referenceGapPx: 42,
            gapDeltaPx: 18,
            normalizedGapDelta: 0.3,
            crossAxisOffsetDeltaPx: 2,
            spacingDriftLevel: "medium",
            alignmentDriftLevel: "small",
            dominantDrift: "spacing",
            relativeOrderPreserved: true,
          },
        }),
      ],
    });

    expect(decision.recommendation).toBe("retry_fix");
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "layout_localized_drift",
      "pixel_retry_range",
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
    expect(decision.decisionTrace[0]?.reason).toContain("Spacing or alignment drift");
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
    expect(decision.reason).toBe(
      "Reference and preview dimensions diverge too much for a reliable automated verdict.",
    );
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
          element: {
            selector: "#cta",
            tag: "button",
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

  test("routes capture signals through retry_fix with an agent-side sanity check", () => {
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
          element: {
            selector: "#hero",
            tag: "section",
          },
        }),
      ],
    });

    expect(decision.recommendation).toBe("retry_fix");
    expect(decision.reason).toBe(
      "Run a sanity check to confirm the preview and reference depict the same target before fixing; capture crop was detected.",
    );
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "setup_capture_signal_risk",
      "layout_localized_drift",
      "pixel_retry_range",
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
  });

  test("keeps medium ignored area in retry_fix when findings remain actionable", () => {
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

    expect(decision.recommendation).toBe("retry_fix");
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "pixel_retry_range",
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
  });

  test("keeps high-but-not-extreme ignored area in retry_fix", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 180,
        mismatchPercent: 1.8,
        ignoredPercent: 20,
        meanColorDelta: 3,
        maxColorDelta: 5,
        structuralMismatchPercent: 0,
      }),
      findings: [createFinding({ kind: "pixel", severity: "low" })],
    });

    expect(decision.recommendation).toBe("retry_fix");
    expect(decision.decisionTrace.map((trace) => trace.code)).toEqual([
      "pixel_retry_range",
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
  });

  test("still treats extremely high ignored area as human review", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 180,
        mismatchPercent: 1.8,
        ignoredPercent: 35,
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

  test("keeps broad layout drift in retry_fix when no hard-stop setup risk exists", () => {
    const decision = decideRecommendation({
      thresholds: { pass: 0.5, tolerated: 1.5, retry: 5 },
      metrics: createMetrics({
        mismatchPixels: 450,
        mismatchPercent: 4.5,
        meanColorDelta: 6,
        maxColorDelta: 10,
        structuralMismatchPercent: 30,
      }),
      findings: [
        createFinding({ kind: "layout", severity: "high", mismatchPixels: 120 }),
        createFinding({ kind: "layout", severity: "high", mismatchPixels: 110 }),
        createFinding({ kind: "layout", severity: "medium", mismatchPixels: 100 }),
        createFinding({ kind: "layout", severity: "medium", mismatchPixels: 90 }),
      ],
    });

    expect(decision.recommendation).toBe("retry_fix");
    expect(decision.decisionTrace).toContainEqual(
      expect.objectContaining({
        code: "layout_global_drift",
        outcome: "retry_fix",
      }),
    );
    expect(decision.decisionTrace).toContainEqual(
      expect.objectContaining({
        code: "pixel_retry_range",
        outcome: "retry_fix",
      }),
    );
    expect(decision.decisionTrace.at(-1)?.code).toBe("final_retry_fix");
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

function createRegion(
  overrides: Partial<ComparisonRegion> & Pick<ComparisonRegion, "x" | "y" | "width" | "height">,
): ComparisonRegion {
  return {
    x: overrides.x,
    y: overrides.y,
    width: overrides.width,
    height: overrides.height,
    pixelCount: overrides.pixelCount ?? overrides.width * overrides.height,
    mismatchPercent: overrides.mismatchPercent ?? 100,
    kind: overrides.kind ?? "pixel",
    severity: overrides.severity ?? "low",
  };
}

function createDomSnapshotForTest(
  elementOverrides: Partial<DomSnapshot["elements"][number]> = {},
): DomSnapshot {
  const root = {
    id: "root",
    tag: "main",
    selector: "#root",
    role: null,
    testId: null,
    domId: "root",
    classSummary: ["hero-root"],
    textSnippet: null,
    bbox: {
      x: 0,
      y: 0,
      width: 100,
      height: 60,
    },
    depth: 0,
    captureClippedEdges: [],
    textMetrics: null,
    ancestry: [],
    locator: {
      tag: "main",
      selector: "#root",
      role: null,
      testId: null,
      domId: "root",
      classSummary: ["hero-root"],
    },
    identity: {
      domId: "root",
      classSummary: ["hero-root"],
      testId: null,
      semanticTag: "main",
      candidateKind: "anchor" as const,
    },
    computedStyle: {
      fontSize: "16px",
      lineHeight: "24px",
      fontWeight: "400",
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderRadius: "0px",
      gap: "0px",
      padding: "0px",
      width: "100px",
      height: "60px",
      margin: "0px",
    },
    textLayout: null,
    visibility: {
      isVisible: true,
      display: "block",
      visibility: "visible",
      opacity: 1,
      pointerEvents: "auto",
      ariaHidden: null,
    },
    interactivity: {
      isInteractive: false,
      disabled: null,
      tabIndex: -1,
      cursor: "auto",
    },
    overlapHints: {
      topMostAtCenter: null,
      stackDepthAtCenter: 0,
      occludingSelector: null,
      captureClippedEdges: [],
    },
    candidateKind: "anchor" as const,
    anchorElementId: "root",
  };
  const element = {
    id: "cta",
    tag: "button",
    selector: "section#hero > button#cta",
    role: "button",
    testId: null,
    domId: "cta",
    classSummary: ["cta"],
    textSnippet: "Buy now",
    bbox: {
      x: 8,
      y: 8,
      width: 40,
      height: 18,
    },
    depth: 1,
    captureClippedEdges: [],
    textMetrics: null,
    ancestry: [root.locator],
    locator: {
      tag: "button",
      selector: "section#hero > button#cta",
      role: "button",
      testId: null,
      domId: "cta",
      classSummary: ["cta"],
    },
    identity: {
      domId: "cta",
      classSummary: ["cta"],
      testId: null,
      semanticTag: "button",
      candidateKind: "anchor" as const,
    },
    computedStyle: {
      fontSize: "16px",
      lineHeight: "24px",
      fontWeight: "400",
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderRadius: "0px",
      gap: "0px",
      padding: "0px",
      width: "40px",
      height: "18px",
      margin: "0px",
    },
    textLayout: {
      lineCount: 1,
      wrapState: "single-line" as const,
      hasEllipsis: false,
      lineClamp: null,
      overflowsX: false,
      overflowsY: false,
    },
    visibility: {
      isVisible: true,
      display: "block",
      visibility: "visible",
      opacity: 1,
      pointerEvents: "auto",
      ariaHidden: null,
    },
    interactivity: {
      isInteractive: true,
      disabled: false,
      tabIndex: 0,
      cursor: "pointer",
    },
    overlapHints: {
      topMostAtCenter: "section#hero > button#cta",
      stackDepthAtCenter: 1,
      occludingSelector: null,
      captureClippedEdges: [],
    },
    candidateKind: "anchor" as const,
    anchorElementId: "cta",
    ...elementOverrides,
  };

  if (
    element.captureClippedEdges.length > 0 &&
    element.overlapHints.captureClippedEdges.length === 0
  ) {
    element.overlapHints = {
      ...element.overlapHints,
      captureClippedEdges: element.captureClippedEdges,
    };
  }

  return {
    root,
    elements: [element],
    bindingCandidates: [element],
  };
}

describe("buildGeometryDrift", () => {
  test("computes normalized position and size drift from matched boxes", () => {
    const geometry = buildGeometryDrift(
      {
        x: 10,
        y: 20,
        width: 100,
        height: 40,
      },
      {
        x: 22,
        y: 20,
        width: 120,
        height: 40,
      },
    );

    expect(geometry).toEqual(
      expect.objectContaining({
        centerShiftPx: 22,
        widthDeltaPx: 20,
        heightDeltaPx: 0,
        widthDeltaRatio: 0.2,
        dominantDrift: "mixed",
        positionShiftLevel: "large",
        sizeShiftLevel: "large",
      }),
    );
  });
});

describe("buildTextValidation", () => {
  test("returns text_overflow for a significant matched text node with vertical overflow", () => {
    const textValidation = buildTextValidation({
      element: {
        tag: "h2",
        textSnippet: "Built for practical LLM training",
        bbox: {
          width: 429,
          height: 112,
        },
      },
      context: {
        semantic: {
          computedStyle: {
            fontSize: "56px",
            lineHeight: "56px",
            fontWeight: "500",
            color: "rgb(13, 13, 12)",
            backgroundColor: "rgba(0, 0, 0, 0)",
            borderRadius: "0px",
            gap: "0px",
            padding: "0px",
            width: "429px",
            height: "112px",
            margin: "0px",
          },
          textLayout: {
            lineCount: 2,
            wrapState: "overflowing" as const,
            hasEllipsis: false,
            lineClamp: "none",
            overflowsX: false,
            overflowsY: true,
          },
        },
      },
      correspondence: {
        groupId: "heading",
        attempted: true,
        found: true,
        reliable: true,
        method: "template",
        confidence: 0.88,
        ambiguity: 0.12,
        matchedReferenceBBox: {
          x: 384,
          y: 205,
          width: 429,
          height: 112,
        },
        delta: {
          dx: 0,
          dy: 5,
          dw: 0,
          dh: 0,
        },
        scores: {
          thumbnail: 0.88,
          edge: 0.81,
          ssim: 0.82,
          geometry: 0.8,
          structural: 0.8,
        },
      },
      geometry: {
        centerShiftPx: 5,
        normalizedCenterShift: 0.0113,
        widthDeltaPx: 0,
        heightDeltaPx: 0,
        widthDeltaRatio: 0,
        heightDeltaRatio: 0,
        areaDeltaRatio: 0,
        aspectRatioDelta: 0,
        dominantDrift: "none",
        positionShiftLevel: "small",
        sizeShiftLevel: "none",
      },
      siblingRelation: undefined,
      signals: [],
    });

    expect(textValidation).toEqual(
      expect.objectContaining({
        status: "matched",
        diagnosisKind: "text_overflow",
        allowsDirectionalClaim: true,
      }),
    );
    expect(textValidation?.observations).toEqual(
      expect.arrayContaining([
        "Preview text overflows vertically.",
        "Preview text spans 2 line(s).",
      ]),
    );
  });
});

describe("buildSiblingRelationsIndex", () => {
  test("computes spacing and alignment drift against a localized sibling", () => {
    const rootSnapshot = createDomSnapshotForTest();
    const left = rootSnapshot.elements[0]!;
    const right = {
      ...left,
      id: "cta-secondary",
      selector: "section#hero > button#cta-secondary",
      testId: "hero-cta-secondary",
      bbox: {
        x: 60,
        y: 10,
        width: 40,
        height: 18,
      },
      locator: {
        ...left.locator,
        selector: "section#hero > button#cta-secondary",
        testId: "hero-cta-secondary",
      },
      identity: {
        ...left.identity,
        testId: "hero-cta-secondary",
      },
      overlapHints: {
        ...left.overlapHints,
        topMostAtCenter: "section#hero > button#cta-secondary",
      },
      anchorElementId: "cta-secondary",
    };
    const parentGroup: GroupNode = {
      id: rootSnapshot.root.id,
      selector: rootSnapshot.root.selector,
      representativeElementId: rootSnapshot.root.id,
      representativeElement: rootSnapshot.root,
      bbox: rootSnapshot.root.bbox,
      area: rootSnapshot.root.bbox.width * rootSnapshot.root.bbox.height,
      depth: rootSnapshot.root.depth,
      memberElementIds: [rootSnapshot.root.id],
      parentGroupId: null,
      childGroupIds: [left.id, right.id],
      mismatchWeight: 0,
      traits: {
        hasOwnText: false,
        hasTextDescendant: true,
        isInteractive: false,
        hasPaintedBox: false,
        isGraphicsOnly: false,
        isComposite: true,
      },
    };
    const leftGroup: GroupNode = {
      id: left.id,
      selector: left.selector,
      representativeElementId: left.id,
      representativeElement: left,
      bbox: left.bbox,
      area: left.bbox.width * left.bbox.height,
      depth: left.depth,
      memberElementIds: [left.id],
      parentGroupId: parentGroup.id,
      childGroupIds: [],
      mismatchWeight: 1,
      traits: {
        hasOwnText: Boolean(left.textSnippet),
        hasTextDescendant: Boolean(left.textSnippet),
        isInteractive: true,
        hasPaintedBox: true,
        isGraphicsOnly: false,
        isComposite: false,
      },
    };
    const rightGroup: GroupNode = {
      ...leftGroup,
      id: right.id,
      selector: right.selector,
      representativeElementId: right.id,
      representativeElement: right,
      bbox: right.bbox,
      area: right.bbox.width * right.bbox.height,
      memberElementIds: [right.id],
      mismatchWeight: 0.8,
    };
    const localizations = new Map<string, GroupLocalization>([
      [
        left.id,
        {
          groupId: left.id,
          attempted: true,
          found: true,
          reliable: true,
          method: "template",
          confidence: 0.88,
          ambiguity: 0.06,
          matchedReferenceBBox: {
            x: 10,
            y: 10,
            width: 40,
            height: 18,
          },
          delta: { dx: 0, dy: 0, dw: 0, dh: 0 },
          scores: {
            thumbnail: 0.88,
            edge: 0.81,
            ssim: 0.83,
            geometry: 0.8,
            structural: 0.82,
          },
        },
      ],
      [
        right.id,
        {
          groupId: right.id,
          attempted: true,
          found: true,
          reliable: true,
          method: "template",
          confidence: 0.86,
          ambiguity: 0.08,
          matchedReferenceBBox: {
            x: 82,
            y: 14,
            width: 40,
            height: 18,
          },
          delta: { dx: 22, dy: 4, dw: 0, dh: 0 },
          scores: {
            thumbnail: 0.86,
            edge: 0.8,
            ssim: 0.81,
            geometry: 0.79,
            structural: 0.8,
          },
        },
      ],
    ]);
    const relations = buildSiblingRelationsIndex(
      new Map([
        [parentGroup.id, parentGroup],
        [leftGroup.id, leftGroup],
        [rightGroup.id, rightGroup],
      ]),
      localizations,
    );

    expect(relations.get(left.id)).toEqual(
      expect.objectContaining({
        siblingSelector: right.selector,
        axis: "horizontal",
        gapDeltaPx: 20,
        crossAxisOffsetDeltaPx: 2,
        spacingDriftLevel: "medium",
        alignmentDriftLevel: "small",
        dominantDrift: "spacing",
        relativeOrderPreserved: true,
      }),
    );
  });
});

describe("buildFindingsAnalysis", () => {
  test("omits context for visual-cluster findings", () => {
    const analysis = buildFindingsAnalysis({
      analysisMode: "visual-clusters",
      rawRegions: [createRegion({ x: 12, y: 12, width: 6, height: 6, pixelCount: 36 })],
      domSnapshot: null,
      width: 120,
      height: 80,
    });

    expect(analysis.findings[0]?.context).toBeUndefined();
  });

  test("keeps stable finding ids across runs and input reordering", () => {
    const rawRegions = [
      createRegion({ x: 60, y: 12, width: 6, height: 6, pixelCount: 36 }),
      createRegion({ x: 12, y: 12, width: 6, height: 6, pixelCount: 36 }),
    ];

    const firstRun = buildFindingsAnalysis({
      analysisMode: "visual-clusters",
      rawRegions,
      domSnapshot: null,
      width: 120,
      height: 80,
    });
    const secondRun = buildFindingsAnalysis({
      analysisMode: "visual-clusters",
      rawRegions: [...rawRegions].reverse(),
      domSnapshot: null,
      width: 120,
      height: 80,
    });

    expect(firstRun.findings.map((finding) => finding.id)).toEqual(
      secondRun.findings.map((finding) => finding.id),
    );
  });

  test("assigns different stable ids to different findings with the same severity band", () => {
    const analysis = buildFindingsAnalysis({
      analysisMode: "visual-clusters",
      rawRegions: [
        createRegion({ x: 12, y: 12, width: 6, height: 6, pixelCount: 36 }),
        createRegion({ x: 60, y: 12, width: 6, height: 6, pixelCount: 36 }),
      ],
      domSnapshot: null,
      width: 120,
      height: 80,
    });

    expect(analysis.findings).toHaveLength(2);
    expect(analysis.findings[0]?.id).not.toBe(analysis.findings[1]?.id);
  });

  test("applies deterministic suffixes when stable finding hashes collide", () => {
    const analysis = buildFindingsAnalysis({
      analysisMode: "visual-clusters",
      rawRegions: [
        createRegion({ x: 100, y: 2, width: 1, height: 1, pixelCount: 1 }),
        createRegion({ x: 118, y: 2, width: 1, height: 1, pixelCount: 1 }),
      ],
      domSnapshot: null,
      width: 400_000,
      height: 20,
    });

    expect(analysis.findings).toHaveLength(2);
    expect(analysis.findings[0]?.id).toMatch(/^finding-[0-9a-f]{12}$/);
    expect(analysis.findings[1]?.id).toBe(`${analysis.findings[0]?.id}-02`);
  });

  test("uses text wrapping as the root cause group when text clipping and capture crop signals coexist", () => {
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [
        createRegion({ x: 10, y: 10, width: 20, height: 8, pixelCount: 160, severity: "medium" }),
      ],
      domSnapshot: createDomSnapshotForTest({
        captureClippedEdges: ["right"],
        textMetrics: {
          clientWidth: 40,
          clientHeight: 18,
          scrollWidth: 52,
          scrollHeight: 18,
          overflowX: "hidden",
          overflowY: "visible",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          lineClamp: null,
        },
      }),
      width: 100,
      height: 60,
    });

    expect(analysis.findings[0]?.signals.map((signal) => signal.code)).toEqual([
      "probable_text_clipping",
      "possible_capture_crop",
    ]);
    expect(analysis.findings[0]?.rootCauseGroupId).toBe("text-wrap-regression");
    expect(analysis.findings[0]?.context?.semantic?.textLayout).toEqual(
      expect.objectContaining({
        lineCount: 1,
        wrapState: "single-line" as const,
        hasEllipsis: false,
      }),
    );
    expect(analysis.findings[0]?.context?.semantic?.captureClippedEdges).toEqual(["right"]);
    expect(analysis.findings[0]?.summary).toContain("text appears clipped");
    expect(analysis.findings[0]?.fixHint).toContain("overflow");
  });

  test("emits center-hit binding diagnostics for strong anchor matches", () => {
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [createRegion({ x: 10, y: 10, width: 12, height: 8, pixelCount: 96 })],
      domSnapshot: createDomSnapshotForTest(),
      width: 100,
      height: 60,
    });

    expect(analysis.findings[0]?.context?.binding).toEqual(
      expect.objectContaining({
        assignmentMethod: "center-hit",
      }),
    );
    expect(analysis.findings[0]?.context?.binding?.fallbackMarker).toBeUndefined();
  });

  test("emits ancestor-proxy diagnostics when an inline descendant wins the binding", () => {
    const baseSnapshot = createDomSnapshotForTest();
    const anchor = baseSnapshot.elements[0];
    const proxy = {
      ...anchor,
      id: "label",
      tag: "span",
      selector: "section#hero > button#cta > span.label",
      testId: "hero-label",
      domId: null,
      classSummary: ["label"],
      bbox: {
        x: 10,
        y: 10,
        width: 18,
        height: 8,
      },
      depth: 2,
      ancestry: [anchor.locator, baseSnapshot.root.locator],
      locator: {
        tag: "span",
        selector: "section#hero > button#cta > span.label",
        role: null,
        testId: "hero-label",
        domId: null,
        classSummary: ["label"],
      },
      identity: {
        domId: null,
        classSummary: ["label"],
        testId: "hero-label",
        semanticTag: "button",
        candidateKind: "inline-descendant" as const,
      },
      overlapHints: {
        topMostAtCenter: "section#hero > button#cta > span.label",
        stackDepthAtCenter: 1,
        occludingSelector: null,
        captureClippedEdges: [],
      },
      candidateKind: "inline-descendant" as const,
      anchorElementId: anchor.id,
    };
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [createRegion({ x: 12, y: 10, width: 10, height: 8, pixelCount: 80 })],
      domSnapshot: {
        ...baseSnapshot,
        bindingCandidates: [proxy, anchor],
      },
      width: 100,
      height: 60,
    });

    expect(analysis.findings[0]?.element?.tag).toBe("button");
    expect(analysis.findings[0]?.context?.binding).toEqual(
      expect.objectContaining({
        assignmentMethod: "ancestor-proxy",
        fallbackMarker: "inline-proxy",
      }),
    );
  });

  test("emits weak overlap fallback diagnostics for low-confidence overlap matches", () => {
    const baseSnapshot = createDomSnapshotForTest({
      bbox: {
        x: 8,
        y: 8,
        width: 10,
        height: 10,
      },
    });
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [createRegion({ x: 0, y: 8, width: 10, height: 10, pixelCount: 100 })],
      domSnapshot: baseSnapshot,
      width: 100,
      height: 60,
    });

    expect(analysis.findings[0]?.context?.binding).toEqual(
      expect.objectContaining({
        assignmentMethod: "overlap-best-fit",
        fallbackMarker: "weak-overlap",
      }),
    );
    expect(analysis.findings[0]?.context?.binding.assignmentConfidence).toBeLessThan(0.7);
  });

  test("adds geometry drift to localized DOM findings and upgrades layout classification", () => {
    const domSnapshot = createDomSnapshotForTest();
    const anchor = domSnapshot.elements[0]!;
    const group: GroupNode = {
      id: anchor.id,
      selector: anchor.selector,
      representativeElementId: anchor.id,
      representativeElement: anchor,
      bbox: anchor.bbox,
      area: anchor.bbox.width * anchor.bbox.height,
      depth: anchor.depth,
      memberElementIds: [anchor.id],
      parentGroupId: null,
      childGroupIds: [],
      mismatchWeight: 1,
      traits: {
        hasOwnText: Boolean(anchor.textSnippet),
        hasTextDescendant: Boolean(anchor.textSnippet),
        isInteractive: anchor.interactivity.isInteractive,
        hasPaintedBox: true,
        isGraphicsOnly: false,
        isComposite: false,
      },
    };
    const localization: GroupLocalization = {
      groupId: group.id,
      attempted: true,
      found: true,
      reliable: true,
      method: "template",
      confidence: 0.84,
      ambiguity: 0.08,
      matchedReferenceBBox: {
        x: anchor.bbox.x + 12,
        y: anchor.bbox.y,
        width: anchor.bbox.width + 20,
        height: anchor.bbox.height,
      },
      delta: {
        dx: 12,
        dy: 0,
        dw: 20,
        dh: 0,
      },
      scores: {
        thumbnail: 0.84,
        edge: 0.79,
        ssim: 0.8,
        geometry: 0.78,
        structural: 0.76,
      },
    };
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [
        createRegion({ x: 10, y: 10, width: 12, height: 8, pixelCount: 96, kind: "pixel" }),
      ],
      domSnapshot,
      groupsById: new Map([[group.id, group]]),
      elementToGroupId: new Map([[anchor.id, group.id]]),
      localizationsByGroupId: new Map([[group.id, localization]]),
      width: 100,
      height: 60,
    });

    expect(analysis.findings[0]?.code).toBe("layout_mismatch");
    expect(analysis.findings[0]?.geometry).toEqual(
      expect.objectContaining({
        widthDeltaPx: 20,
        positionShiftLevel: "large",
        sizeShiftLevel: "large",
        dominantDrift: "mixed",
      }),
    );
    expect(analysis.findings[0]?.likelyAffectedProperties).toEqual(
      expect.arrayContaining(["layout.position", "layout.alignment", "size.width"]),
    );
    expect(analysis.findings[0]?.issueTypes).toEqual(expect.arrayContaining(["position", "size"]));
    expect(analysis.findings[0]?.summary).toContain("matched reference area in position and size");
    expect(analysis.findings[0]?.fixHint).toContain("matched element against the reference");
  });

  test("adds sibling relation drift to localized DOM findings", () => {
    const domSnapshot = createDomSnapshotForTest();
    const anchor = domSnapshot.elements[0]!;
    const sibling = {
      ...anchor,
      id: "cta-secondary",
      selector: "section#hero > button#cta-secondary",
      testId: "hero-cta-secondary",
      bbox: {
        x: 60,
        y: 10,
        width: 40,
        height: 18,
      },
      locator: {
        ...anchor.locator,
        selector: "section#hero > button#cta-secondary",
        testId: "hero-cta-secondary",
      },
      identity: {
        ...anchor.identity,
        testId: "hero-cta-secondary",
      },
      overlapHints: {
        ...anchor.overlapHints,
        topMostAtCenter: "section#hero > button#cta-secondary",
      },
      anchorElementId: "cta-secondary",
    };
    const parentGroup: GroupNode = {
      id: domSnapshot.root.id,
      selector: domSnapshot.root.selector,
      representativeElementId: domSnapshot.root.id,
      representativeElement: domSnapshot.root,
      bbox: domSnapshot.root.bbox,
      area: domSnapshot.root.bbox.width * domSnapshot.root.bbox.height,
      depth: domSnapshot.root.depth,
      memberElementIds: [domSnapshot.root.id],
      parentGroupId: null,
      childGroupIds: [anchor.id, sibling.id],
      mismatchWeight: 0,
      traits: {
        hasOwnText: false,
        hasTextDescendant: true,
        isInteractive: false,
        hasPaintedBox: false,
        isGraphicsOnly: false,
        isComposite: true,
      },
    };
    const anchorGroup: GroupNode = {
      id: anchor.id,
      selector: anchor.selector,
      representativeElementId: anchor.id,
      representativeElement: anchor,
      bbox: anchor.bbox,
      area: anchor.bbox.width * anchor.bbox.height,
      depth: anchor.depth,
      memberElementIds: [anchor.id],
      parentGroupId: parentGroup.id,
      childGroupIds: [],
      mismatchWeight: 1,
      traits: {
        hasOwnText: Boolean(anchor.textSnippet),
        hasTextDescendant: Boolean(anchor.textSnippet),
        isInteractive: anchor.interactivity.isInteractive,
        hasPaintedBox: true,
        isGraphicsOnly: false,
        isComposite: false,
      },
    };
    const siblingGroup: GroupNode = {
      ...anchorGroup,
      id: sibling.id,
      selector: sibling.selector,
      representativeElementId: sibling.id,
      representativeElement: sibling,
      bbox: sibling.bbox,
      area: sibling.bbox.width * sibling.bbox.height,
      memberElementIds: [sibling.id],
      mismatchWeight: 0.8,
    };
    const localizations = new Map<string, GroupLocalization>([
      [
        anchor.id,
        {
          groupId: anchor.id,
          attempted: true,
          found: true,
          reliable: true,
          method: "template",
          confidence: 0.88,
          ambiguity: 0.06,
          matchedReferenceBBox: {
            x: 10,
            y: 10,
            width: 40,
            height: 18,
          },
          delta: { dx: 0, dy: 0, dw: 0, dh: 0 },
          scores: {
            thumbnail: 0.88,
            edge: 0.81,
            ssim: 0.83,
            geometry: 0.8,
            structural: 0.82,
          },
        },
      ],
      [
        sibling.id,
        {
          groupId: sibling.id,
          attempted: true,
          found: true,
          reliable: true,
          method: "template",
          confidence: 0.86,
          ambiguity: 0.08,
          matchedReferenceBBox: {
            x: 82,
            y: 14,
            width: 40,
            height: 18,
          },
          delta: { dx: 22, dy: 4, dw: 0, dh: 0 },
          scores: {
            thumbnail: 0.86,
            edge: 0.8,
            ssim: 0.81,
            geometry: 0.79,
            structural: 0.8,
          },
        },
      ],
    ]);
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [
        createRegion({ x: 10, y: 10, width: 12, height: 8, pixelCount: 96, kind: "pixel" }),
      ],
      domSnapshot: {
        ...domSnapshot,
        elements: [anchor, sibling],
        bindingCandidates: [anchor, sibling],
      },
      groupsById: new Map([
        [parentGroup.id, parentGroup],
        [anchorGroup.id, anchorGroup],
        [siblingGroup.id, siblingGroup],
      ]),
      elementToGroupId: new Map([
        [anchor.id, anchor.id],
        [sibling.id, sibling.id],
      ]),
      localizationsByGroupId: localizations,
      width: 100,
      height: 60,
    });

    expect(analysis.findings[0]?.siblingRelation).toEqual(
      expect.objectContaining({
        axis: "horizontal",
        spacingDriftLevel: "medium",
        alignmentDriftLevel: "small",
        dominantDrift: "spacing",
      }),
    );
    expect(analysis.findings[0]?.likelyAffectedProperties).toEqual(
      expect.arrayContaining(["layout.spacing", "layout.alignment", "layout.position"]),
    );
    expect(analysis.findings[0]?.issueTypes).toEqual(
      expect.arrayContaining(["spacing", "position"]),
    );
    expect(analysis.findings[0]?.summary).toContain("spacing relative to a nearby sibling");
    expect(analysis.findings[0]?.fixHint).toContain("gap or spacing");
  });

  test("describes unmatched overflowing content without overclaiming the cause", () => {
    const domSnapshot = createDomSnapshotForTest({
      tag: "header",
      selector: "section#hero > header",
      textSnippet: "A long heading",
      computedStyle: {
        fontSize: "16px",
        lineHeight: "24px",
        fontWeight: "400",
        color: "rgb(0, 0, 0)",
        backgroundColor: "rgba(0, 0, 0, 0)",
        borderRadius: "0px",
        gap: "24px",
        padding: "0px",
        width: "1024px",
        height: "162px",
        margin: "0px",
      },
      textLayout: {
        lineCount: 6,
        wrapState: "overflowing" as const,
        hasEllipsis: false,
        lineClamp: "none",
        overflowsX: true,
        overflowsY: true,
      },
    });
    const anchor = domSnapshot.elements[0]!;
    const group: GroupNode = {
      id: anchor.id,
      selector: anchor.selector,
      representativeElementId: anchor.id,
      representativeElement: anchor,
      bbox: anchor.bbox,
      area: anchor.bbox.width * anchor.bbox.height,
      depth: anchor.depth,
      memberElementIds: [anchor.id],
      parentGroupId: null,
      childGroupIds: [],
      mismatchWeight: 1,
      traits: {
        hasOwnText: true,
        hasTextDescendant: true,
        isInteractive: false,
        hasPaintedBox: false,
        isGraphicsOnly: false,
        isComposite: false,
      },
    };
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [
        createRegion({ x: 10, y: 10, width: 12, height: 8, pixelCount: 96, kind: "pixel" }),
      ],
      domSnapshot,
      groupsById: new Map([[group.id, group]]),
      elementToGroupId: new Map([[anchor.id, group.id]]),
      localizationsByGroupId: new Map([
        [
          group.id,
          {
            groupId: group.id,
            attempted: true,
            found: false,
            reliable: false,
            method: "none",
            confidence: 0,
            ambiguity: 1,
            scores: {
              thumbnail: 0,
              edge: 0,
              ssim: 0,
              geometry: 0,
              structural: 0,
            },
          },
        ],
      ]),
      width: 100,
      height: 60,
    });

    expect(analysis.findings[0]?.code).toBe("text_clipping");
    expect(analysis.findings[0]?.summary).toContain("text appears clipped");
    expect(analysis.findings[0]?.summary).toContain("overflows its current 1024px x 162px box");
    expect(analysis.findings[0]?.fixHint).toContain("line-height");
  });

  test("describes vertical offset when geometry shift is reliable and size is unchanged", () => {
    const domSnapshot = createDomSnapshotForTest();
    const anchor = domSnapshot.elements[0]!;
    const group: GroupNode = {
      id: anchor.id,
      selector: anchor.selector,
      representativeElementId: anchor.id,
      representativeElement: anchor,
      bbox: anchor.bbox,
      area: anchor.bbox.width * anchor.bbox.height,
      depth: anchor.depth,
      memberElementIds: [anchor.id],
      parentGroupId: null,
      childGroupIds: [],
      mismatchWeight: 1,
      traits: {
        hasOwnText: true,
        hasTextDescendant: true,
        isInteractive: true,
        hasPaintedBox: true,
        isGraphicsOnly: false,
        isComposite: false,
      },
    };
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [
        createRegion({ x: 10, y: 10, width: 12, height: 8, pixelCount: 96, kind: "layout" }),
      ],
      domSnapshot,
      groupsById: new Map([[group.id, group]]),
      elementToGroupId: new Map([[anchor.id, group.id]]),
      localizationsByGroupId: new Map([
        [
          group.id,
          {
            groupId: group.id,
            attempted: true,
            found: true,
            reliable: true,
            method: "template",
            confidence: 0.9,
            ambiguity: 0.08,
            matchedReferenceBBox: {
              x: anchor.bbox.x,
              y: anchor.bbox.y - 16,
              width: anchor.bbox.width,
              height: anchor.bbox.height,
            },
            delta: {
              dx: 0,
              dy: -16,
              dw: 0,
              dh: 0,
            },
            scores: {
              thumbnail: 0.9,
              edge: 0.84,
              ssim: 0.83,
              geometry: 0.85,
              structural: 0.84,
            },
          },
        ],
      ]),
      width: 100,
      height: 60,
    });

    expect(analysis.findings[0]?.summary).toContain("vertically offset");
    expect(analysis.findings[0]?.summary).toContain("16px");
    expect(analysis.findings[0]?.fixHint).toContain("top/bottom spacing");
  });

  test("markdown summary avoids precise directional geometry claims for moderate-confidence matches", () => {
    const finding = createFinding({
      kind: "mixed",
      severity: "medium",
      code: "layout_style_mismatch",
      summary:
        "Element <header> differs from the matched reference area in position and visual styling differs.",
      fixHint:
        "Check the matched element against the reference before making a more specific layout change Then reconcile colors, fills, borders, or shadows.",
      element: {
        tag: "header",
        selector: "section#hero > header",
      },
      correspondenceMethod: "template",
      correspondenceConfidence: 0.7442,
      ambiguity: 0.1778,
      delta: {
        dx: -60,
        dy: 5,
        dw: 0,
        dh: 0,
      },
      geometry: {
        centerShiftPx: 60.208,
        normalizedCenterShift: 0.0518,
        widthDeltaPx: 0,
        heightDeltaPx: 0,
        widthDeltaRatio: 0,
        heightDeltaRatio: 0,
        areaDeltaRatio: 0,
        aspectRatioDelta: 0,
        dominantDrift: "position",
        positionShiftLevel: "large",
        sizeShiftLevel: "none",
      },
      context: {
        binding: {
          assignmentMethod: "center-hit",
          assignmentConfidence: 0.99,
        },
        semantic: {
          computedStyle: {
            fontSize: "16px",
            lineHeight: "24px",
            fontWeight: "400",
            color: "rgb(13, 13, 12)",
            backgroundColor: "rgba(0, 0, 0, 0)",
            borderRadius: "0px",
            gap: "307px",
            padding: "0px",
            width: "1152px",
            height: "162px",
            margin: "0px",
          },
        },
      },
      likelyAffectedProperties: [
        "layout.position",
        "layout.spacing",
        "style.color",
        "style.background",
      ],
    });
    const report = {
      analysisMode: "dom-elements" as const,
      summary: {
        recommendation: "retry_fix" as const,
        severity: "high" as const,
        reason: "Test reason",
        decisionTrace: [],
        topActions: [],
        agentChecks: [],
        primaryBlockers: [],
        overallConfidence: 0.8,
        safeToAutofix: false,
        requiresRecapture: false,
        requiresSanityCheck: false,
        correspondenceCoverage: 0.8,
        correspondenceConfidence: 0.74,
        ambiguousCorrespondences: 1,
      },
      inputs: {
        preview: {
          input: "",
          kind: "url" as const,
          resolved: "",
          selector: null,
          ignoreSelectors: [],
        },
        reference: {
          input: "",
          kind: "figma-url" as const,
          resolved: "",
          selector: null,
          transport: "figma-rest" as const,
        },
        viewport: { width: 1920, height: 1115 },
        mode: "all" as const,
        fullPage: false,
      },
      images: {
        preview: { width: 1920, height: 1115 },
        reference: { width: 1920, height: 1114 },
        canvas: { width: 1920, height: 1115 },
      },
      metrics: createMetrics({
        mismatchPixels: 10,
        mismatchPercent: 1,
        findingsCount: 1,
        affectedElementCount: 1,
      }),
      rollups: {
        bySeverity: [],
        byKind: [],
        byTag: [],
        rawRegionCount: 1,
        findingsCount: 1,
        affectedElementCount: 1,
        omittedFindings: 0,
        omittedBySeverity: [],
        omittedByKind: [],
        topOmittedSelectors: [],
        largestOmittedRegions: [],
        tailAreaPercent: 0,
      },
      findings: [finding],
      artifacts: {
        preview: "",
        reference: "",
        overlay: "",
        diff: "",
        heatmap: "",
        report: "",
        summary: "",
      },
      error: null,
    };

    const markdown = buildMarkdownTextReport(report);
    expect(markdown).toContain("matched element differs from the reference area");
    expect(markdown).not.toContain("horizontally offset by about 60px");
  });

  test("uses text-specific diagnosis for matched overflowing heading blocks", () => {
    const domSnapshot = createDomSnapshotForTest({
      tag: "h2",
      selector: "section#hero > h2.title",
      textSnippet: "Built for practical LLM training",
      bbox: { x: 40, y: 76, width: 429, height: 112 },
      computedStyle: {
        fontSize: "56px",
        lineHeight: "56px",
        fontWeight: "500",
        color: "rgb(13, 13, 12)",
        backgroundColor: "rgba(0, 0, 0, 0)",
        borderRadius: "0px",
        gap: "0px",
        padding: "0px",
        width: "429px",
        height: "112px",
        margin: "0px",
      },
      textLayout: {
        lineCount: 2,
        wrapState: "overflowing" as const,
        hasEllipsis: false,
        lineClamp: "none",
        overflowsX: false,
        overflowsY: true,
      },
    });
    const anchor = domSnapshot.elements[0]!;
    const group: GroupNode = {
      id: anchor.id,
      selector: anchor.selector,
      representativeElementId: anchor.id,
      representativeElement: anchor,
      bbox: anchor.bbox,
      area: anchor.bbox.width * anchor.bbox.height,
      depth: anchor.depth,
      memberElementIds: [anchor.id],
      parentGroupId: null,
      childGroupIds: [],
      mismatchWeight: 1,
      traits: {
        hasOwnText: true,
        hasTextDescendant: true,
        isInteractive: false,
        hasPaintedBox: false,
        isGraphicsOnly: false,
        isComposite: false,
      },
    };
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [
        createRegion({
          x: 40,
          y: 76,
          width: 80,
          height: 24,
          pixelCount: 1920,
          kind: "pixel",
          severity: "medium",
        }),
      ],
      domSnapshot,
      groupsById: new Map([[group.id, group]]),
      elementToGroupId: new Map([[anchor.id, group.id]]),
      localizationsByGroupId: new Map([
        [
          group.id,
          {
            groupId: group.id,
            attempted: true,
            found: true,
            reliable: true,
            method: "template",
            confidence: 0.88,
            ambiguity: 0.12,
            matchedReferenceBBox: { x: 40, y: 71, width: 429, height: 112 },
            delta: { dx: 0, dy: -5, dw: 0, dh: 0 },
            scores: { thumbnail: 0.88, edge: 0.82, ssim: 0.81, geometry: 0.8, structural: 0.81 },
          },
        ],
      ]),
      width: 640,
      height: 320,
    });

    expect(analysis.findings[0]?.code).toBe("text_clipping");
    expect(analysis.findings[0]?.textValidation).toEqual(
      expect.objectContaining({
        status: "matched",
        diagnosisKind: "text_overflow",
      }),
    );
    expect(analysis.findings[0]?.summary).toContain("text appears clipped");
    expect(analysis.findings[0]?.fixHint).toContain("line-height");
    expect(analysis.findings[0]?.likelyAffectedProperties).toEqual(
      expect.arrayContaining(["text.overflow", "text.lineClamp", "style.typography"]),
    );
  });

  test("keeps significant child text findings alongside a parent container finding", () => {
    const base = createDomSnapshotForTest();
    const header = {
      ...base.elements[0]!,
      id: "header",
      tag: "header",
      selector: "section#hero > header",
      textSnippet: "Heading body text",
      bbox: { x: 20, y: 20, width: 460, height: 180 },
      locator: { ...base.elements[0]!.locator, tag: "header", selector: "section#hero > header" },
      identity: { ...base.elements[0]!.identity, semanticTag: "header" },
      anchorElementId: "header",
    };
    const title = {
      ...base.elements[0]!,
      id: "title",
      tag: "h2",
      selector: "section#hero > header > h2.title",
      textSnippet: "Built for practical LLM training",
      bbox: { x: 20, y: 52, width: 429, height: 112 },
      ancestry: [header.locator, base.root.locator],
      locator: {
        ...base.elements[0]!.locator,
        tag: "h2",
        selector: "section#hero > header > h2.title",
      },
      identity: { ...base.elements[0]!.identity, semanticTag: "h2" },
      anchorElementId: "title",
      computedStyle: {
        fontSize: "56px",
        lineHeight: "56px",
        fontWeight: "500",
        color: "rgb(13, 13, 12)",
        backgroundColor: "rgba(0, 0, 0, 0)",
        borderRadius: "0px",
        gap: "0px",
        padding: "0px",
        width: "429px",
        height: "112px",
        margin: "0px",
      },
      textLayout: {
        lineCount: 2,
        wrapState: "overflowing" as const,
        hasEllipsis: false,
        lineClamp: "none",
        overflowsX: false,
        overflowsY: true,
      },
    };
    const body = {
      ...base.elements[0]!,
      id: "body",
      tag: "p",
      selector: "section#hero > header > p.body",
      textSnippet: "Accelerate LLM training while maximizing GPU efficiency.",
      bbox: { x: 20, y: 172, width: 416, height: 54 },
      ancestry: [header.locator, base.root.locator],
      locator: {
        ...base.elements[0]!.locator,
        tag: "p",
        selector: "section#hero > header > p.body",
      },
      identity: { ...base.elements[0]!.identity, semanticTag: "p" },
      anchorElementId: "body",
    };
    const headerGroup: GroupNode = {
      id: header.id,
      selector: header.selector,
      representativeElementId: header.id,
      representativeElement: header,
      bbox: header.bbox,
      area: header.bbox.width * header.bbox.height,
      depth: header.depth,
      memberElementIds: [header.id],
      parentGroupId: base.root.id,
      childGroupIds: [title.id, body.id],
      mismatchWeight: 1,
      traits: {
        hasOwnText: true,
        hasTextDescendant: true,
        isInteractive: false,
        hasPaintedBox: false,
        isGraphicsOnly: false,
        isComposite: true,
      },
    };
    const titleGroup: GroupNode = {
      id: title.id,
      selector: title.selector,
      representativeElementId: title.id,
      representativeElement: title,
      bbox: title.bbox,
      area: title.bbox.width * title.bbox.height,
      depth: title.depth,
      memberElementIds: [title.id],
      parentGroupId: header.id,
      childGroupIds: [],
      mismatchWeight: 0.9,
      traits: {
        hasOwnText: true,
        hasTextDescendant: true,
        isInteractive: false,
        hasPaintedBox: false,
        isGraphicsOnly: false,
        isComposite: false,
      },
    };
    const bodyGroup: GroupNode = {
      id: body.id,
      selector: body.selector,
      representativeElementId: body.id,
      representativeElement: body,
      bbox: body.bbox,
      area: body.bbox.width * body.bbox.height,
      depth: body.depth,
      memberElementIds: [body.id],
      parentGroupId: header.id,
      childGroupIds: [],
      mismatchWeight: 0.7,
      traits: {
        hasOwnText: true,
        hasTextDescendant: true,
        isInteractive: false,
        hasPaintedBox: false,
        isGraphicsOnly: false,
        isComposite: false,
      },
    };
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [
        createRegion({
          x: 20,
          y: 60,
          width: 100,
          height: 30,
          pixelCount: 3000,
          kind: "pixel",
          severity: "medium",
        }),
        createRegion({
          x: 20,
          y: 40,
          width: 420,
          height: 150,
          pixelCount: 12000,
          kind: "layout",
          severity: "medium",
        }),
      ],
      domSnapshot: {
        ...base,
        elements: [header, title, body],
        bindingCandidates: [header, title, body],
      },
      groupsById: new Map([
        [headerGroup.id, headerGroup],
        [titleGroup.id, titleGroup],
        [bodyGroup.id, bodyGroup],
      ]),
      elementToGroupId: new Map([
        [header.id, header.id],
        [title.id, title.id],
        [body.id, body.id],
      ]),
      localizationsByGroupId: new Map([
        [
          header.id,
          {
            groupId: header.id,
            attempted: true,
            found: true,
            reliable: true,
            method: "template",
            confidence: 0.8,
            ambiguity: 0.1,
            matchedReferenceBBox: { x: 20, y: 20, width: 460, height: 180 },
            delta: { dx: 0, dy: 0, dw: 0, dh: 0 },
            scores: { thumbnail: 0.8, edge: 0.8, ssim: 0.8, geometry: 0.8, structural: 0.8 },
          },
        ],
        [
          title.id,
          {
            groupId: title.id,
            attempted: true,
            found: true,
            reliable: true,
            method: "template",
            confidence: 0.88,
            ambiguity: 0.12,
            matchedReferenceBBox: { x: 20, y: 47, width: 429, height: 112 },
            delta: { dx: 0, dy: -5, dw: 0, dh: 0 },
            scores: { thumbnail: 0.88, edge: 0.82, ssim: 0.81, geometry: 0.8, structural: 0.81 },
          },
        ],
      ]),
      width: 640,
      height: 320,
    });

    expect(analysis.findings.some((finding) => finding.element?.selector === title.selector)).toBe(
      true,
    );
  });

  test("avoids overly specific directional claims when geometry confidence is only moderate", () => {
    const domSnapshot = createDomSnapshotForTest({
      tag: "header",
      selector: "section#hero > header",
      textSnippet: "Heading block",
      computedStyle: {
        fontSize: "16px",
        lineHeight: "24px",
        fontWeight: "400",
        color: "rgb(0, 0, 0)",
        backgroundColor: "rgba(0, 0, 0, 0)",
        borderRadius: "0px",
        gap: "307px",
        padding: "0px",
        width: "1152px",
        height: "162px",
        margin: "0px",
      },
      bbox: {
        x: 384,
        y: 164,
        width: 1152,
        height: 162,
      },
    });
    const anchor = domSnapshot.elements[0]!;
    const group: GroupNode = {
      id: anchor.id,
      selector: anchor.selector,
      representativeElementId: anchor.id,
      representativeElement: anchor,
      bbox: anchor.bbox,
      area: anchor.bbox.width * anchor.bbox.height,
      depth: anchor.depth,
      memberElementIds: [anchor.id],
      parentGroupId: null,
      childGroupIds: [],
      mismatchWeight: 1,
      traits: {
        hasOwnText: true,
        hasTextDescendant: true,
        isInteractive: false,
        hasPaintedBox: false,
        isGraphicsOnly: false,
        isComposite: false,
      },
    };
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [
        createRegion({
          x: 1121,
          y: 278,
          width: 387,
          height: 45,
          pixelCount: 5924,
          kind: "mixed",
          severity: "medium",
        }),
      ],
      domSnapshot,
      groupsById: new Map([[group.id, group]]),
      elementToGroupId: new Map([[anchor.id, group.id]]),
      localizationsByGroupId: new Map([
        [
          group.id,
          {
            groupId: group.id,
            attempted: true,
            found: true,
            reliable: true,
            method: "template",
            confidence: 0.7442,
            ambiguity: 0.1778,
            matchedReferenceBBox: {
              x: 324,
              y: 169,
              width: 1152,
              height: 162,
            },
            delta: {
              dx: -60,
              dy: 5,
              dw: 0,
              dh: 0,
            },
            scores: {
              thumbnail: 0.74,
              edge: 0.73,
              ssim: 0.71,
              geometry: 0.69,
              structural: 0.8,
            },
          },
        ],
      ]),
      width: 1920,
      height: 1115,
    });

    expect(analysis.findings[0]?.summary).not.toContain("horizontally offset");
    expect(analysis.findings[0]?.summary).toContain("matched reference area");
    expect(analysis.findings[0]?.fixHint).toContain("matched element against the reference");
  });

  test("merges low-signal child wrapper findings into a meaningful parent group", () => {
    const baseSnapshot = createDomSnapshotForTest();
    const parent = {
      ...baseSnapshot.elements[0]!,
      id: "card",
      tag: "article",
      selector: "section#hero > article.card",
      textSnippet: null,
      bbox: {
        x: 8,
        y: 8,
        width: 80,
        height: 40,
      },
      locator: {
        ...baseSnapshot.elements[0]!.locator,
        tag: "article",
        selector: "section#hero > article.card",
      },
      identity: {
        ...baseSnapshot.elements[0]!.identity,
        semanticTag: "article",
      },
      interactivity: {
        ...baseSnapshot.elements[0]!.interactivity,
        isInteractive: false,
      },
      ancestry: [baseSnapshot.root.locator],
      anchorElementId: "card",
    };
    const childA = {
      ...baseSnapshot.elements[0]!,
      id: "card-copy",
      tag: "div",
      selector: "section#hero > article.card > div.copy",
      textSnippet: null,
      bbox: {
        x: 12,
        y: 12,
        width: 24,
        height: 10,
      },
      locator: {
        ...baseSnapshot.elements[0]!.locator,
        tag: "div",
        selector: "section#hero > article.card > div.copy",
      },
      identity: {
        ...baseSnapshot.elements[0]!.identity,
        semanticTag: "div",
      },
      interactivity: {
        ...baseSnapshot.elements[0]!.interactivity,
        isInteractive: false,
      },
      ancestry: [parent.locator, baseSnapshot.root.locator],
      anchorElementId: "card-copy",
    };
    const childB = {
      ...childA,
      id: "card-meta",
      selector: "section#hero > article.card > div.meta",
      bbox: {
        x: 12,
        y: 28,
        width: 28,
        height: 8,
      },
      locator: {
        ...childA.locator,
        selector: "section#hero > article.card > div.meta",
      },
      anchorElementId: "card-meta",
    };
    const parentGroup: GroupNode = {
      id: parent.id,
      selector: parent.selector,
      representativeElementId: parent.id,
      representativeElement: parent,
      bbox: parent.bbox,
      area: parent.bbox.width * parent.bbox.height,
      depth: parent.depth,
      memberElementIds: [parent.id],
      parentGroupId: baseSnapshot.root.id,
      childGroupIds: [childA.id, childB.id],
      mismatchWeight: 1,
      traits: {
        hasOwnText: false,
        hasTextDescendant: false,
        isInteractive: false,
        hasPaintedBox: true,
        isGraphicsOnly: false,
        isComposite: true,
      },
    };
    const childAGroup: GroupNode = {
      id: childA.id,
      selector: childA.selector,
      representativeElementId: childA.id,
      representativeElement: childA,
      bbox: childA.bbox,
      area: childA.bbox.width * childA.bbox.height,
      depth: childA.depth,
      memberElementIds: [childA.id],
      parentGroupId: parent.id,
      childGroupIds: [],
      mismatchWeight: 0.7,
      traits: {
        hasOwnText: false,
        hasTextDescendant: false,
        isInteractive: false,
        hasPaintedBox: false,
        isGraphicsOnly: false,
        isComposite: false,
      },
    };
    const childBGroup: GroupNode = {
      ...childAGroup,
      id: childB.id,
      selector: childB.selector,
      representativeElementId: childB.id,
      representativeElement: childB,
      bbox: childB.bbox,
      area: childB.bbox.width * childB.bbox.height,
      memberElementIds: [childB.id],
      mismatchWeight: 0.6,
    };
    const analysis = buildFindingsAnalysis({
      analysisMode: "dom-elements",
      rawRegions: [
        createRegion({ x: 12, y: 12, width: 12, height: 6, pixelCount: 72, kind: "pixel" }),
        createRegion({ x: 12, y: 28, width: 14, height: 6, pixelCount: 84, kind: "pixel" }),
      ],
      domSnapshot: {
        ...baseSnapshot,
        elements: [parent, childA, childB],
        bindingCandidates: [childA, childB],
      },
      groupsById: new Map([
        [parentGroup.id, parentGroup],
        [childAGroup.id, childAGroup],
        [childBGroup.id, childBGroup],
      ]),
      elementToGroupId: new Map([
        [childA.id, childA.id],
        [childB.id, childB.id],
      ]),
      localizationsByGroupId: new Map(),
      width: 100,
      height: 60,
    });

    expect(analysis.findings).toHaveLength(1);
    expect(analysis.findings[0]?.element?.selector).toBe(parent.selector);
    expect(analysis.findings[0]?.mismatchPixels).toBe(156);
  });
});

describe("buildSummaryReport", () => {
  test("derives an autofixable text overflow action from DOM findings", () => {
    const findingId = "finding-text-a";
    const findings = [
      createFinding({
        id: findingId,
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
        element: {
          selector: "section#hero > button#cta",
          tag: "button",
          textSnippet: "Buy",
        },
      }),
    ];
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
            findingIds: [findingId],
          }),
          createDecisionTrace({
            axis: "final",
            code: "final_retry_fix",
            outcome: "retry_fix",
            strength: "high",
            reason: "Localized issues were detected.",
            findingIds: [findingId],
          }),
        ],
      }),
      findings,
      fullFindings: findings,
      analysisMode: "dom-elements",
      omittedFindings: 0,
      error: null,
    });

    expect(summary.primaryBlockers[0]?.rootCauseGroupId).toBe("text-wrap-regression");
    expect(summary.topActions[0]?.code).toBe("fix_text_overflow");
    expect(summary.topActions[0]?.findingIds).toEqual([findingId]);
    expect(summary.safeToAutofix).toBe(true);
    expect(summary.requiresRecapture).toBe(false);
    expect(summary.decisionTrace.map((trace) => trace.code)).toEqual([
      "fixability_localized_actionable",
      "final_retry_fix",
    ]);
    expect(summary.overallConfidence).toBe(0.85);
  });

  test("keeps root causes and actions in stable order when mixed findings map to multiple causes", () => {
    const findings = [
      createFinding({
        id: "finding-mixed-a",
        kind: "mixed",
        severity: "high",
        code: "layout_style_mismatch",
        confidence: 0.77,
      }),
      createFinding({
        id: "finding-color-b",
        kind: "color",
        severity: "medium",
        code: "style_mismatch",
        confidence: 0.77,
      }),
    ];
    const summary = buildSummaryReport({
      baseDecision: createDecision({
        recommendation: "retry_fix",
        severity: "high",
        reason: "Mixed layout and style issues were detected.",
      }),
      findings,
      fullFindings: findings,
      analysisMode: "dom-elements",
      omittedFindings: 0,
      error: null,
    });

    expect(summary.primaryBlockers.map((candidate) => candidate.rootCauseGroupId)).toEqual([
      "layout-displacement",
      "visual-style-drift",
    ]);
    expect(summary.topActions.map((action) => action.code)).toEqual([
      "fix_layout_styles",
      "fix_visual_styles",
    ]);
    expect(summary.topActions[1]?.findingIds).toEqual(["finding-mixed-a", "finding-color-b"]);
  });

  test("keeps signal-derived root causes even when finding code comes from another signal or kind", () => {
    const findingId = "finding-signal-a";
    const findings = [
      createFinding({
        id: findingId,
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
        element: {
          selector: "section#hero > button#cta",
          tag: "button",
          textSnippet: "Buy",
        },
      }),
    ];
    const summary = buildSummaryReport({
      baseDecision: createDecision({
        recommendation: "retry_fix",
        severity: "high",
        reason:
          "Run a sanity check to confirm the preview and reference depict the same target before fixing; capture crop was detected.",
        decisionTrace: [
          createDecisionTrace({
            axis: "setup_capture_risk",
            code: "setup_capture_signal_risk",
            outcome: "retry_fix",
            strength: "high",
            reason:
              "Run a sanity check to confirm the preview and reference depict the same target before fixing; capture crop was detected.",
            findingIds: [findingId],
            signalCodes: ["possible_capture_crop"],
          }),
          createDecisionTrace({
            axis: "final",
            code: "final_retry_fix",
            outcome: "retry_fix",
            strength: "high",
            reason:
              "Run a sanity check to confirm the preview and reference depict the same target before fixing; capture crop was detected.",
            findingIds: [findingId],
            signalCodes: ["possible_capture_crop"],
          }),
        ],
      }),
      findings,
      fullFindings: findings,
      analysisMode: "dom-elements",
      omittedFindings: 0,
      error: null,
    });

    expect(summary.primaryBlockers.map((candidate) => candidate.rootCauseGroupId)).toEqual([
      "text-wrap-regression",
    ]);
    expect(summary.topActions.map((action) => action.code)).toEqual([
      "run_sanity_check_same_target",
      "recapture_with_broader_scope",
      "fix_text_overflow",
    ]);
    expect(summary.agentChecks[0]?.code).toBe("validate_same_target_before_fix");
    expect(summary.safeToAutofix).toBe(false);
    expect(summary.requiresRecapture).toBe(false);
    expect(summary.requiresSanityCheck).toBe(true);
  });

  test("groups visible and omitted findings into the same primary blocker", () => {
    const emittedFinding = createFinding({
      id: "finding-layout-visible",
      kind: "layout",
      severity: "high",
      code: "layout_mismatch",
      mismatchPercentOfCanvas: 1.2,
      mismatchPixels: 120,
    });
    const omittedFinding = createFinding({
      id: "finding-layout-omitted",
      kind: "layout",
      severity: "medium",
      code: "layout_mismatch",
      mismatchPercentOfCanvas: 0.8,
      mismatchPixels: 80,
    });
    const summary = buildSummaryReport({
      baseDecision: createDecision({
        recommendation: "retry_fix",
        severity: "high",
        reason: "Layout issues were detected.",
      }),
      findings: [emittedFinding],
      fullFindings: [emittedFinding, omittedFinding],
      analysisMode: "dom-elements",
      omittedFindings: 1,
      error: null,
    });

    expect(summary.primaryBlockers).toEqual([
      expect.objectContaining({
        rootCauseGroupId: "layout-displacement",
        findingCount: 2,
        omittedFindingCount: 1,
        sampleFindingIds: ["finding-layout-visible", "finding-layout-omitted"],
        affectedAreaPercent: 2,
      }),
    ]);
  });

  test("marks reference acquisition failures as requiring recapture/setup fixes", () => {
    const summary = buildSummaryReport({
      baseDecision: createDecision({
        recommendation: "needs_human_review",
        severity: "high",
        reason: "Figma did not return an image URL.",
      }),
      findings: [],
      fullFindings: [],
      analysisMode: "visual-clusters",
      omittedFindings: 0,
      error: {
        code: "figma_image_missing",
        message: "Figma did not return an image URL.",
        exitCode: 3,
      },
      failureOrigin: "reference",
    });

    expect(summary.primaryBlockers[0]?.rootCauseGroupId).toBe("reference-setup-error");
    expect(summary.topActions[0]?.code).toBe("fix_reference_setup");
    expect(summary.safeToAutofix).toBe(false);
    expect(summary.requiresRecapture).toBe(true);
    expect(summary.decisionTrace.at(-1)?.code).toBe("final_needs_human_review");
    expect(summary.overallConfidence).toBe(0.85);
  });

  test("classifies artifact write failures as output path problems instead of preview setup", () => {
    const summary = buildSummaryReport({
      baseDecision: createDecision({
        recommendation: "needs_human_review",
        severity: "medium",
        reason: "Failed to write PNG artifact: /tmp/peye/out/diff.png",
      }),
      findings: [],
      fullFindings: [],
      analysisMode: "dom-elements",
      omittedFindings: 0,
      error: {
        code: "artifact_write_failed",
        message: "Failed to write PNG artifact: /tmp/peye/out/diff.png",
        exitCode: 1,
      },
      failureOrigin: "unknown",
    });

    expect(summary.primaryBlockers[0]?.rootCauseGroupId).toBe("output-write-error");
    expect(summary.topActions[0]?.code).toBe("fix_output_path_or_permissions");
    expect(summary.safeToAutofix).toBe(false);
    expect(summary.requiresRecapture).toBe(false);
    expect(summary.decisionTrace.map((trace) => trace.axis)).toEqual(["final"]);
    expect(summary.decisionTrace.at(-1)?.code).toBe("final_needs_human_review");
  });

  test("reduces overall confidence for visual-cluster findings when findings are omitted", () => {
    const findingId = "finding-rendering-a";
    const findings = [
      createFinding({
        id: findingId,
        kind: "pixel",
        severity: "medium",
        code: "rendering_mismatch",
        confidence: 0.6,
      }),
    ];
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
            findingIds: [findingId],
          }),
          createDecisionTrace({
            axis: "final",
            code: "final_retry_fix",
            outcome: "retry_fix",
            strength: "high",
            reason: "Clustered issues were detected.",
            findingIds: [findingId],
          }),
        ],
      }),
      findings,
      fullFindings: findings,
      analysisMode: "visual-clusters",
      omittedFindings: 4,
      error: null,
    });

    expect(summary.topActions[0]?.code).toBe("fix_visual_styles");
    expect(summary.overallConfidence).toBe(0.7);
  });

  test("keeps global layout drift in human review without forcing recapture", () => {
    const findingId = "finding-layout-global";
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
            findingIds: [findingId],
          }),
          createDecisionTrace({
            axis: "final",
            code: "final_needs_human_review",
            outcome: "needs_human_review",
            strength: "high",
            reason: "Layout drift appears global rather than localized.",
            findingIds: [findingId],
          }),
        ],
      }),
      findings: [
        createFinding({
          id: findingId,
          kind: "layout",
          severity: "high",
          code: "layout_mismatch",
          rootCauseGroupId: "layout-displacement",
        }),
      ],
      fullFindings: [
        createFinding({
          id: findingId,
          kind: "layout",
          severity: "high",
          code: "layout_mismatch",
          rootCauseGroupId: "layout-displacement",
        }),
      ],
      analysisMode: "visual-clusters",
      omittedFindings: 0,
      error: null,
    });

    expect(summary.requiresRecapture).toBe(false);
    expect(summary.primaryBlockers[0]?.rootCauseGroupId).toBe("layout-displacement");
    expect(summary.decisionTrace.map((trace) => trace.code)).toEqual([
      "layout_global_drift",
      "final_needs_human_review",
    ]);
  });
});

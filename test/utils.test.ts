import { buildFindingsAnalysis } from "../src/analysis/findings.js";
import { describe, expect, test } from "vitest";
import { decideRecommendation } from "../src/analysis/recommendation.js";
import { buildSummaryReport } from "../src/analysis/summary.js";
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
  overrides: Omit<Partial<FindingReport>, "actionTarget" | "element" | "context"> & {
    actionTarget?: Partial<NonNullable<FindingReport["actionTarget"]>> | null;
    element?: Partial<NonNullable<FindingReport["element"]>> | null;
    context?: FindingReport["context"];
  } & Pick<FindingReport, "kind" | "severity">,
): FindingReport {
  const code = overrides.code ?? "rendering_mismatch";
  const signals = overrides.signals ?? [];
  const element =
    overrides.element === undefined || overrides.element === null
      ? null
      : {
          tag: overrides.element.tag ?? "button",
          selector: overrides.element.selector ?? "#target",
          role: overrides.element.role ?? null,
          testId: overrides.element.testId ?? null,
          textSnippet: overrides.element.textSnippet ?? null,
          bbox: overrides.element.bbox ?? {
            x: 0,
            y: 0,
            width: 20,
            height: 20,
          },
        };
  const actionTarget =
    overrides.actionTarget === undefined || overrides.actionTarget === null
      ? null
      : {
          selector: overrides.actionTarget.selector ?? "#target",
          tag: overrides.actionTarget.tag ?? "button",
          role: overrides.actionTarget.role ?? null,
          testId: overrides.actionTarget.testId ?? null,
          textSnippet: overrides.actionTarget.textSnippet ?? null,
        };

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
    evidenceRefs: overrides.evidenceRefs ?? [],
    hotspots: overrides.hotspots ?? [],
    actionTarget,
    element,
    context: overrides.context ?? null,
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

  return {
    root,
    elements: [element],
    bindingCandidates: [element],
  };
}

describe("buildFindingsAnalysis", () => {
  test("keeps context null for visual-cluster findings", () => {
    const analysis = buildFindingsAnalysis({
      analysisMode: "visual-clusters",
      rawRegions: [createRegion({ x: 12, y: 12, width: 6, height: 6, pixelCount: 36 })],
      domSnapshot: null,
      width: 120,
      height: 80,
    });

    expect(analysis.findings[0]?.context).toBeNull();
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
    expect(analysis.findings[0]?.context?.semantic.textLayout).toEqual(
      expect.objectContaining({
        lineCount: 1,
        wrapState: "single-line",
        hasEllipsis: false,
      }),
    );
    expect(analysis.findings[0]?.context?.semantic.computedStyle.fontSize).toBe("16px");
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
        candidateCount: 1,
        fallbackMarker: "none",
      }),
    );
    expect(analysis.findings[0]?.context?.binding.selectedCandidate.tag).toBe("button");
    expect(analysis.findings[0]?.context?.binding.anchorElement.tag).toBe("button");
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
    expect(analysis.findings[0]?.context?.binding.selectedCandidate.tag).toBe("span");
    expect(analysis.findings[0]?.context?.binding.anchorElement.tag).toBe("button");
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
        candidateCount: 1,
        fallbackMarker: "weak-overlap",
        overlapScore: 0.2,
      }),
    );
    expect(analysis.findings[0]?.context?.binding.assignmentConfidence).toBeLessThan(0.7);
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
        actionTarget: {
          selector: "section#hero > button#cta",
          tag: "button",
          role: null,
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
        actionTarget: {
          selector: "section#hero > button#cta",
          tag: "button",
          role: null,
          textSnippet: "Buy",
        },
      }),
    ];
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
            findingIds: [findingId],
            signalCodes: ["possible_capture_crop"],
          }),
          createDecisionTrace({
            axis: "final",
            code: "final_needs_human_review",
            outcome: "needs_human_review",
            strength: "high",
            reason: "Setup or rendering issues were detected.",
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
      "recapture_with_broader_scope",
      "fix_text_overflow",
    ]);
    expect(summary.safeToAutofix).toBe(false);
    expect(summary.requiresRecapture).toBe(true);
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

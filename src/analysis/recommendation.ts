import {
  DECISION_TRACE_METRIC_KEYS,
  type CompareThresholds,
  type DecisionStrength,
  type DecisionTraceMetricKey,
  type DecisionTraceReport,
  type FindingReport,
  type FindingSignalCode,
  type MetricsReport,
  type Recommendation,
  type Severity,
} from "../types/report.js";
import {
  HUMAN_REVIEW_MISMATCH_MULTIPLIER,
  STRONG_DIMENSION_ASPECT_DELTA,
  STRONG_DIMENSION_DELTA_PX,
} from "../config/defaults.js";
import type { RecommendationDecision } from "../types/internal.js";
import { maxSeverity } from "../utils/severity.js";

const MODERATE_DIMENSION_DELTA_PX = 16;
const MODERATE_DIMENSION_ASPECT_DELTA = 0.04;
const TOP_FINDINGS_COUNT = 3;
const LOCALIZED_SHARE_THRESHOLD = 0.65;
const DIFFUSE_SHARE_THRESHOLD = 0.45;
const LAYOUT_LOCALIZED_THRESHOLD = 10;
const LAYOUT_GLOBAL_THRESHOLD = 25;
const COLOR_LOCALIZED_MEAN_DELTA = 8;
const COLOR_LOCALIZED_MAX_DELTA = 20;
const COLOR_GLOBAL_MEAN_DELTA = 18;
const COLOR_GLOBAL_MAX_DELTA = 35;
const IGNORED_AREA_MEDIUM_THRESHOLD = 10;
const IGNORED_AREA_HIGH_THRESHOLD = 20;

interface DecisionContext {
  metrics: MetricsReport;
  thresholds: CompareThresholds;
  findings: FindingReport[];
  highestFindingSeverity: Severity;
  countByKind: Map<FindingReport["kind"], number>;
  countBySeverity: Map<Severity, number>;
  topFindings: FindingReport[];
  topFindingsMismatchShare: number;
  topFindingsAreaPercent: number;
  actionableFindingRatio: number;
  layoutFindingRatio: number;
  colorFindingRatio: number;
  strongDimensionMismatch: boolean;
  moderateDimensionMismatch: boolean;
  textClippingDetected: boolean;
  captureRiskSignalDetected: boolean;
  viewportRiskSignalDetected: boolean;
  anyHighCriticalLayoutFinding: boolean;
  anyMediumHighLayoutFinding: boolean;
  anyColorFinding: boolean;
  hasDomFindings: boolean;
  highCriticalFindingCount: number;
}

interface RecommendationMatrixResult {
  traces: DecisionTraceReport[];
  recommendation: Recommendation;
  severity: Severity;
  reason: string;
}

export function decideRecommendation(params: {
  metrics: MetricsReport;
  thresholds: CompareThresholds;
  findings: FindingReport[];
}): RecommendationDecision {
  const context = buildDecisionContext(params);
  const traces = buildAxisTraces(context);
  const finalDecision = finalizeRecommendation(context, traces);

  return {
    recommendation: finalDecision.recommendation,
    severity: finalDecision.severity,
    reason: finalDecision.reason,
    decisionTrace: [...finalDecision.traces, buildFinalTrace(context, traces, finalDecision)],
  };
}

function buildDecisionContext(params: {
  metrics: MetricsReport;
  thresholds: CompareThresholds;
  findings: FindingReport[];
}): DecisionContext {
  const highestFindingSeverity = maxSeverity(params.findings.map((finding) => finding.severity));
  const countByKind = new Map<FindingReport["kind"], number>();
  const countBySeverity = new Map<Severity, number>();
  const topFindings = params.findings.slice(0, TOP_FINDINGS_COUNT);
  const totalFindingMismatchPixels = params.findings.reduce(
    (sum, finding) => sum + finding.mismatchPixels,
    0,
  );
  const topFindingsMismatchPixels = topFindings.reduce(
    (sum, finding) => sum + finding.mismatchPixels,
    0,
  );

  for (const finding of params.findings) {
    countByKind.set(finding.kind, (countByKind.get(finding.kind) ?? 0) + 1);
    countBySeverity.set(finding.severity, (countBySeverity.get(finding.severity) ?? 0) + 1);
  }

  const layoutFindingCount = (countByKind.get("layout") ?? 0) + (countByKind.get("mixed") ?? 0);
  const colorFindingCount = (countByKind.get("color") ?? 0) + (countByKind.get("mixed") ?? 0);
  const findingsCount = params.findings.length;
  const hasDomFindings = params.findings.some((finding) => finding.source === "dom-element");
  const actionableFindingCount = hasDomFindings
    ? params.findings.filter((finding) => finding.actionTarget?.selector).length
    : 0;

  return {
    metrics: params.metrics,
    thresholds: params.thresholds,
    findings: params.findings,
    highestFindingSeverity,
    countByKind,
    countBySeverity,
    topFindings,
    topFindingsMismatchShare:
      totalFindingMismatchPixels === 0
        ? 0
        : Number((topFindingsMismatchPixels / totalFindingMismatchPixels).toFixed(4)),
    topFindingsAreaPercent: Number(
      topFindings.reduce((sum, finding) => sum + finding.mismatchPercentOfCanvas, 0).toFixed(4),
    ),
    actionableFindingRatio:
      hasDomFindings && findingsCount > 0
        ? Number((actionableFindingCount / findingsCount).toFixed(4))
        : 0,
    layoutFindingRatio:
      findingsCount === 0 ? 0 : Number((layoutFindingCount / findingsCount).toFixed(4)),
    colorFindingRatio:
      findingsCount === 0 ? 0 : Number((colorFindingCount / findingsCount).toFixed(4)),
    strongDimensionMismatch: hasStrongDimensionMismatch(params.metrics),
    moderateDimensionMismatch: hasModerateDimensionMismatch(params.metrics),
    textClippingDetected: params.findings.some(
      (finding) =>
        finding.code === "text_clipping" ||
        finding.signals.some((signal) => signal.code === "probable_text_clipping"),
    ),
    captureRiskSignalDetected: params.findings.some((finding) =>
      finding.signals.some((signal) => signal.code === "possible_capture_crop"),
    ),
    viewportRiskSignalDetected: params.findings.some((finding) =>
      finding.signals.some((signal) => signal.code === "possible_viewport_mismatch"),
    ),
    anyHighCriticalLayoutFinding: params.findings.some(
      (finding) =>
        (finding.kind === "layout" || finding.kind === "mixed") &&
        (finding.severity === "high" || finding.severity === "critical"),
    ),
    anyMediumHighLayoutFinding: params.findings.some(
      (finding) =>
        (finding.kind === "layout" || finding.kind === "mixed") &&
        (finding.severity === "medium" ||
          finding.severity === "high" ||
          finding.severity === "critical"),
    ),
    anyColorFinding: colorFindingCount > 0,
    hasDomFindings,
    highCriticalFindingCount:
      (countBySeverity.get("high") ?? 0) + (countBySeverity.get("critical") ?? 0),
  };
}

function buildAxisTraces(context: DecisionContext): DecisionTraceReport[] {
  const traces: DecisionTraceReport[] = [];

  for (const trace of [
    evaluateDimensionAxis(context),
    evaluateSetupCaptureRiskAxis(context),
    evaluateLayoutAxis(context),
    evaluateColorAxis(context),
    evaluatePixelAxis(context),
    evaluateFixabilityAxis(context),
  ]) {
    if (trace) {
      traces.push(trace);
    }
  }

  return traces;
}

function finalizeRecommendation(
  context: DecisionContext,
  axisTraces: DecisionTraceReport[],
): RecommendationMatrixResult {
  const traceByAxis = new Map(axisTraces.map((trace) => [trace.axis, trace]));
  const dimensionTrace = traceByAxis.get("dimension");
  const setupTrace = traceByAxis.get("setup_capture_risk");
  const layoutTrace = traceByAxis.get("layout");
  const colorTrace = traceByAxis.get("color");
  const pixelTrace = traceByAxis.get("pixel");
  const fixabilityTrace = traceByAxis.get("fixability");
  const hasLocalizedFixability = fixabilityTrace?.code === "fixability_localized_actionable";
  const hasHumanReviewOverride =
    dimensionTrace?.code === "dimension_strong_mismatch" ||
    setupTrace !== undefined ||
    (layoutTrace?.code === "layout_global_drift" && !hasLocalizedFixability) ||
    (colorTrace?.code === "color_global_drift" &&
      !context.textClippingDetected &&
      !hasLocalizedFixability) ||
    fixabilityTrace?.code === "fixability_diffuse_or_unaddressable";
  const allowsPass =
    pixelTrace?.code === "pixel_strict_pass" &&
    !context.textClippingDetected &&
    dimensionTrace === undefined &&
    setupTrace === undefined &&
    layoutTrace === undefined &&
    colorTrace === undefined &&
    fixabilityTrace === undefined;
  const allowsToleratedPass =
    pixelTrace?.code === "pixel_tolerated_pass" &&
    !context.textClippingDetected &&
    dimensionTrace === undefined &&
    setupTrace === undefined &&
    layoutTrace === undefined &&
    fixabilityTrace === undefined &&
    (colorTrace === undefined || colorTrace.code === "color_localized_drift");
  const hasRetryPressure =
    layoutTrace?.code === "layout_localized_drift" ||
    colorTrace?.code === "color_localized_drift" ||
    dimensionTrace?.code === "dimension_moderate_mismatch" ||
    context.textClippingDetected ||
    fixabilityTrace?.code === "fixability_localized_actionable";

  if (hasHumanReviewOverride) {
    return buildRecommendationResult(
      "needs_human_review",
      strongestSeverity([
        context.highestFindingSeverity,
        "high",
        strengthToSeverity(dimensionTrace?.strength ?? setupTrace?.strength ?? "high"),
      ]),
      "Human review is required because capture/setup risk or severe dimension mismatch makes the comparison unreliable.",
      axisTraces,
    );
  }

  if (allowsPass) {
    return buildRecommendationResult(
      "pass",
      strongestSeverity(["low", context.highestFindingSeverity]),
      `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%, within the strict pass threshold and no meaningful drift was detected.`,
      axisTraces,
    );
  }

  if (allowsToleratedPass) {
    return buildRecommendationResult(
      "pass_with_tolerated_differences",
      strongestSeverity(["low", context.highestFindingSeverity]),
      `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%, within the tolerated threshold and limited low-risk drift was detected.`,
      axisTraces,
    );
  }

  if (hasRetryPressure) {
    const retryStrength = strongestStrength([
      layoutTrace?.code === "layout_localized_drift" ? layoutTrace.strength : null,
      colorTrace?.code === "color_localized_drift" ? colorTrace.strength : null,
      dimensionTrace?.code === "dimension_moderate_mismatch" ? dimensionTrace.strength : null,
      context.textClippingDetected ? "medium" : null,
      fixabilityTrace?.code === "fixability_localized_actionable" ? fixabilityTrace.strength : null,
    ]);

    return buildRecommendationResult(
      "retry_fix",
      strongestSeverity([context.highestFindingSeverity, strengthToSeverity(retryStrength)]),
      `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%; localized, fixable issues were detected and should be corrected before retrying.`,
      axisTraces,
    );
  }

  return buildRecommendationResult(
    "needs_human_review",
    strongestSeverity([
      context.highestFindingSeverity,
      strengthToSeverity(
        strongestStrength([
          pixelTrace?.strength ?? null,
          layoutTrace?.strength ?? null,
          colorTrace?.strength ?? null,
          fixabilityTrace?.strength ?? null,
          "high",
        ]),
      ),
    ]),
    defaultHumanReviewReason(context, pixelTrace, layoutTrace, colorTrace, fixabilityTrace),
    axisTraces,
  );
}

function buildRecommendationResult(
  recommendation: Recommendation,
  severity: Severity,
  reason: string,
  traces: DecisionTraceReport[],
): RecommendationMatrixResult {
  return {
    recommendation,
    severity,
    reason,
    traces,
  };
}

function buildFinalTrace(
  context: DecisionContext,
  axisTraces: DecisionTraceReport[],
  result: RecommendationMatrixResult,
): DecisionTraceReport {
  const driver = selectFinalDriver(axisTraces, result.recommendation);
  const strength =
    result.recommendation === "pass"
      ? "high"
      : result.recommendation === "pass_with_tolerated_differences"
        ? "medium"
        : driver?.axis === "fixability" && driver.code === "fixability_localized_actionable"
          ? "high"
          : (driver?.strength ?? "high");

  return createTrace({
    axis: "final",
    code:
      result.recommendation === "pass"
        ? "final_pass"
        : result.recommendation === "pass_with_tolerated_differences"
          ? "final_pass_with_tolerated_differences"
          : result.recommendation === "retry_fix"
            ? "final_retry_fix"
            : "final_needs_human_review",
    outcome: result.recommendation,
    strength,
    reason: result.reason,
    findingIds: driver?.findingIds ?? [],
    signalCodes: driver?.signalCodes ?? [],
    metricKeys: driver && driver.metricKeys.length > 0 ? driver.metricKeys : ["mismatchPercent"],
  });
}

function evaluateDimensionAxis(context: DecisionContext): DecisionTraceReport | null {
  const dimensionFindings = selectFindingIds(
    context.findings.filter((finding) => finding.kind === "dimension"),
  );
  const signalCodes = collectSignalCodes(
    context.findings.filter((finding) =>
      finding.signals.some((signal) => signal.code === "possible_viewport_mismatch"),
    ),
  );

  if (context.strongDimensionMismatch) {
    return createTrace({
      axis: "dimension",
      code: "dimension_strong_mismatch",
      outcome: "needs_human_review",
      strength: "critical",
      reason: "Reference and preview dimensions diverge too much for a reliable automated verdict.",
      findingIds: dimensionFindings,
      signalCodes,
      metricKeys: ["dimensionMismatch"],
    });
  }

  if (
    context.moderateDimensionMismatch &&
    !context.captureRiskSignalDetected &&
    !context.viewportRiskSignalDetected
  ) {
    return createTrace({
      axis: "dimension",
      code: "dimension_moderate_mismatch",
      outcome: "retry_fix",
      strength: "medium",
      reason:
        "Dimension mismatch appears moderate and may be fixable if the target frame and content are correct.",
      findingIds: dimensionFindings,
      signalCodes,
      metricKeys: ["dimensionMismatch"],
    });
  }

  return null;
}

function evaluateSetupCaptureRiskAxis(context: DecisionContext): DecisionTraceReport | null {
  if (context.captureRiskSignalDetected || context.viewportRiskSignalDetected) {
    const riskyFindings = context.findings.filter((finding) =>
      finding.signals.some(
        (signal) =>
          signal.code === "possible_capture_crop" || signal.code === "possible_viewport_mismatch",
      ),
    );
    const signalCodes = collectSignalCodes(riskyFindings);

    return createTrace({
      axis: "setup_capture_risk",
      code: "setup_capture_signal_risk",
      outcome: "needs_human_review",
      strength: "high",
      reason:
        signalCodes.includes("possible_capture_crop") &&
        signalCodes.includes("possible_viewport_mismatch")
          ? "Capture risk signals indicate cropped or mismatched framing, so the comparison data is not reliable enough."
          : signalCodes.includes("possible_capture_crop")
            ? "Capture crop was detected, so the comparison data is not reliable enough for automated fixing."
            : "Viewport or frame selection appears unreliable for automated fixing.",
      findingIds: selectFindingIds(riskyFindings),
      signalCodes,
      metricKeys: signalCodes.includes("possible_viewport_mismatch")
        ? ["dimensionMismatch"]
        : ["mismatchPercent"],
    });
  }

  if (context.metrics.ignoredPercent >= IGNORED_AREA_MEDIUM_THRESHOLD) {
    if (
      context.metrics.mismatchPercent <= context.thresholds.pass &&
      context.findings.length === 0
    ) {
      return null;
    }

    const strength =
      context.metrics.ignoredPercent >= IGNORED_AREA_HIGH_THRESHOLD ? "high" : "medium";

    return createTrace({
      axis: "setup_capture_risk",
      code: "setup_ignored_area_risk",
      outcome: "needs_human_review",
      strength,
      reason: `Ignored area is ${context.metrics.ignoredPercent.toFixed(2)}%, which reduces trust in the comparison data.`,
      findingIds: [],
      signalCodes: [],
      metricKeys: ["ignoredPercent"],
    });
  }

  return null;
}

function evaluateLayoutAxis(context: DecisionContext): DecisionTraceReport | null {
  const layoutFindings = context.findings.filter(
    (finding) => finding.kind === "layout" || finding.kind === "mixed",
  );
  const relevantFindings = layoutFindings.length > 0 ? layoutFindings : context.topFindings;
  const structuralMismatchPercent = context.metrics.structuralMismatchPercent ?? 0;

  if (relevantFindings.length === 0) {
    return null;
  }

  if (
    structuralMismatchPercent >= LAYOUT_GLOBAL_THRESHOLD ||
    (context.layoutFindingRatio >= 0.5 &&
      context.topFindingsMismatchShare < 0.5 &&
      context.anyHighCriticalLayoutFinding)
  ) {
    return createTrace({
      axis: "layout",
      code: "layout_global_drift",
      outcome: "needs_human_review",
      strength: "high",
      reason:
        "Layout drift appears global rather than localized, so automated fixing is not reliable.",
      findingIds: selectFindingIds(relevantFindings),
      signalCodes: collectSignalCodes(relevantFindings),
      metricKeys: ["structuralMismatchPercent"],
    });
  }

  if (
    (structuralMismatchPercent >= LAYOUT_LOCALIZED_THRESHOLD ||
      context.anyMediumHighLayoutFinding) &&
    context.topFindingsMismatchShare >= LOCALIZED_SHARE_THRESHOLD
  ) {
    return createTrace({
      axis: "layout",
      code: "layout_localized_drift",
      outcome: "retry_fix",
      strength: "medium",
      reason: "Layout drift appears localized to a small set of findings and is likely fixable.",
      findingIds: selectFindingIds(relevantFindings),
      signalCodes: collectSignalCodes(relevantFindings),
      metricKeys: ["structuralMismatchPercent"],
    });
  }

  return null;
}

function evaluateColorAxis(context: DecisionContext): DecisionTraceReport | null {
  if (!context.anyColorFinding) {
    return null;
  }

  const colorFindings = context.findings.filter(
    (finding) => finding.kind === "color" || finding.kind === "mixed",
  );
  const meanColorDelta = context.metrics.meanColorDelta ?? 0;
  const maxColorDelta = context.metrics.maxColorDelta ?? 0;

  if (
    (meanColorDelta >= COLOR_GLOBAL_MEAN_DELTA || maxColorDelta >= COLOR_GLOBAL_MAX_DELTA) &&
    context.colorFindingRatio >= 0.5 &&
    context.topFindingsMismatchShare < 0.5
  ) {
    return createTrace({
      axis: "color",
      code: "color_global_drift",
      outcome: "needs_human_review",
      strength: "high",
      reason:
        "Color or style drift appears global rather than localized, so automated fixing is not reliable.",
      findingIds: selectFindingIds(colorFindings),
      signalCodes: collectSignalCodes(colorFindings),
      metricKeys: ["meanColorDelta", "maxColorDelta"],
    });
  }

  if (
    (meanColorDelta >= COLOR_LOCALIZED_MEAN_DELTA || maxColorDelta >= COLOR_LOCALIZED_MAX_DELTA) &&
    context.topFindingsMismatchShare >= LOCALIZED_SHARE_THRESHOLD
  ) {
    return createTrace({
      axis: "color",
      code: "color_localized_drift",
      outcome: "retry_fix",
      strength: "medium",
      reason:
        "Color or style drift appears localized to a small set of findings and is likely fixable.",
      findingIds: selectFindingIds(colorFindings),
      signalCodes: collectSignalCodes(colorFindings),
      metricKeys: ["meanColorDelta", "maxColorDelta"],
    });
  }

  return null;
}

function evaluatePixelAxis(context: DecisionContext): DecisionTraceReport | null {
  if (context.metrics.mismatchPercent <= context.thresholds.pass) {
    return createTrace({
      axis: "pixel",
      code: "pixel_strict_pass",
      outcome: "pass",
      strength: "low",
      reason: `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%, within the strict pass threshold.`,
      findingIds: selectFindingIds(context.topFindings),
      signalCodes: collectSignalCodes(context.topFindings),
      metricKeys: ["mismatchPercent"],
    });
  }

  if (context.metrics.mismatchPercent <= context.thresholds.tolerated) {
    return createTrace({
      axis: "pixel",
      code: "pixel_tolerated_pass",
      outcome: "pass_with_tolerated_differences",
      strength: "low",
      reason: `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%, within the tolerated threshold.`,
      findingIds: selectFindingIds(context.topFindings),
      signalCodes: collectSignalCodes(context.topFindings),
      metricKeys: ["mismatchPercent"],
    });
  }

  if (context.metrics.mismatchPercent <= context.thresholds.retry) {
    return createTrace({
      axis: "pixel",
      code: "pixel_retry_range",
      outcome: "retry_fix",
      strength: "medium",
      reason: `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%, which remains in the retry-fix range.`,
      findingIds: selectFindingIds(context.topFindings),
      signalCodes: collectSignalCodes(context.topFindings),
      metricKeys: ["mismatchPercent"],
    });
  }

  if (
    context.metrics.mismatchPercent >
    context.thresholds.retry * HUMAN_REVIEW_MISMATCH_MULTIPLIER
  ) {
    return createTrace({
      axis: "pixel",
      code: "pixel_exceeds_retry_range",
      outcome: "needs_human_review",
      strength: "high",
      reason: `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%, which is too large for a reliable automated retry.`,
      findingIds: selectFindingIds(context.topFindings),
      signalCodes: collectSignalCodes(context.topFindings),
      metricKeys: ["mismatchPercent"],
    });
  }

  return null;
}

function evaluateFixabilityAxis(context: DecisionContext): DecisionTraceReport | null {
  if (context.findings.length === 0) {
    return null;
  }

  const hasMeaningfulRetryPressure =
    context.metrics.mismatchPercent > context.thresholds.tolerated ||
    context.highestFindingSeverity !== "low" ||
    context.textClippingDetected;

  if (
    hasMeaningfulRetryPressure &&
    context.topFindingsMismatchShare >= LOCALIZED_SHARE_THRESHOLD &&
    ((context.hasDomFindings && context.actionableFindingRatio >= 0.5) ||
      (!context.hasDomFindings && context.topFindingsAreaPercent <= context.thresholds.retry))
  ) {
    return createTrace({
      axis: "fixability",
      code: "fixability_localized_actionable",
      outcome: "retry_fix",
      strength: "high",
      reason:
        "The dominant findings are concentrated and actionable enough for another automated fix attempt.",
      findingIds: selectFindingIds(context.topFindings),
      signalCodes: collectSignalCodes(context.topFindings),
      metricKeys: ["mismatchPercent"],
    });
  }

  if (
    context.topFindingsMismatchShare < DIFFUSE_SHARE_THRESHOLD ||
    (context.hasDomFindings && context.actionableFindingRatio === 0) ||
    context.highCriticalFindingCount >= 3
  ) {
    return createTrace({
      axis: "fixability",
      code: "fixability_diffuse_or_unaddressable",
      outcome: "needs_human_review",
      strength: "high",
      reason:
        context.topFindingsMismatchShare < DIFFUSE_SHARE_THRESHOLD
          ? "Mismatch is diffuse across too many findings for a reliable automated retry."
          : context.hasDomFindings && context.actionableFindingRatio === 0
            ? "Findings are not addressable to concrete DOM targets, so automated fixing is not reliable."
            : "Too many high-severity findings were detected for a reliable automated retry.",
      findingIds: selectFindingIds(context.topFindings),
      signalCodes: collectSignalCodes(context.topFindings),
      metricKeys: ["mismatchPercent"],
    });
  }

  return null;
}

function defaultHumanReviewReason(
  context: DecisionContext,
  pixelTrace: DecisionTraceReport | undefined,
  layoutTrace: DecisionTraceReport | undefined,
  colorTrace: DecisionTraceReport | undefined,
  fixabilityTrace: DecisionTraceReport | undefined,
): string {
  if (layoutTrace?.code === "layout_global_drift") {
    return layoutTrace.reason;
  }

  if (colorTrace?.code === "color_global_drift") {
    return colorTrace.reason;
  }

  if (fixabilityTrace?.code === "fixability_diffuse_or_unaddressable") {
    return fixabilityTrace.reason;
  }

  if (pixelTrace?.code === "pixel_exceeds_retry_range") {
    return pixelTrace.reason;
  }

  return `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}% and the available evidence is not strong enough for a reliable automated retry.`;
}

function selectFinalDriver(
  traces: DecisionTraceReport[],
  recommendation: Recommendation,
): DecisionTraceReport | null {
  const relevant = traces.filter((trace) => trace.outcome === recommendation);

  if (relevant.length === 0) {
    return null;
  }

  return relevant.reduce((current, candidate) =>
    compareStrength(candidate.strength, current.strength) > 0 ? candidate : current,
  );
}

function selectFindingIds(findings: FindingReport[]): string[] {
  return findings.slice(0, TOP_FINDINGS_COUNT).map((finding) => finding.id);
}

function collectSignalCodes(findings: FindingReport[]): FindingSignalCode[] {
  return sortSignalCodes(
    findings.flatMap((finding) => finding.signals.map((signal) => signal.code)),
  );
}

function createTrace(params: {
  axis: DecisionTraceReport["axis"];
  code: DecisionTraceReport["code"];
  outcome: Recommendation;
  strength: DecisionStrength;
  reason: string;
  findingIds: string[];
  signalCodes: FindingSignalCode[];
  metricKeys: DecisionTraceMetricKey[];
}): DecisionTraceReport {
  return {
    axis: params.axis,
    code: params.code,
    outcome: params.outcome,
    strength: params.strength,
    reason: params.reason,
    findingIds: [...new Set(params.findingIds)],
    signalCodes: sortSignalCodes(params.signalCodes),
    metricKeys: sortMetricKeys(params.metricKeys),
  };
}

function hasStrongDimensionMismatch(metrics: MetricsReport): boolean {
  return (
    metrics.dimensionMismatch.hasMismatch &&
    (Math.abs(metrics.dimensionMismatch.widthDelta) >= STRONG_DIMENSION_DELTA_PX ||
      Math.abs(metrics.dimensionMismatch.heightDelta) >= STRONG_DIMENSION_DELTA_PX ||
      metrics.dimensionMismatch.aspectRatioDelta >= STRONG_DIMENSION_ASPECT_DELTA)
  );
}

function hasModerateDimensionMismatch(metrics: MetricsReport): boolean {
  return (
    metrics.dimensionMismatch.hasMismatch &&
    (Math.abs(metrics.dimensionMismatch.widthDelta) >= MODERATE_DIMENSION_DELTA_PX ||
      Math.abs(metrics.dimensionMismatch.heightDelta) >= MODERATE_DIMENSION_DELTA_PX ||
      metrics.dimensionMismatch.aspectRatioDelta >= MODERATE_DIMENSION_ASPECT_DELTA)
  );
}

function strongestSeverity(values: Severity[]): Severity {
  return maxSeverity(values);
}

function strengthToSeverity(strength: DecisionStrength): Severity {
  switch (strength) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
    default:
      return "low";
  }
}

function strongestStrength(values: Array<DecisionStrength | null>): DecisionStrength {
  return values.reduce<DecisionStrength>((current, candidate) => {
    if (!candidate) {
      return current;
    }

    return compareStrength(candidate, current) > 0 ? candidate : current;
  }, "low");
}

function compareStrength(left: DecisionStrength, right: DecisionStrength): number {
  return strengthRank(left) - strengthRank(right);
}

function strengthRank(value: DecisionStrength): number {
  switch (value) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "medium":
      return 1;
    case "low":
    default:
      return 0;
  }
}

function sortSignalCodes(values: FindingSignalCode[]): FindingSignalCode[] {
  const order = new Map<FindingSignalCode, number>([
    ["probable_text_clipping", 0],
    ["possible_capture_crop", 1],
    ["possible_viewport_mismatch", 2],
  ]);

  return [...new Set(values)].sort((left, right) => {
    const leftIndex = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right) ?? Number.MAX_SAFE_INTEGER;

    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.localeCompare(right);
  });
}

function sortMetricKeys(values: DecisionTraceMetricKey[]): DecisionTraceMetricKey[] {
  const order = new Map(
    DECISION_TRACE_METRIC_KEYS.map((metricKey, index) => [metricKey, index] as const),
  );

  return [...new Set(values)].sort((left, right) => {
    const leftIndex = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right) ?? Number.MAX_SAFE_INTEGER;

    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.localeCompare(right);
  });
}

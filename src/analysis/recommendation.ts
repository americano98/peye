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
import { hasMeaningfulGeometryDrift } from "./geometry.js";
import { hasMeaningfulSiblingRelationDrift } from "./relations.js";
import {
  hasMeaningfulTextValidation,
  hasStrongTextValidation,
  isTextOverflowValidation,
} from "./text-validation.js";
import type { RecommendationDecision } from "../types/internal.js";
import { maxSeverity } from "../utils/severity.js";

const MODERATE_DIMENSION_DELTA_PX = 16;
const MODERATE_DIMENSION_ASPECT_DELTA = 0.04;
const TOP_FINDINGS_COUNT = 3;
const LOCALIZED_SHARE_THRESHOLD = 0.65;
const DIFFUSE_SHARE_THRESHOLD = 0.3;
const LAYOUT_LOCALIZED_THRESHOLD = 10;
const LAYOUT_GLOBAL_THRESHOLD = 25;
const COLOR_LOCALIZED_MEAN_DELTA = 8;
const COLOR_LOCALIZED_MAX_DELTA = 20;
const COLOR_GLOBAL_MEAN_DELTA = 18;
const COLOR_GLOBAL_MAX_DELTA = 35;
const IGNORED_AREA_MEDIUM_THRESHOLD = 25;
const IGNORED_AREA_HIGH_THRESHOLD = 35;

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
  meaningfulGeometryFindingCount: number;
  meaningfulSiblingRelationFindingCount: number;
  layoutEvidenceFindingCount: number;
  topFindingsHaveLayoutEvidence: boolean;
  textValidatedFindingCount: number;
  strongTextFindingCount: number;
  textOverflowFindingCount: number;
  topFindingsHaveTextEvidence: boolean;
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
    ? params.findings.filter((finding) => finding.element?.selector).length
    : 0;
  const meaningfulGeometryFindingCount = params.findings.filter((finding) =>
    hasMeaningfulGeometryDrift(finding.geometry),
  ).length;
  const meaningfulSiblingRelationFindingCount = params.findings.filter((finding) =>
    hasMeaningfulSiblingRelationDrift(finding.siblingRelation),
  ).length;
  const layoutEvidenceFindingCount =
    meaningfulGeometryFindingCount + meaningfulSiblingRelationFindingCount;
  const textValidatedFindingCount = params.findings.filter((finding) =>
    hasMeaningfulTextValidation(finding.textValidation),
  ).length;
  const strongTextFindingCount = params.findings.filter((finding) =>
    hasStrongTextValidation(finding.textValidation),
  ).length;
  const textOverflowFindingCount = params.findings.filter((finding) =>
    isTextOverflowValidation(finding.textValidation),
  ).length;

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
    meaningfulGeometryFindingCount,
    meaningfulSiblingRelationFindingCount,
    layoutEvidenceFindingCount,
    topFindingsHaveLayoutEvidence: topFindings.some(
      (finding) =>
        hasMeaningfulGeometryDrift(finding.geometry) ||
        hasMeaningfulSiblingRelationDrift(finding.siblingRelation),
    ),
    textValidatedFindingCount,
    strongTextFindingCount,
    textOverflowFindingCount,
    topFindingsHaveTextEvidence: topFindings.some((finding) =>
      hasMeaningfulTextValidation(finding.textValidation),
    ),
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
  const sanityCheckTrace =
    setupTrace?.code === "setup_capture_signal_risk" ? setupTrace : undefined;
  const ignoredAreaTrace = setupTrace?.code === "setup_ignored_area_risk" ? setupTrace : undefined;
  const hasBroadRetryPressure =
    layoutTrace?.code === "layout_global_drift" ||
    colorTrace?.code === "color_global_drift" ||
    fixabilityTrace?.code === "fixability_diffuse_or_unaddressable";
  const hasHumanReviewOverride =
    dimensionTrace?.code === "dimension_strong_mismatch" || ignoredAreaTrace !== undefined;
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
    layoutTrace?.code === "layout_global_drift" ||
    colorTrace?.code === "color_localized_drift" ||
    colorTrace?.code === "color_global_drift" ||
    dimensionTrace?.code === "dimension_moderate_mismatch" ||
    context.textClippingDetected ||
    fixabilityTrace?.code === "fixability_localized_actionable" ||
    fixabilityTrace?.code === "fixability_diffuse_or_unaddressable" ||
    (pixelTrace?.code === "pixel_retry_range" && context.findings.length > 0) ||
    sanityCheckTrace !== undefined;

  if (hasHumanReviewOverride) {
    return buildRecommendationResult(
      "needs_human_review",
      strongestSeverity([
        context.highestFindingSeverity,
        "high",
        strengthToSeverity(dimensionTrace?.strength ?? setupTrace?.strength ?? "high"),
      ]),
      humanReviewOverrideReason(dimensionTrace, setupTrace),
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
      sanityCheckTrace
        ? sanityCheckTrace.reason
        : context.textOverflowFindingCount > 0
          ? `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%; localized text blocks show regression and should be corrected before retrying.`
          : context.topFindingsHaveTextEvidence
            ? `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%; localized text blocks differ from the reference and should be corrected before retrying.`
            : hasBroadRetryPressure
              ? `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%; broad or diffuse issues were detected, but no hard-stop setup risk was found, so another automated fix attempt is still warranted.`
              : `Mismatch is ${context.metrics.mismatchPercent.toFixed(2)}%; localized, fixable issues were detected and should be corrected before retrying.`,
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

    const concreteTextEvidence =
      !context.captureRiskSignalDetected &&
      context.viewportRiskSignalDetected &&
      context.strongTextFindingCount >= 2;

    return createTrace({
      axis: "setup_capture_risk",
      code: "setup_capture_signal_risk",
      outcome: "retry_fix",
      strength: concreteTextEvidence ? "low" : "high",
      reason: concreteTextEvidence
        ? "Viewport or frame mismatch signals are present, but multiple concrete text findings were localized; treat setup risk as secondary until those text regressions are checked."
        : signalCodes.includes("possible_capture_crop") &&
            signalCodes.includes("possible_viewport_mismatch")
          ? "Run a sanity check to confirm the preview and reference depict the same target; if they do, continue automated fixes despite cropped or mismatched framing signals."
          : signalCodes.includes("possible_capture_crop")
            ? "Run a sanity check to confirm the preview and reference depict the same target before fixing; capture crop was detected."
            : "Run a sanity check to confirm the preview and reference depict the same target before fixing; viewport or frame selection appears mismatched.",
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
  const evidenceFindings = context.findings.filter(
    (finding) =>
      hasMeaningfulGeometryDrift(finding.geometry) ||
      hasMeaningfulSiblingRelationDrift(finding.siblingRelation),
  );
  const relevantFindings =
    layoutFindings.length > 0
      ? layoutFindings
      : evidenceFindings.length > 0
        ? evidenceFindings
        : context.topFindings;
  const structuralMismatchPercent = context.metrics.structuralMismatchPercent ?? 0;

  if (relevantFindings.length === 0) {
    return null;
  }

  if (
    structuralMismatchPercent >= LAYOUT_GLOBAL_THRESHOLD ||
    (context.layoutFindingRatio >= 0.5 &&
      context.topFindingsMismatchShare < 0.5 &&
      context.anyHighCriticalLayoutFinding) ||
    (context.layoutEvidenceFindingCount >= 4 &&
      context.topFindingsMismatchShare < DIFFUSE_SHARE_THRESHOLD)
  ) {
    return createTrace({
      axis: "layout",
      code: "layout_global_drift",
      outcome: "retry_fix",
      strength: "high",
      reason: context.topFindingsHaveTextEvidence
        ? "Text block drift appears across multiple localized findings, so fixing may require coordinated text and layout adjustments."
        : context.meaningfulSiblingRelationFindingCount > 0
          ? "Spacing or alignment drift appears across multiple localized groups, so fixing may require multiple coordinated passes."
          : context.meaningfulGeometryFindingCount > 0
            ? "Position or size drift appears across multiple localized groups, so fixing may require multiple coordinated passes."
            : "Layout drift appears broad rather than localized, so fixing may require multiple automated passes.",
      findingIds: selectFindingIds(relevantFindings),
      signalCodes: collectSignalCodes(relevantFindings),
      metricKeys: ["structuralMismatchPercent"],
    });
  }

  if (
    (structuralMismatchPercent >= LAYOUT_LOCALIZED_THRESHOLD ||
      context.anyMediumHighLayoutFinding ||
      context.topFindingsHaveLayoutEvidence) &&
    context.topFindingsMismatchShare >= LOCALIZED_SHARE_THRESHOLD
  ) {
    return createTrace({
      axis: "layout",
      code: "layout_localized_drift",
      outcome: "retry_fix",
      strength: "medium",
      reason: context.topFindingsHaveTextEvidence
        ? "Text block behavior appears localized to a small set of findings and is likely fixable."
        : context.meaningfulSiblingRelationFindingCount > 0
          ? "Spacing or alignment drift appears localized to a small set of neighboring groups and is likely fixable."
          : context.meaningfulGeometryFindingCount > 0
            ? "Position or size drift appears localized to a small set of groups and is likely fixable."
            : "Layout drift appears localized to a small set of findings and is likely fixable.",
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
      outcome: "retry_fix",
      strength: "high",
      reason:
        "Color or style drift appears broad rather than localized, so fixing may require multiple automated passes.",
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
        context.textOverflowFindingCount > 0
          ? "The dominant findings are concentrated on concrete text blocks with overflow evidence, so another automated typography fix attempt is well-scoped."
          : context.topFindingsHaveTextEvidence
            ? "The dominant findings are concentrated on concrete text blocks with usable text evidence, so another automated fix attempt is well-scoped."
            : context.topFindingsHaveLayoutEvidence
              ? "The dominant findings are concentrated on concrete DOM groups with usable geometry or sibling-spacing evidence, so another automated fix attempt is well-scoped."
              : "The dominant findings are concentrated and actionable enough for another automated fix attempt.",
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
      outcome: "retry_fix",
      strength: "high",
      reason:
        context.topFindingsMismatchShare < DIFFUSE_SHARE_THRESHOLD
          ? "Mismatch is diffuse across many findings, so automated fixing may require multiple broad passes."
          : context.hasDomFindings && context.actionableFindingRatio === 0
            ? "Findings are not addressable to concrete DOM targets, but another automated pass may still help before escalation."
            : "Many high-severity findings were detected, but another automated pass is still warranted before escalation.",
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

function humanReviewOverrideReason(
  dimensionTrace: DecisionTraceReport | undefined,
  setupTrace: DecisionTraceReport | undefined,
): string {
  if (setupTrace && dimensionTrace?.code === "dimension_strong_mismatch") {
    return `${setupTrace.reason} Reference and preview dimensions also diverge too much for a reliable automated verdict.`;
  }

  if (setupTrace) {
    return setupTrace.reason;
  }

  if (dimensionTrace?.code === "dimension_strong_mismatch") {
    return dimensionTrace.reason;
  }

  return "Human review is required because capture/setup risk or severe dimension mismatch makes the comparison unreliable.";
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

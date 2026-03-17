import {
  HUMAN_REVIEW_MISMATCH_MULTIPLIER,
  STRONG_DIMENSION_ASPECT_DELTA,
  STRONG_DIMENSION_DELTA_PX,
} from "../config/defaults.js";
import type { RecommendationDecision } from "../types/internal.js";
import type { FindingReport, MetricsReport } from "../types/report.js";
import { maxSeverity } from "../utils/severity.js";

export function decideRecommendation(params: {
  metrics: MetricsReport;
  thresholds: { pass: number; tolerated: number; retry: number };
  findings: FindingReport[];
}): RecommendationDecision {
  const { metrics, thresholds, findings } = params;
  const highestFindingSeverity = maxSeverity(findings.map((finding) => finding.severity));
  const strongDimensionMismatch = hasStrongDimensionMismatch(metrics);

  if (
    strongDimensionMismatch ||
    metrics.mismatchPercent > thresholds.retry * HUMAN_REVIEW_MISMATCH_MULTIPLIER
  ) {
    return {
      recommendation: "needs_human_review",
      severity: maxSeverity([
        highestFindingSeverity,
        strongDimensionMismatch ? "critical" : "high",
      ]),
      reason: strongDimensionMismatch
        ? "Reference and preview dimensions diverge too much for a reliable automated verdict."
        : `Mismatch percentage ${metrics.mismatchPercent.toFixed(2)}% is too large for an automated fix recommendation.`,
    };
  }

  if (metrics.mismatchPercent <= thresholds.pass && highestFindingSeverity === "low") {
    return {
      recommendation: "pass",
      severity: "low",
      reason: `Mismatch is ${metrics.mismatchPercent.toFixed(2)}%, within the strict pass threshold.`,
    };
  }

  if (metrics.mismatchPercent <= thresholds.tolerated && highestFindingSeverity === "low") {
    return {
      recommendation: "pass_with_tolerated_differences",
      severity: "low",
      reason: `Mismatch is ${metrics.mismatchPercent.toFixed(2)}%, within the tolerated threshold.`,
    };
  }

  if (
    metrics.mismatchPercent <= thresholds.retry ||
    highestFindingSeverity === "medium" ||
    highestFindingSeverity === "high"
  ) {
    return {
      recommendation: "retry_fix",
      severity: highestFindingSeverity === "critical" ? "high" : highestFindingSeverity,
      reason: `Mismatch is ${metrics.mismatchPercent.toFixed(2)}%; localized issues were detected and should be fixed before retrying.`,
    };
  }

  return {
    recommendation: "needs_human_review",
    severity: maxSeverity([highestFindingSeverity, "high"]),
    reason: `Mismatch is ${metrics.mismatchPercent.toFixed(2)}% and exceeds the retry threshold.`,
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

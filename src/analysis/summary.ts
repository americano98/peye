import type { RecommendationDecision } from "../types/internal.js";
import {
  FINDING_SIGNAL_CODES,
  type AnalysisMode,
  type DecisionStrength,
  type DecisionTraceReport,
  type ErrorReport,
  type FindingCode,
  type FindingReport,
  type FindingSignalCode,
  type Recommendation,
  type RootCauseCode,
  type Severity,
  type SummaryActionCode,
  type SummaryActionReport,
  type SummaryReport,
  type SummaryRootCauseReport,
} from "../types/report.js";
import { compareSeverityDescending } from "../utils/severity.js";

export type FailureOrigin = "preview" | "reference" | "unknown";

interface RootCauseCandidateInternal extends SummaryRootCauseReport {
  highestSeverity: Severity;
}

interface ActionCandidateInternal extends SummaryActionReport {
  highestSeverity: Severity;
}

const ROOT_CAUSE_REASONS: Record<RootCauseCode, string> = {
  text_overflow: "Text appears clipped inside the affected element.",
  capture_scope_too_tight: "The preview capture appears cropped at the target boundary.",
  viewport_or_reference_mismatch:
    "Viewport or frame selection appears inconsistent with the intended target.",
  missing_or_extra_content:
    "The preview and reference disagree on content presence or frame extent.",
  layout_displacement: "Mismatch signals indicate layout displacement.",
  visual_style_drift: "Mismatch signals indicate a style or color drift.",
  rendering_drift: "Mismatch signals indicate fine-grained rendering drift.",
  preview_input_or_runtime_error: "The preview input or browser capture failed before comparison.",
  reference_input_or_acquisition_error:
    "The reference input or Figma acquisition failed before comparison.",
};

const ACTION_REASONS: Record<SummaryActionCode, string> = {
  fix_text_overflow: "Fix text overflow, line clamp, or available width.",
  fix_layout_styles: "Fix layout positioning, spacing, or alignment.",
  fix_visual_styles: "Fix visual styling drift.",
  verify_missing_or_extra_content:
    "Verify the target content and frame, then fix missing or extra UI.",
  recapture_with_broader_scope: "Recapture with a broader selector scope or viewport.",
  verify_viewport_or_reference: "Verify viewport, selected frame, and capture target.",
  fix_preview_setup: "Fix the preview input or capture environment.",
  fix_reference_setup: "Fix the reference input or acquisition setup.",
};

const FINDING_TO_ROOT_CAUSES: Record<FindingCode, RootCauseCode[]> = {
  text_clipping: ["text_overflow"],
  capture_crop: ["capture_scope_too_tight"],
  viewport_mismatch: ["viewport_or_reference_mismatch"],
  missing_or_extra_content: ["missing_or_extra_content"],
  layout_mismatch: ["layout_displacement"],
  style_mismatch: ["visual_style_drift"],
  rendering_mismatch: ["rendering_drift"],
  layout_style_mismatch: ["layout_displacement", "visual_style_drift"],
};

const SIGNAL_TO_ROOT_CAUSES: Record<FindingSignalCode, RootCauseCode> = {
  probable_text_clipping: "text_overflow",
  possible_capture_crop: "capture_scope_too_tight",
  possible_viewport_mismatch: "viewport_or_reference_mismatch",
};

const ROOT_CAUSE_TO_ACTION: Record<RootCauseCode, SummaryActionCode> = {
  text_overflow: "fix_text_overflow",
  capture_scope_too_tight: "recapture_with_broader_scope",
  viewport_or_reference_mismatch: "verify_viewport_or_reference",
  missing_or_extra_content: "verify_missing_or_extra_content",
  layout_displacement: "fix_layout_styles",
  visual_style_drift: "fix_visual_styles",
  rendering_drift: "fix_visual_styles",
  preview_input_or_runtime_error: "fix_preview_setup",
  reference_input_or_acquisition_error: "fix_reference_setup",
};

export function buildSummaryReport(params: {
  baseDecision: RecommendationDecision;
  findings: FindingReport[];
  analysisMode: AnalysisMode;
  omittedFindings: number;
  error: ErrorReport | null;
  failureOrigin?: FailureOrigin;
}): SummaryReport {
  const findingOrder = new Map(params.findings.map((finding, index) => [finding.id, index]));
  const decisionTrace = normalizeDecisionTrace({
    baseDecision: params.baseDecision,
    error: params.error,
    failureOrigin: params.failureOrigin,
  });
  const rootCauseCandidates = buildRootCauseCandidates({
    findings: params.findings,
    decisionTrace,
    findingOrder,
    error: params.error,
    failureOrigin: params.failureOrigin,
    fallbackSeverity: params.baseDecision.severity,
  });
  const topActions = buildTopActions(rootCauseCandidates, findingOrder);
  const limitedRootCauseCandidates = rootCauseCandidates
    .slice(0, 3)
    .map(({ highestSeverity: _highestSeverity, ...candidate }) => candidate);
  const limitedTopActions = topActions
    .slice(0, 3)
    .map(({ highestSeverity: _highestSeverity, ...action }) => action);
  const requiresRecapture =
    params.error !== null || decisionTrace.some((trace) => trace.axis === "setup_capture_risk");
  const safeToAutofix = canSafelyAutofix({
    recommendation: params.baseDecision.recommendation,
    error: params.error,
    requiresRecapture,
    topActions: limitedTopActions,
    findings: params.findings,
  });

  return {
    recommendation: params.baseDecision.recommendation,
    severity: params.baseDecision.severity,
    reason: decisionTrace.at(-1)?.reason ?? params.baseDecision.reason,
    decisionTrace,
    topActions: limitedTopActions,
    rootCauseCandidates: limitedRootCauseCandidates,
    overallConfidence: buildOverallConfidence({
      recommendation: params.baseDecision.recommendation,
      decisionTrace,
      analysisMode: params.analysisMode,
      omittedFindings: params.omittedFindings,
    }),
    safeToAutofix,
    requiresRecapture,
  };
}

function normalizeDecisionTrace(params: {
  baseDecision: RecommendationDecision;
  error: ErrorReport | null;
  failureOrigin: FailureOrigin | undefined;
}): DecisionTraceReport[] {
  const axisTraces = params.baseDecision.decisionTrace.filter((trace) => trace.axis !== "final");
  const finalTrace = params.baseDecision.decisionTrace.find((trace) => trace.axis === "final");

  if (finalTrace) {
    return [...axisTraces, finalTrace];
  }

  if (!params.error) {
    return axisTraces;
  }

  const syntheticAxisTrace = buildSyntheticFailureAxisTrace(
    params.error,
    params.baseDecision,
    params.failureOrigin ?? "unknown",
  );
  const traces = syntheticAxisTrace ? [syntheticAxisTrace] : [];

  return [...traces, buildSyntheticFailureFinalTrace(params.baseDecision, syntheticAxisTrace)];
}

function buildSyntheticFailureAxisTrace(
  error: ErrorReport,
  baseDecision: RecommendationDecision,
  failureOrigin: FailureOrigin,
): DecisionTraceReport | null {
  if (failureOrigin === "reference") {
    return null;
  }

  return {
    axis: "setup_capture_risk",
    code: "setup_capture_signal_risk",
    outcome: baseDecision.recommendation,
    strength: error.exitCode === 1 ? "medium" : "high",
    reason: error.message,
    findingIds: [],
    signalCodes: [],
    metricKeys: [],
  };
}

function buildSyntheticFailureFinalTrace(
  baseDecision: RecommendationDecision,
  syntheticAxisTrace: DecisionTraceReport | null,
): DecisionTraceReport {
  return {
    axis: "final",
    code:
      baseDecision.recommendation === "pass"
        ? "final_pass"
        : baseDecision.recommendation === "pass_with_tolerated_differences"
          ? "final_pass_with_tolerated_differences"
          : baseDecision.recommendation === "retry_fix"
            ? "final_retry_fix"
            : "final_needs_human_review",
    outcome: baseDecision.recommendation,
    strength: syntheticAxisTrace?.strength ?? severityToDecisionStrength(baseDecision.severity),
    reason: baseDecision.reason,
    findingIds: syntheticAxisTrace?.findingIds ?? [],
    signalCodes: syntheticAxisTrace?.signalCodes ?? [],
    metricKeys: syntheticAxisTrace?.metricKeys ?? [],
  };
}

function buildRootCauseCandidates(params: {
  findings: FindingReport[];
  decisionTrace: DecisionTraceReport[];
  findingOrder: Map<string, number>;
  error: ErrorReport | null;
  failureOrigin: FailureOrigin | undefined;
  fallbackSeverity: Severity;
}): RootCauseCandidateInternal[] {
  const candidates = new Map<RootCauseCode, RootCauseCandidateInternal>();

  mergeRootCauseCandidates(
    candidates,
    buildFindingRootCauseCandidates(params.findings, params.findingOrder),
    params.findingOrder,
  );
  if (!params.error) {
    mergeRootCauseCandidates(
      candidates,
      buildTraceRootCauseCandidates(params.decisionTrace),
      params.findingOrder,
    );
  }

  if (params.error) {
    mergeRootCauseCandidates(
      candidates,
      buildFailureRootCauseCandidates(params.fallbackSeverity, params.error, params.failureOrigin),
      params.findingOrder,
    );
  }

  return Array.from(candidates.values()).sort(compareRankedCandidates);
}

function buildFindingRootCauseCandidates(
  findings: FindingReport[],
  findingOrder: Map<string, number>,
): RootCauseCandidateInternal[] {
  const candidates = new Map<RootCauseCode, RootCauseCandidateInternal>();

  for (const finding of findings) {
    const rootCauseCodes = new Set<RootCauseCode>(FINDING_TO_ROOT_CAUSES[finding.code]);

    for (const signal of finding.signals) {
      rootCauseCodes.add(SIGNAL_TO_ROOT_CAUSES[signal.code]);
    }

    for (const code of rootCauseCodes) {
      const existing = candidates.get(code);

      if (existing) {
        existing.confidence = Math.max(existing.confidence, finding.confidence);
        existing.highestSeverity = moreSevere(existing.highestSeverity, finding.severity);
        existing.findingIds = mergeFindingIds(existing.findingIds, [finding.id], findingOrder);
        existing.signalCodes = mergeSignalCodes(existing.signalCodes, finding.signals);
        continue;
      }

      candidates.set(code, {
        code,
        confidence: finding.confidence,
        reason: ROOT_CAUSE_REASONS[code],
        findingIds: [finding.id],
        signalCodes: sortSignalCodes(finding.signals.map((signal) => signal.code)),
        highestSeverity: finding.severity,
      });
    }
  }

  return Array.from(candidates.values());
}

function buildTraceRootCauseCandidates(
  decisionTrace: DecisionTraceReport[],
): RootCauseCandidateInternal[] {
  const candidates: RootCauseCandidateInternal[] = [];
  const finalOutcome = decisionTrace.find((trace) => trace.axis === "final")?.outcome ?? null;

  for (const trace of decisionTrace) {
    for (const code of rootCauseCodesForTrace(trace, finalOutcome)) {
      candidates.push({
        code,
        confidence: candidateConfidenceForDecisionStrength(trace.strength),
        reason: ROOT_CAUSE_REASONS[code],
        findingIds: [...trace.findingIds],
        signalCodes: [...trace.signalCodes],
        highestSeverity: strengthToSeverity(trace.strength),
      });
    }
  }

  return candidates;
}

function buildFailureRootCauseCandidates(
  severity: Severity,
  error: ErrorReport,
  failureOrigin: FailureOrigin = "unknown",
): RootCauseCandidateInternal[] {
  const code = classifyFailureRootCause(error.code, failureOrigin);
  const confidence = failureOrigin === "unknown" ? 0.9 : 0.95;

  return [
    {
      code,
      confidence,
      reason: ROOT_CAUSE_REASONS[code],
      findingIds: [],
      signalCodes: [],
      highestSeverity: severity,
    },
  ];
}

function buildTopActions(
  rootCauseCandidates: RootCauseCandidateInternal[],
  findingOrder: Map<string, number>,
): ActionCandidateInternal[] {
  const actions = new Map<SummaryActionCode, ActionCandidateInternal>();

  for (const candidate of rootCauseCandidates) {
    const code = ROOT_CAUSE_TO_ACTION[candidate.code];
    const existing = actions.get(code);

    if (existing) {
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      existing.highestSeverity = moreSevere(existing.highestSeverity, candidate.highestSeverity);
      existing.findingIds = mergeFindingIds(
        existing.findingIds,
        candidate.findingIds,
        findingOrder,
      );
      continue;
    }

    actions.set(code, {
      code,
      confidence: candidate.confidence,
      reason: ACTION_REASONS[code],
      findingIds: [...candidate.findingIds],
      highestSeverity: candidate.highestSeverity,
    });
  }

  return Array.from(actions.values()).sort(compareRankedCandidates);
}

function rootCauseCodesForTrace(
  trace: DecisionTraceReport,
  finalOutcome: Recommendation | null,
): RootCauseCode[] {
  switch (trace.code) {
    case "dimension_moderate_mismatch":
    case "dimension_strong_mismatch":
      return trace.signalCodes.includes("possible_viewport_mismatch")
        ? ["viewport_or_reference_mismatch"]
        : ["missing_or_extra_content"];
    case "layout_global_drift":
      return finalOutcome === "needs_human_review" ? ["layout_displacement"] : [];
    case "color_global_drift":
      return finalOutcome === "needs_human_review" ? ["visual_style_drift"] : [];
    case "setup_capture_signal_risk": {
      const codes = new Set<RootCauseCode>();

      for (const signalCode of trace.signalCodes) {
        if (signalCode === "possible_capture_crop") {
          codes.add("capture_scope_too_tight");
        }

        if (signalCode === "possible_viewport_mismatch") {
          codes.add("viewport_or_reference_mismatch");
        }
      }

      if (codes.size === 0) {
        codes.add("viewport_or_reference_mismatch");
      }

      return Array.from(codes);
    }
    case "setup_ignored_area_risk":
      return ["viewport_or_reference_mismatch"];
    case "pixel_strict_pass":
    case "pixel_tolerated_pass":
    case "pixel_retry_range":
    case "pixel_exceeds_retry_range":
    case "layout_localized_drift":
    case "color_localized_drift":
    case "fixability_localized_actionable":
    case "fixability_diffuse_or_unaddressable":
    case "final_pass":
    case "final_pass_with_tolerated_differences":
    case "final_retry_fix":
    case "final_needs_human_review":
      return [];
    default:
      return [];
  }
}

function mergeRootCauseCandidates(
  target: Map<RootCauseCode, RootCauseCandidateInternal>,
  incoming: RootCauseCandidateInternal[],
  findingOrder: Map<string, number>,
): void {
  for (const candidate of incoming) {
    const existing = target.get(candidate.code);

    if (existing) {
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      existing.highestSeverity = moreSevere(existing.highestSeverity, candidate.highestSeverity);
      existing.findingIds = mergeFindingIds(
        existing.findingIds,
        candidate.findingIds,
        findingOrder,
      );
      existing.signalCodes = sortSignalCodes([...existing.signalCodes, ...candidate.signalCodes]);
      continue;
    }

    target.set(candidate.code, {
      ...candidate,
      findingIds: mergeFindingIds([], candidate.findingIds, findingOrder),
      signalCodes: sortSignalCodes(candidate.signalCodes),
    });
  }
}

function classifyFailureRootCause(errorCode: string, failureOrigin: FailureOrigin): RootCauseCode {
  if (
    errorCode.startsWith("preview_") ||
    errorCode.startsWith("playwright_") ||
    errorCode.startsWith("dom_")
  ) {
    return "preview_input_or_runtime_error";
  }

  if (
    errorCode.startsWith("reference_") ||
    errorCode.startsWith("figma_") ||
    errorCode === "remote_request_failed"
  ) {
    return "reference_input_or_acquisition_error";
  }

  if (
    errorCode.startsWith("input_file_") ||
    errorCode.startsWith("image_") ||
    errorCode === "artifact_write_failed"
  ) {
    return failureOrigin === "reference"
      ? "reference_input_or_acquisition_error"
      : "preview_input_or_runtime_error";
  }

  return failureOrigin === "reference"
    ? "reference_input_or_acquisition_error"
    : "preview_input_or_runtime_error";
}

function canSafelyAutofix(params: {
  recommendation: Recommendation;
  error: ErrorReport | null;
  requiresRecapture: boolean;
  topActions: SummaryActionReport[];
  findings: FindingReport[];
}): boolean {
  if (params.recommendation !== "retry_fix" || params.error !== null || params.requiresRecapture) {
    return false;
  }

  const referencedFindingIds = uniqueFindingIds(
    params.topActions.flatMap((action) => action.findingIds),
  );

  if (referencedFindingIds.length === 0) {
    return false;
  }

  const findingsById = new Map(params.findings.map((finding) => [finding.id, finding]));

  return referencedFindingIds.every((findingId) => {
    const finding = findingsById.get(findingId);
    return Boolean(finding?.actionTarget?.selector);
  });
}

function buildOverallConfidence(params: {
  recommendation: Recommendation;
  decisionTrace: DecisionTraceReport[];
  analysisMode: AnalysisMode;
  omittedFindings: number;
}): number {
  const finalTrace = params.decisionTrace.find((trace) => trace.axis === "final");
  let confidence = finalTrace
    ? confidenceForDecisionStrength(finalTrace.strength)
    : fallbackConfidenceForRecommendation(params.recommendation);

  if (finalTrace?.outcome === "retry_fix" && params.analysisMode === "visual-clusters") {
    confidence -= 0.1;
  }

  if (params.omittedFindings > 0) {
    confidence -= 0.05;
  }

  return roundConfidence(confidence);
}

function confidenceForDecisionStrength(strength: DecisionStrength): number {
  switch (strength) {
    case "critical":
      return 0.95;
    case "high":
      return 0.85;
    case "medium":
      return 0.72;
    case "low":
    default:
      return 0.6;
  }
}

function candidateConfidenceForDecisionStrength(strength: DecisionStrength): number {
  switch (strength) {
    case "critical":
      return 0.99;
    case "high":
      return 0.96;
    case "medium":
      return 0.8;
    case "low":
    default:
      return 0.65;
  }
}

function fallbackConfidenceForRecommendation(recommendation: Recommendation): number {
  switch (recommendation) {
    case "pass":
      return 0.95;
    case "pass_with_tolerated_differences":
      return 0.85;
    case "retry_fix":
      return 0.72;
    case "needs_human_review":
    default:
      return 0.6;
  }
}

function severityToDecisionStrength(severity: Severity): DecisionStrength {
  switch (severity) {
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

function compareRankedCandidates<
  T extends { confidence: number; highestSeverity: Severity; code: string },
>(left: T, right: T): number {
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }

  const severityOrder = compareSeverityDescending(left.highestSeverity, right.highestSeverity);

  if (severityOrder !== 0) {
    return severityOrder;
  }

  return left.code.localeCompare(right.code);
}

function mergeFindingIds(
  existing: string[],
  incoming: string[],
  findingOrder: Map<string, number>,
): string[] {
  return uniqueFindingIds([...existing, ...incoming]).sort((left, right) => {
    const leftIndex = findingOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = findingOrder.get(right) ?? Number.MAX_SAFE_INTEGER;

    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.localeCompare(right);
  });
}

function mergeSignalCodes(
  existing: FindingSignalCode[],
  signals: Pick<FindingReport, "signals">["signals"],
): FindingSignalCode[] {
  return sortSignalCodes([...existing, ...signals.map((signal) => signal.code)]);
}

function sortSignalCodes(values: FindingSignalCode[]): FindingSignalCode[] {
  const order = new Map(FINDING_SIGNAL_CODES.map((code, index) => [code, index]));

  return [...new Set(values)].sort((left, right) => {
    const leftIndex = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right) ?? Number.MAX_SAFE_INTEGER;

    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.localeCompare(right);
  });
}

function uniqueFindingIds(values: string[]): string[] {
  return [...new Set(values)];
}

function moreSevere(left: Severity, right: Severity): Severity {
  return compareSeverityDescending(left, right) <= 0 ? left : right;
}

function roundConfidence(value: number): number {
  return Number(Math.min(0.99, Math.max(0.05, value)).toFixed(2));
}

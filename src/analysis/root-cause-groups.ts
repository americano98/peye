import type {
  FindingReport,
  FindingSignalCode,
  RootCauseGroupId,
  Severity,
} from "../types/report.js";

export const ROOT_CAUSE_GROUP_REASONS: Record<RootCauseGroupId, string> = {
  "text-wrap-regression":
    "Text content appears to wrap, clamp, or overflow differently than the reference.",
  "viewport-crop-risk":
    "Capture framing or viewport selection appears inconsistent with the intended target.",
  "container-size-mismatch": "Element container sizing appears inconsistent with the reference.",
  "content-presence-mismatch":
    "The preview and reference disagree on content presence or frame extent.",
  "layout-displacement": "Layout displacement appears to be the primary blocker.",
  "visual-style-drift": "Visual styling drift appears to be the primary blocker.",
  "rendering-drift": "Fine-grained rendering drift appears to be the primary blocker.",
  "preview-setup-error": "The preview input or browser capture failed before comparison.",
  "reference-setup-error": "The reference input or acquisition failed before comparison.",
};

export function rootCauseGroupIdForFinding(
  finding: Pick<FindingReport, "code" | "signals" | "element">,
): RootCauseGroupId {
  const signalCodes = new Set<FindingSignalCode>(finding.signals.map((signal) => signal.code));

  if (finding.code === "text_clipping" || signalCodes.has("probable_text_clipping")) {
    return "text-wrap-regression";
  }

  if (
    finding.code === "capture_crop" ||
    finding.code === "viewport_mismatch" ||
    signalCodes.has("possible_capture_crop") ||
    signalCodes.has("possible_viewport_mismatch")
  ) {
    return "viewport-crop-risk";
  }

  if (finding.code === "missing_or_extra_content" && finding.element !== null) {
    return "container-size-mismatch";
  }

  if (finding.code === "missing_or_extra_content") {
    return "content-presence-mismatch";
  }

  if (finding.code === "layout_mismatch" || finding.code === "layout_style_mismatch") {
    return "layout-displacement";
  }

  if (finding.code === "style_mismatch") {
    return "visual-style-drift";
  }

  return "rendering-drift";
}

export function rootCauseGroupIdForFailureOrigin(
  failureOrigin: "preview" | "reference" | "unknown",
): RootCauseGroupId {
  return failureOrigin === "reference" ? "reference-setup-error" : "preview-setup-error";
}

export function comparePrimaryBlockers(
  left: {
    rootCauseGroupId: RootCauseGroupId;
    severity: Severity;
    affectedAreaPercent: number;
    findingCount: number;
  },
  right: {
    rootCauseGroupId: RootCauseGroupId;
    severity: Severity;
    affectedAreaPercent: number;
    findingCount: number;
  },
  compareSeverityDescending: (left: Severity, right: Severity) => number,
): number {
  const severityOrder = compareSeverityDescending(left.severity, right.severity);

  if (severityOrder !== 0) {
    return severityOrder;
  }

  if (left.affectedAreaPercent !== right.affectedAreaPercent) {
    return right.affectedAreaPercent - left.affectedAreaPercent;
  }

  if (left.findingCount !== right.findingCount) {
    return right.findingCount - left.findingCount;
  }

  return left.rootCauseGroupId.localeCompare(right.rootCauseGroupId);
}

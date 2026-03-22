import {
  FINDING_DIRECTIONAL_GEOMETRY_CONFIDENCE,
  FINDING_DIRECTIONAL_GEOMETRY_MAX_AMBIGUITY,
  TEXT_VALIDATION_CONFIDENCE_MEDIUM,
  TEXT_VALIDATION_CONFIDENCE_STRONG,
  TEXT_VALIDATION_HEIGHT_DRIFT_PX,
  TEXT_VALIDATION_MIN_AREA_PX,
  TEXT_VALIDATION_MIN_HEIGHT_PX,
  TEXT_VALIDATION_WIDTH_DRIFT_PX,
} from "../config/defaults.js";
import type { GroupLocalization } from "../correspond/types.js";
import type {
  AffectedPropertyCode,
  ComputedStyleSubsetReport,
  FindingCode,
  FindingSignalReport,
  FindingReport,
  InteractivityStateReport,
  IssueType,
  TextLayoutReport,
  TextValidationDiagnosisKind,
  TextValidationReport,
} from "../types/report.js";

interface BuildTextValidationParams {
  element: {
    tag: string;
    textSnippet?: string;
    bbox: { width: number; height: number };
  } | null;
  context: {
    semantic?: {
      interactivity?: InteractivityStateReport;
      computedStyle?: ComputedStyleSubsetReport;
      textLayout?: TextLayoutReport | null;
    };
  } | null;
  correspondence?: GroupLocalization | undefined;
  geometry?: FindingReport["geometry"];
  siblingRelation?: FindingReport["siblingRelation"];
  signals: FindingSignalReport[];
}

export function buildTextValidation(
  params: BuildTextValidationParams,
): TextValidationReport | undefined {
  if (!isSignificantTextNode(params)) {
    return undefined;
  }

  const textLayout = params.context?.semantic?.textLayout;
  const reliableMatch = Boolean(
    params.correspondence?.reliable && params.correspondence.matchedReferenceBBox,
  );
  const attempted = Boolean(params.correspondence);
  const overflowSignal = params.signals.some((signal) => signal.code === "probable_text_clipping");
  const overflowObserved = Boolean(textLayout?.overflowsX || textLayout?.overflowsY);
  const strongVerticalBehavior = Boolean(
    textLayout?.overflowsY || textLayout?.wrapState === "overflowing",
  );
  const delta = params.correspondence?.delta;
  const heightDeltaPx = Math.abs(delta?.dh ?? params.geometry?.heightDeltaPx ?? 0);
  const widthDeltaPx = Math.abs(delta?.dw ?? params.geometry?.widthDeltaPx ?? 0);
  const allowsDirectionalClaim = Boolean(
    params.correspondence &&
    params.correspondence.reliable &&
    params.correspondence.confidence >= FINDING_DIRECTIONAL_GEOMETRY_CONFIDENCE &&
    params.correspondence.ambiguity <= FINDING_DIRECTIONAL_GEOMETRY_MAX_AMBIGUITY,
  );

  let diagnosisKind: TextValidationDiagnosisKind = "uncertain";

  if (overflowSignal || overflowObserved) {
    diagnosisKind = "text_overflow";
  } else if (
    reliableMatch &&
    (strongVerticalBehavior ||
      (heightDeltaPx >= TEXT_VALIDATION_HEIGHT_DRIFT_PX && heightDeltaPx >= widthDeltaPx))
  ) {
    diagnosisKind = "text_height_drift";
  } else if (
    reliableMatch &&
    params.geometry?.positionShiftLevel !== "none" &&
    params.geometry?.sizeShiftLevel === "none"
  ) {
    diagnosisKind = "text_position_drift";
  } else if (reliableMatch) {
    diagnosisKind = "text_style_drift";
  }

  const status: TextValidationReport["status"] = reliableMatch
    ? "matched"
    : attempted && params.correspondence?.found
      ? "uncertain"
      : attempted
        ? "unmatched"
        : "uncertain";
  const confidence = roundMetric(
    diagnosisKind === "text_overflow"
      ? overflowSignal
        ? 0.9
        : TEXT_VALIDATION_CONFIDENCE_STRONG
      : diagnosisKind === "text_height_drift" || diagnosisKind === "text_position_drift"
        ? Math.max(TEXT_VALIDATION_CONFIDENCE_MEDIUM, params.correspondence?.confidence ?? 0)
        : diagnosisKind === "text_style_drift"
          ? roundMetric(Math.max(0.58, (params.correspondence?.confidence ?? 0.6) - 0.08))
          : roundMetric(Math.max(0.4, (params.correspondence?.confidence ?? 0.5) - 0.1)),
  );

  return {
    status,
    diagnosisKind,
    confidence,
    observations: buildTextValidationObservations({
      textLayout,
      diagnosisKind,
      delta,
      siblingRelation: params.siblingRelation,
      allowsDirectionalClaim,
      heightDeltaPx,
      widthDeltaPx,
    }),
    allowsDirectionalClaim,
  };
}

export function refineFindingCodeWithTextValidation(
  baseCode: FindingCode,
  textValidation: TextValidationReport | undefined,
  geometry: FindingReport["geometry"] | undefined,
): FindingCode {
  if (!textValidation) {
    return baseCode;
  }

  switch (textValidation.diagnosisKind) {
    case "text_overflow":
      return "text_clipping";
    case "text_height_drift":
      return geometry?.positionShiftLevel && geometry.positionShiftLevel !== "none"
        ? "layout_style_mismatch"
        : "style_mismatch";
    case "text_position_drift":
      return "layout_mismatch";
    case "text_style_drift":
      return baseCode === "layout_mismatch" ? "layout_style_mismatch" : "style_mismatch";
    case "uncertain":
    default:
      return baseCode;
  }
}

export function mergeIssueTypesForTextValidation(
  baseIssueTypes: IssueType[],
  textValidation: TextValidationReport | undefined,
): IssueType[] {
  if (!textValidation) {
    return baseIssueTypes;
  }

  const merged = new Set(baseIssueTypes);

  switch (textValidation.diagnosisKind) {
    case "text_overflow":
      merged.add("size");
      merged.add("style");
      break;
    case "text_height_drift":
      merged.add("size");
      merged.add("style");
      break;
    case "text_position_drift":
      merged.add("position");
      break;
    case "text_style_drift":
      merged.add("style");
      break;
    case "uncertain":
      break;
    default:
      break;
  }

  return [...merged];
}

export function mergeAffectedPropertiesForTextValidation(
  baseProperties: AffectedPropertyCode[],
  textValidation: TextValidationReport | undefined,
): AffectedPropertyCode[] {
  if (!textValidation) {
    return baseProperties;
  }

  const merged = new Set(baseProperties);

  switch (textValidation.diagnosisKind) {
    case "text_overflow":
      merged.add("text.overflow");
      merged.add("text.lineClamp");
      merged.add("style.typography");
      merged.add("size.width");
      merged.add("size.height");
      break;
    case "text_height_drift":
      merged.add("style.typography");
      merged.add("size.height");
      break;
    case "text_position_drift":
      merged.add("layout.position");
      merged.add("layout.alignment");
      break;
    case "text_style_drift":
      merged.add("style.typography");
      break;
    case "uncertain":
      break;
    default:
      break;
  }

  return [...merged];
}

export function hasMeaningfulTextValidation(
  textValidation: TextValidationReport | undefined,
): boolean {
  return Boolean(textValidation && textValidation.diagnosisKind !== "uncertain");
}

export function hasStrongTextValidation(textValidation: TextValidationReport | undefined): boolean {
  return Boolean(
    textValidation &&
    textValidation.diagnosisKind !== "uncertain" &&
    textValidation.confidence >= TEXT_VALIDATION_CONFIDENCE_STRONG,
  );
}

export function isTextOverflowValidation(
  textValidation: TextValidationReport | undefined,
): boolean {
  return textValidation?.diagnosisKind === "text_overflow";
}

function isSignificantTextNode(params: BuildTextValidationParams): boolean {
  const text = params.element?.textSnippet?.trim() ?? "";
  const tag = params.element?.tag ?? "";
  const textLayout = params.context?.semantic?.textLayout;
  const isInteractive = params.context?.semantic?.interactivity?.isInteractive ?? false;

  if (text.length === 0 || !params.element) {
    return false;
  }

  const area = params.element.bbox.width * params.element.bbox.height;
  const isTextLikeTag = /^(h[1-6]|p|span|label|small|strong|em|blockquote)$/i.test(tag);
  const overflowObserved = Boolean(textLayout?.overflowsX || textLayout?.overflowsY);
  const multiline = Boolean(textLayout && textLayout.lineCount > 1);

  return (
    isTextLikeTag ||
    overflowObserved ||
    multiline ||
    (!isInteractive &&
      (params.element.bbox.height >= TEXT_VALIDATION_MIN_HEIGHT_PX ||
        area >= TEXT_VALIDATION_MIN_AREA_PX))
  );
}

function buildTextValidationObservations(params: {
  textLayout:
    | {
        lineCount: number;
        wrapState: string;
        hasEllipsis: boolean;
        lineClamp: string | null;
        overflowsX: boolean;
        overflowsY: boolean;
      }
    | null
    | undefined;
  diagnosisKind: TextValidationDiagnosisKind;
  delta: GroupLocalization["delta"] | undefined;
  siblingRelation: FindingReport["siblingRelation"] | undefined;
  allowsDirectionalClaim: boolean;
  heightDeltaPx: number;
  widthDeltaPx: number;
}): string[] {
  const observations: string[] = [];

  if (params.textLayout?.overflowsX) {
    observations.push("Preview text overflows horizontally.");
  }

  if (params.textLayout?.overflowsY) {
    observations.push("Preview text overflows vertically.");
  }

  if (params.textLayout && params.textLayout.lineCount > 0) {
    observations.push(`Preview text spans ${params.textLayout.lineCount} line(s).`);
  }

  if (
    params.diagnosisKind === "text_height_drift" &&
    params.heightDeltaPx >= TEXT_VALIDATION_HEIGHT_DRIFT_PX
  ) {
    observations.push(
      `Matched text block height differs by about ${Math.round(params.heightDeltaPx)}px.`,
    );
  }

  if (
    params.diagnosisKind === "text_position_drift" &&
    params.allowsDirectionalClaim &&
    params.delta
  ) {
    if (Math.abs(params.delta.dy) > Math.abs(params.delta.dx)) {
      observations.push(
        `Matched text block is vertically offset by about ${Math.abs(params.delta.dy)}px.`,
      );
    } else {
      observations.push(
        `Matched text block is horizontally offset by about ${Math.abs(params.delta.dx)}px.`,
      );
    }
  }

  if (params.siblingRelation && params.siblingRelation.spacingDriftLevel !== "none") {
    observations.push(
      `Gap to adjacent text block differs by about ${Math.abs(params.siblingRelation.gapDeltaPx)}px.`,
    );
  }

  if (
    params.diagnosisKind === "text_style_drift" &&
    params.widthDeltaPx < TEXT_VALIDATION_WIDTH_DRIFT_PX &&
    params.heightDeltaPx < TEXT_VALIDATION_HEIGHT_DRIFT_PX
  ) {
    observations.push("Matched text block shape is broadly consistent, but typography may differ.");
  }

  return observations;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

import {
  GEOMETRY_DOMINANT_EPSILON,
  GEOMETRY_POSITION_LARGE_SHIFT_PX,
  GEOMETRY_POSITION_MEDIUM_SHIFT_PX,
  GEOMETRY_POSITION_SMALL_SHIFT_PX,
  GEOMETRY_SIZE_LARGE_RATIO,
  GEOMETRY_SIZE_MEDIUM_RATIO,
  GEOMETRY_SIZE_SMALL_RATIO,
} from "../config/defaults.js";
import type {
  AffectedPropertyCode,
  BoundingBox,
  FindingCode,
  GeometryDriftReport,
  IssueType,
} from "../types/report.js";

export function buildGeometryDrift(
  previewBox: BoundingBox,
  matchedReferenceBox: BoundingBox | undefined,
): GeometryDriftReport | undefined {
  if (!matchedReferenceBox) {
    return undefined;
  }

  const previewCenterX = previewBox.x + previewBox.width / 2;
  const previewCenterY = previewBox.y + previewBox.height / 2;
  const referenceCenterX = matchedReferenceBox.x + matchedReferenceBox.width / 2;
  const referenceCenterY = matchedReferenceBox.y + matchedReferenceBox.height / 2;
  const centerShiftPx = roundMetric(
    Math.sqrt((referenceCenterX - previewCenterX) ** 2 + (referenceCenterY - previewCenterY) ** 2),
  );
  const widthDeltaPx = roundMetric(matchedReferenceBox.width - previewBox.width);
  const heightDeltaPx = roundMetric(matchedReferenceBox.height - previewBox.height);
  const widthDeltaRatio = roundMetric(Math.abs(widthDeltaPx) / Math.max(1, previewBox.width));
  const heightDeltaRatio = roundMetric(Math.abs(heightDeltaPx) / Math.max(1, previewBox.height));
  const previewArea = Math.max(1, previewBox.width * previewBox.height);
  const matchedArea = matchedReferenceBox.width * matchedReferenceBox.height;
  const areaDeltaRatio = roundMetric(Math.abs(matchedArea - previewArea) / previewArea);
  const previewAspectRatio = previewBox.width / Math.max(1, previewBox.height);
  const matchedAspectRatio = matchedReferenceBox.width / Math.max(1, matchedReferenceBox.height);
  const aspectRatioDelta = roundMetric(Math.abs(matchedAspectRatio - previewAspectRatio));
  const normalizedCenterShift = roundMetric(
    centerShiftPx / Math.max(1, Math.sqrt(previewBox.width ** 2 + previewBox.height ** 2)),
  );
  const positionShiftLevel = classifyPositionShift(centerShiftPx);
  const sizeShiftLevel = classifySizeShift(
    Math.max(widthDeltaRatio, heightDeltaRatio, areaDeltaRatio * 0.5, aspectRatioDelta),
  );
  const dominantDrift = selectDominantDrift(
    normalizedCenterShift,
    widthDeltaRatio,
    heightDeltaRatio,
  );

  return {
    centerShiftPx,
    normalizedCenterShift,
    widthDeltaPx,
    heightDeltaPx,
    widthDeltaRatio,
    heightDeltaRatio,
    areaDeltaRatio,
    aspectRatioDelta,
    dominantDrift,
    positionShiftLevel,
    sizeShiftLevel,
  };
}

export function refineFindingCodeWithGeometry(
  baseCode: FindingCode,
  geometry: GeometryDriftReport | undefined,
): FindingCode {
  if (!geometry || !hasMeaningfulGeometryDrift(geometry)) {
    return baseCode;
  }

  if (
    baseCode === "text_clipping" ||
    baseCode === "capture_crop" ||
    baseCode === "viewport_mismatch" ||
    baseCode === "missing_or_extra_content" ||
    baseCode === "layout_mismatch" ||
    baseCode === "layout_style_mismatch"
  ) {
    return baseCode;
  }

  if (baseCode === "style_mismatch") {
    return "layout_style_mismatch";
  }

  if (baseCode === "rendering_mismatch") {
    return "layout_mismatch";
  }

  return baseCode;
}

export function mergeIssueTypesForGeometry(
  baseIssueTypes: IssueType[],
  geometry: GeometryDriftReport | undefined,
): IssueType[] {
  if (!geometry) {
    return baseIssueTypes;
  }

  const merged = new Set(baseIssueTypes);

  if (geometry.positionShiftLevel !== "none") {
    merged.add("position");
  }

  if (geometry.sizeShiftLevel !== "none") {
    merged.add("size");
  }

  return [...merged];
}

export function mergeAffectedPropertiesForGeometry(
  baseProperties: AffectedPropertyCode[],
  geometry: GeometryDriftReport | undefined,
): AffectedPropertyCode[] {
  if (!geometry) {
    return baseProperties;
  }

  const merged = new Set(baseProperties);

  if (geometry.positionShiftLevel !== "none") {
    merged.add("layout.position");
    merged.add("layout.alignment");
  }

  if (geometry.sizeShiftLevel !== "none") {
    if (Math.abs(geometry.widthDeltaPx) > 0) {
      merged.add("size.width");
    }

    if (Math.abs(geometry.heightDeltaPx) > 0) {
      merged.add("size.height");
    }
  }

  return [...merged];
}

export function hasMeaningfulGeometryDrift(geometry: GeometryDriftReport | undefined): boolean {
  if (!geometry) {
    return false;
  }

  return (
    geometry.positionShiftLevel === "medium" ||
    geometry.positionShiftLevel === "large" ||
    geometry.sizeShiftLevel === "medium" ||
    geometry.sizeShiftLevel === "large"
  );
}

function classifyPositionShift(centerShiftPx: number): GeometryDriftReport["positionShiftLevel"] {
  if (centerShiftPx >= GEOMETRY_POSITION_LARGE_SHIFT_PX) {
    return "large";
  }

  if (centerShiftPx >= GEOMETRY_POSITION_MEDIUM_SHIFT_PX) {
    return "medium";
  }

  if (centerShiftPx >= GEOMETRY_POSITION_SMALL_SHIFT_PX) {
    return "small";
  }

  return "none";
}

function classifySizeShift(sizeRatio: number): GeometryDriftReport["sizeShiftLevel"] {
  if (sizeRatio >= GEOMETRY_SIZE_LARGE_RATIO) {
    return "large";
  }

  if (sizeRatio >= GEOMETRY_SIZE_MEDIUM_RATIO) {
    return "medium";
  }

  if (sizeRatio >= GEOMETRY_SIZE_SMALL_RATIO) {
    return "small";
  }

  return "none";
}

function selectDominantDrift(
  normalizedCenterShift: number,
  widthDeltaRatio: number,
  heightDeltaRatio: number,
): GeometryDriftReport["dominantDrift"] {
  const positionScore = normalizedCenterShift;
  const sizeScore = Math.max(widthDeltaRatio, heightDeltaRatio);

  if (positionScore < GEOMETRY_DOMINANT_EPSILON && sizeScore < GEOMETRY_DOMINANT_EPSILON) {
    return "none";
  }

  if (Math.abs(positionScore - sizeScore) <= GEOMETRY_DOMINANT_EPSILON) {
    return "mixed";
  }

  return positionScore > sizeScore ? "position" : "size";
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

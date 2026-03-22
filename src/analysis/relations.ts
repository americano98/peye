import {
  RELATION_ALIGNMENT_LARGE_DELTA_PX,
  RELATION_ALIGNMENT_MEDIUM_DELTA_PX,
  RELATION_ALIGNMENT_SMALL_DELTA_PX,
  RELATION_DOMINANT_EPSILON_PX,
  RELATION_SPACING_LARGE_DELTA_PX,
  RELATION_SPACING_MEDIUM_DELTA_PX,
  RELATION_SPACING_SMALL_DELTA_PX,
} from "../config/defaults.js";
import type { GroupLocalization, GroupNode } from "../correspond/types.js";
import type {
  AffectedPropertyCode,
  BoundingBox,
  FindingCode,
  GeometryShiftLevel,
  IssueType,
  SiblingRelationAxis,
  SiblingRelationReport,
} from "../types/report.js";

export function buildSiblingRelationsIndex(
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): Map<string, SiblingRelationReport> {
  const relationsByGroupId = new Map<string, SiblingRelationReport>();

  for (const group of groupsById.values()) {
    const relation = buildSiblingRelationForGroup(group, groupsById, localizationsByGroupId);

    if (relation) {
      relationsByGroupId.set(group.id, relation);
    }
  }

  return relationsByGroupId;
}

export function refineFindingCodeWithSiblingRelation(
  baseCode: FindingCode,
  relation: SiblingRelationReport | undefined,
): FindingCode {
  if (!relation || !hasMeaningfulSiblingRelationDrift(relation)) {
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

export function mergeIssueTypesForSiblingRelation(
  baseIssueTypes: IssueType[],
  relation: SiblingRelationReport | undefined,
): IssueType[] {
  if (!relation) {
    return baseIssueTypes;
  }

  const merged = new Set(baseIssueTypes);

  if (relation.spacingDriftLevel !== "none") {
    merged.add("spacing");
  }

  if (relation.alignmentDriftLevel !== "none") {
    merged.add("position");
  }

  return [...merged];
}

export function mergeAffectedPropertiesForSiblingRelation(
  baseProperties: AffectedPropertyCode[],
  relation: SiblingRelationReport | undefined,
): AffectedPropertyCode[] {
  if (!relation) {
    return baseProperties;
  }

  const merged = new Set(baseProperties);

  if (relation.spacingDriftLevel !== "none") {
    merged.add("layout.spacing");
  }

  if (relation.alignmentDriftLevel !== "none") {
    merged.add("layout.alignment");
    merged.add("layout.position");
  }

  return [...merged];
}

export function hasMeaningfulSiblingRelationDrift(
  relation: SiblingRelationReport | undefined,
): boolean {
  if (!relation) {
    return false;
  }

  return (
    relation.spacingDriftLevel === "medium" ||
    relation.spacingDriftLevel === "large" ||
    relation.alignmentDriftLevel === "medium" ||
    relation.alignmentDriftLevel === "large"
  );
}

function buildSiblingRelationForGroup(
  group: GroupNode,
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): SiblingRelationReport | null {
  const groupLocalization = localizationsByGroupId.get(group.id);

  if (
    !groupLocalization?.reliable ||
    !groupLocalization.matchedReferenceBBox ||
    !group.parentGroupId
  ) {
    return null;
  }

  const siblingCandidate = selectSiblingCandidate(group, groupsById, localizationsByGroupId);

  if (!siblingCandidate) {
    return null;
  }

  const axis = selectRelationAxis(group.bbox, siblingCandidate.group.bbox);
  const previewGapPx = computeAxisGap(axis, group.bbox, siblingCandidate.group.bbox);
  const referenceGapPx = computeAxisGap(
    axis,
    groupLocalization.matchedReferenceBBox,
    siblingCandidate.localization.matchedReferenceBBox,
  );
  const gapDeltaPx = roundMetric(referenceGapPx - previewGapPx);
  const normalizedGapDelta = roundMetric(
    Math.abs(gapDeltaPx) /
      Math.max(
        1,
        axis === "horizontal"
          ? Math.max(group.bbox.width, siblingCandidate.group.bbox.width)
          : Math.max(group.bbox.height, siblingCandidate.group.bbox.height),
      ),
  );
  const crossAxisOffsetDeltaPx = roundMetric(
    Math.abs(
      computeCrossAxisOffset(axis, group.bbox, siblingCandidate.group.bbox) -
        computeCrossAxisOffset(
          axis,
          groupLocalization.matchedReferenceBBox,
          siblingCandidate.localization.matchedReferenceBBox,
        ),
    ),
  );
  const spacingDriftLevel = classifySpacingDrift(Math.abs(gapDeltaPx));
  const alignmentDriftLevel = classifyAlignmentDrift(crossAxisOffsetDeltaPx);

  return {
    siblingSelector: siblingCandidate.group.selector,
    axis,
    previewGapPx: roundMetric(previewGapPx),
    referenceGapPx: roundMetric(referenceGapPx),
    gapDeltaPx,
    normalizedGapDelta,
    crossAxisOffsetDeltaPx,
    spacingDriftLevel,
    alignmentDriftLevel,
    dominantDrift: selectDominantRelationDrift(Math.abs(gapDeltaPx), crossAxisOffsetDeltaPx),
    relativeOrderPreserved: isRelativeOrderPreserved(
      axis,
      group.bbox,
      siblingCandidate.group.bbox,
      groupLocalization.matchedReferenceBBox,
      siblingCandidate.localization.matchedReferenceBBox,
    ),
  };
}

function selectSiblingCandidate(
  group: GroupNode,
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): {
  group: GroupNode;
  localization: GroupLocalization & { matchedReferenceBBox: BoundingBox };
} | null {
  const parent = groupsById.get(group.parentGroupId ?? "");

  if (!parent) {
    return null;
  }

  const selfIndex = parent.childGroupIds.indexOf(group.id);
  const orderedSiblingIds =
    selfIndex === -1
      ? [...parent.childGroupIds]
      : [
          parent.childGroupIds[selfIndex - 1],
          parent.childGroupIds[selfIndex + 1],
          ...parent.childGroupIds.filter(
            (siblingId, index) =>
              siblingId !== group.id && index !== selfIndex - 1 && index !== selfIndex + 1,
          ),
        ].filter((siblingId): siblingId is string => Boolean(siblingId));

  for (const siblingId of orderedSiblingIds) {
    const siblingGroup = groupsById.get(siblingId);
    const siblingLocalization = localizationsByGroupId.get(siblingId);

    if (siblingGroup && siblingLocalization?.reliable && siblingLocalization.matchedReferenceBBox) {
      return {
        group: siblingGroup,
        localization: siblingLocalization as GroupLocalization & {
          matchedReferenceBBox: BoundingBox;
        },
      };
    }
  }

  return null;
}

function selectRelationAxis(
  left: GroupNode["bbox"],
  right: GroupNode["bbox"],
): SiblingRelationAxis {
  const leftCenterX = left.x + left.width / 2;
  const leftCenterY = left.y + left.height / 2;
  const rightCenterX = right.x + right.width / 2;
  const rightCenterY = right.y + right.height / 2;

  return Math.abs(rightCenterX - leftCenterX) >= Math.abs(rightCenterY - leftCenterY)
    ? "horizontal"
    : "vertical";
}

function computeAxisGap(
  axis: SiblingRelationAxis,
  left: GroupNode["bbox"],
  right: GroupNode["bbox"],
): number {
  if (axis === "horizontal") {
    if (left.x <= right.x) {
      return right.x - (left.x + left.width);
    }

    return left.x - (right.x + right.width);
  }

  if (left.y <= right.y) {
    return right.y - (left.y + left.height);
  }

  return left.y - (right.y + right.height);
}

function computeCrossAxisOffset(
  axis: SiblingRelationAxis,
  left: GroupNode["bbox"],
  right: GroupNode["bbox"],
): number {
  return axis === "horizontal" ? right.y - left.y : right.x - left.x;
}

function isRelativeOrderPreserved(
  axis: SiblingRelationAxis,
  previewBox: GroupNode["bbox"],
  siblingPreviewBox: GroupNode["bbox"],
  referenceBox: GroupNode["bbox"],
  siblingReferenceBox: GroupNode["bbox"],
): boolean {
  const previewDelta =
    axis === "horizontal" ? siblingPreviewBox.x - previewBox.x : siblingPreviewBox.y - previewBox.y;
  const referenceDelta =
    axis === "horizontal"
      ? siblingReferenceBox.x - referenceBox.x
      : siblingReferenceBox.y - referenceBox.y;

  return (
    previewDelta === 0 ||
    referenceDelta === 0 ||
    Math.sign(previewDelta) === Math.sign(referenceDelta)
  );
}

function classifySpacingDrift(deltaPx: number): GeometryShiftLevel {
  if (deltaPx >= RELATION_SPACING_LARGE_DELTA_PX) {
    return "large";
  }

  if (deltaPx >= RELATION_SPACING_MEDIUM_DELTA_PX) {
    return "medium";
  }

  if (deltaPx >= RELATION_SPACING_SMALL_DELTA_PX) {
    return "small";
  }

  return "none";
}

function classifyAlignmentDrift(deltaPx: number): GeometryShiftLevel {
  if (deltaPx >= RELATION_ALIGNMENT_LARGE_DELTA_PX) {
    return "large";
  }

  if (deltaPx >= RELATION_ALIGNMENT_MEDIUM_DELTA_PX) {
    return "medium";
  }

  if (deltaPx >= RELATION_ALIGNMENT_SMALL_DELTA_PX) {
    return "small";
  }

  return "none";
}

function selectDominantRelationDrift(
  spacingDeltaPx: number,
  alignmentDeltaPx: number,
): SiblingRelationReport["dominantDrift"] {
  if (
    spacingDeltaPx < RELATION_SPACING_SMALL_DELTA_PX &&
    alignmentDeltaPx < RELATION_ALIGNMENT_SMALL_DELTA_PX
  ) {
    return "none";
  }

  if (Math.abs(spacingDeltaPx - alignmentDeltaPx) <= RELATION_DOMINANT_EPSILON_PX) {
    return "mixed";
  }

  return spacingDeltaPx > alignmentDeltaPx ? "spacing" : "alignment";
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

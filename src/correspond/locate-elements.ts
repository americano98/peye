import {
  CORRESPONDENCE_ALIGNMENT_RELIABLE_THRESHOLD,
  CORRESPONDENCE_AMBIGUITY_THRESHOLD,
  CORRESPONDENCE_CHILD_SEARCH_GRAPHICS_PADDING_PX,
  CORRESPONDENCE_CHILD_SEARCH_MIN_CONFIDENCE,
  CORRESPONDENCE_CHILD_SEARCH_TEXT_PADDING_PX,
  CORRESPONDENCE_CONFIDENCE_RELIABLE,
  CORRESPONDENCE_GRAPHICS_FALLBACK_PADDING_PX,
  CORRESPONDENCE_MAX_GRAPHICS_FALLBACKS,
  CORRESPONDENCE_MAX_PROJECTED_REFINEMENTS,
  CORRESPONDENCE_MAX_TEXT_FALLBACKS,
  CORRESPONDENCE_PROJECTED_CONFIDENCE_MIN,
  CORRESPONDENCE_PROJECTED_REFINEMENT_MIN_CONFIDENCE,
  CORRESPONDENCE_PROJECTED_REFINEMENT_PADDING_PX,
  CORRESPONDENCE_PROJECTED_RELIABLE_AMBIGUITY,
  CORRESPONDENCE_PROJECTED_RELIABLE_CONFIDENCE,
  CORRESPONDENCE_PROJECTED_SEARCH_DEFAULT_PADDING_PX,
  CORRESPONDENCE_RELATIVE_ICON_MAX_AREA_PX,
  CORRESPONDENCE_RELATIVE_ICON_PADDING_PX,
  CORRESPONDENCE_SMALL_GRAPHICS_MAX_AREA_PX,
  CORRESPONDENCE_SMALL_GROUP_AREA_PX,
  CORRESPONDENCE_TINY_ICON_MIN_SCORE,
  CORRESPONDENCE_TINY_ICON_RELIABLE_CONFIDENCE,
} from "../config/defaults.js";
import type { ComparisonRegion, DomSnapshot } from "../types/internal.js";
import type { BoundingBox } from "../types/report.js";
import { buildGroups } from "./build-groups.js";
import { runCoarseSearch } from "./coarse-search.js";
import {
  buildReferenceSearchCache,
  buildEdgeMask,
  cropImage,
  rgbaToLumaImage,
  resizeToDimensions,
} from "./reference-cache.js";
import { refineCandidates, type RefinementMode } from "./refine-search.js";
import type {
  CorrespondenceProfile,
  CorrespondenceResult,
  GlobalAlignment,
  GroupLocalization,
  GroupNode,
  ImageLike,
} from "./types.js";

export function localizeElementGroups(params: {
  preview: Uint8ClampedArray;
  reference: Uint8ClampedArray;
  width: number;
  height: number;
  rawRegions: ComparisonRegion[];
  domSnapshot: DomSnapshot;
}): CorrespondenceResult {
  const profile: CorrespondenceProfile = {
    timingsMs: {
      alignment: 0,
      groupBuild: 0,
      cacheBuild: 0,
      coarseSearch: 0,
      refinement: 0,
    },
    counts: {
      groupsBuilt: 0,
      groupsSearched: 0,
      candidateWindowsRefined: 0,
      groupsSkippedDueToBudget: 0,
      denseSearchFallbacks: 0,
    },
  };

  if (params.rawRegions.length === 0) {
    return {
      alignment: { method: "none", score: 0, reliable: false },
      groups: [],
      groupsById: new Map(),
      elementToGroupId: new Map(),
      localizationsByGroupId: new Map(),
      summary: {
        processedGroups: 0,
        reliableGroups: 0,
        ambiguousCorrespondences: 0,
        correspondenceCoverage: 0,
        correspondenceConfidence: 0,
      },
      profile,
    };
  }

  const previewGray = rgbaToLumaImage(params.preview, params.width, params.height);
  const referenceGray = rgbaToLumaImage(params.reference, params.width, params.height);
  const previewEdge = buildEdgeMask(previewGray);
  const referenceEdge = buildEdgeMask(referenceGray);

  const alignmentStart = performance.now();
  const alignment = estimateGlobalAlignment(previewGray, referenceGray);
  profile.timingsMs.alignment = roundMetric(performance.now() - alignmentStart);

  const groupsStart = performance.now();
  const groupBuild = buildGroups({
    domSnapshot: params.domSnapshot,
    rawRegions: params.rawRegions,
  });
  profile.timingsMs.groupBuild = roundMetric(performance.now() - groupsStart);
  profile.counts.groupsBuilt = groupBuild.groups.length;

  const cacheStart = performance.now();
  const referenceCache = buildReferenceSearchCache(referenceGray);
  profile.timingsMs.cacheBuild = roundMetric(performance.now() - cacheStart);

  const localizationsByGroupId = new Map<string, GroupLocalization>();
  const coarseStart = performance.now();
  const refinementStart = { value: 0 };

  for (const groupId of groupBuild.searchGroupIds) {
    const group = groupBuild.groupsById.get(groupId);

    if (!group) {
      continue;
    }

    profile.counts.groupsSearched += 1;
    const result = localizeSingleGroup({
      groupId,
      groupBox: group.bbox,
      previewGray,
      previewEdge,
      referenceGray,
      referenceEdge,
      referenceCache,
      alignment,
      width: params.width,
      height: params.height,
    });
    profile.counts.denseSearchFallbacks += result.denseSearchFallbackUsed ? 1 : 0;
    refinementStart.value += result.refinementMs;
    profile.counts.candidateWindowsRefined += result.refinedCandidateCount;
    localizationsByGroupId.set(groupId, result.localization);
  }

  profile.timingsMs.coarseSearch = roundMetric(
    performance.now() - coarseStart - refinementStart.value,
  );
  profile.timingsMs.refinement = roundMetric(refinementStart.value);
  profile.counts.groupsSkippedDueToBudget = Math.max(
    0,
    groupBuild.groups.filter((group) => group.mismatchWeight > 0).length -
      groupBuild.searchGroupIds.length,
  );

  const projectedRefinements = buildProjectedRefinementCandidates(
    groupBuild.groups,
    groupBuild.groupsById,
    localizationsByGroupId,
  ).slice(0, CORRESPONDENCE_MAX_PROJECTED_REFINEMENTS);

  for (const candidate of projectedRefinements) {
    const result = localizeSingleGroup({
      groupId: candidate.group.id,
      groupBox: candidate.group.bbox,
      previewGray,
      previewEdge,
      referenceGray,
      referenceEdge,
      referenceCache,
      alignment,
      width: params.width,
      height: params.height,
      projectedDelta: candidate.delta,
      projectedPadding: CORRESPONDENCE_PROJECTED_REFINEMENT_PADDING_PX,
    });

    recordLocalizationAttempt(profile, localizationsByGroupId, candidate.group.id, result, false);
  }

  const childLocalCandidates = buildChildLocalSearchCandidates(
    groupBuild.groups,
    groupBuild.groupsById,
    localizationsByGroupId,
  ).slice(0, CORRESPONDENCE_MAX_PROJECTED_REFINEMENTS);

  for (const candidate of childLocalCandidates) {
    const result = localizeSingleGroup({
      groupId: candidate.group.id,
      groupBox: candidate.group.bbox,
      previewGray,
      previewEdge,
      referenceGray,
      referenceEdge,
      referenceCache,
      alignment,
      width: params.width,
      height: params.height,
      projectedDelta: candidate.delta,
      projectedPadding: candidate.padding,
    });

    recordLocalizationAttempt(profile, localizationsByGroupId, candidate.group.id, result, false);
  }

  const relativeIconCandidates = buildRelativeTinyGraphicsCandidates(
    groupBuild.groups,
    groupBuild.groupsById,
    localizationsByGroupId,
  );

  for (const candidate of relativeIconCandidates) {
    const result = localizeTinyGraphicGroup({
      groupId: candidate.group.id,
      groupBox: candidate.group.bbox,
      previewGray,
      previewEdge,
      referenceGray,
      referenceEdge,
      width: params.width,
      height: params.height,
      projectedDelta: candidate.delta,
      projectedPadding: candidate.padding,
    });

    recordLocalizationAttempt(profile, localizationsByGroupId, candidate.group.id, result, false);
  }

  const fallbackCandidates = buildSpecializedFallbackCandidates(
    groupBuild.groups,
    groupBuild.groupsById,
    localizationsByGroupId,
  );

  for (const candidate of fallbackCandidates) {
    const result = localizeSingleGroup({
      groupId: candidate.group.id,
      groupBox: candidate.group.bbox,
      previewGray,
      previewEdge,
      referenceGray,
      referenceEdge,
      referenceCache,
      alignment,
      width: params.width,
      height: params.height,
      ...(candidate.delta
        ? { projectedDelta: candidate.delta, projectedPadding: candidate.padding }
        : {}),
    });

    recordLocalizationAttempt(profile, localizationsByGroupId, candidate.group.id, result, true);
  }

  projectChildLocalizations(groupBuild.groupsById, localizationsByGroupId);
  const allLocalized = [...localizationsByGroupId.values()].filter(
    (localization) => localization.attempted,
  );
  const reliable = allLocalized.filter((localization) => localization.reliable);
  const ambiguous = allLocalized.filter(
    (localization) => localization.ambiguity > CORRESPONDENCE_AMBIGUITY_THRESHOLD,
  ).length;

  return {
    alignment,
    groups: groupBuild.groups,
    groupsById: groupBuild.groupsById,
    elementToGroupId: groupBuild.elementToGroupId,
    localizationsByGroupId,
    summary: {
      processedGroups: allLocalized.length,
      reliableGroups: reliable.length,
      ambiguousCorrespondences: ambiguous,
      correspondenceCoverage:
        allLocalized.length === 0 ? 0 : roundMetric(reliable.length / allLocalized.length),
      correspondenceConfidence:
        reliable.length === 0
          ? 0
          : roundMetric(
              reliable.reduce((sum, localization) => sum + localization.confidence, 0) /
                reliable.length,
            ),
    },
    profile,
  };
}

function localizeSingleGroup(params: {
  groupId: string;
  groupBox: BoundingBox;
  previewGray: ImageLike;
  previewEdge: ImageLike;
  referenceGray: ImageLike;
  referenceEdge: ImageLike;
  referenceCache: ReturnType<typeof buildReferenceSearchCache>;
  alignment: GlobalAlignment;
  width: number;
  height: number;
  projectedDelta?: { dx: number; dy: number; dw: number; dh: number };
  projectedPadding?: number;
}): {
  localization: GroupLocalization;
  denseSearchFallbackUsed: boolean;
  refinedCandidateCount: number;
  refinementMs: number;
  totalMs: number;
} {
  const startedAt = performance.now();
  const previewGrayPatch = cropImage(params.previewGray, params.groupBox);
  const previewEdgePatch = cropImage(params.previewEdge, params.groupBox);
  const searchWindow = params.projectedDelta
    ? buildProjectedSearchWindow(
        params.groupBox,
        params.projectedDelta,
        params.projectedPadding ?? CORRESPONDENCE_PROJECTED_SEARCH_DEFAULT_PADDING_PX,
        params.width,
        params.height,
      )
    : buildSearchWindow(params.groupBox, params.alignment, params.width, params.height);
  const coarse = runCoarseSearch({
    previewGrayPatch,
    previewEdgePatch,
    searchWindow,
    referenceCache: params.referenceCache,
  });

  if (coarse.candidates.length === 0) {
    return {
      localization: missingLocalization(params.groupId),
      denseSearchFallbackUsed: coarse.denseFallbackUsed,
      refinedCandidateCount: 0,
      refinementMs: 0,
      totalMs: performance.now() - startedAt,
    };
  }

  const refineStartedAt = performance.now();
  const refined = refineCandidates({
    coarseCandidates: coarse.candidates,
    previewGrayPatch,
    previewEdgePatch,
    referenceGray: params.referenceGray,
    referenceEdge: params.referenceEdge,
    mode: selectRefinementMode(
      params.groupBox,
      params.groupId,
      params.previewGray,
      params.previewEdge,
    ),
  });
  const refinementMs = performance.now() - refineStartedAt;

  return {
    localization: validateLocalization({
      groupId: params.groupId,
      groupBox: params.groupBox,
      alignment: params.alignment,
      refined,
      previewGrayPatch,
      previewEdgePatch,
      referenceGray: params.referenceGray,
      referenceEdge: params.referenceEdge,
    }),
    denseSearchFallbackUsed: coarse.denseFallbackUsed,
    refinedCandidateCount: refined.length,
    refinementMs,
    totalMs: performance.now() - startedAt,
  };
}

function projectChildLocalizations(
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): void {
  for (const group of groupsById.values()) {
    if (localizationsByGroupId.has(group.id)) {
      continue;
    }

    const ancestorLocalization =
      nearestLocalizedAncestor(group, groupsById, localizationsByGroupId) ??
      bestLocalizedSibling(group, groupsById, localizationsByGroupId);

    if (
      !ancestorLocalization ||
      !ancestorLocalization.matchedReferenceBBox ||
      !ancestorLocalization.delta
    ) {
      continue;
    }

    const projectedConfidence = roundMetric(Math.max(0.45, ancestorLocalization.confidence - 0.12));
    const projectedAmbiguity = roundMetric(Math.min(1, ancestorLocalization.ambiguity + 0.08));

    if (
      projectedConfidence < CORRESPONDENCE_PROJECTED_CONFIDENCE_MIN &&
      group.bbox.width * group.bbox.height > CORRESPONDENCE_SMALL_GROUP_AREA_PX
    ) {
      continue;
    }

    localizationsByGroupId.set(group.id, {
      groupId: group.id,
      attempted: true,
      found: true,
      reliable:
        projectedConfidence >= CORRESPONDENCE_PROJECTED_RELIABLE_CONFIDENCE &&
        projectedAmbiguity <= CORRESPONDENCE_PROJECTED_RELIABLE_AMBIGUITY,
      method: "projected",
      confidence: projectedConfidence,
      ambiguity: projectedAmbiguity,
      matchedReferenceBBox: {
        x: group.bbox.x + ancestorLocalization.delta.dx,
        y: group.bbox.y + ancestorLocalization.delta.dy,
        width: group.bbox.width + ancestorLocalization.delta.dw,
        height: group.bbox.height + ancestorLocalization.delta.dh,
      },
      delta: {
        dx: ancestorLocalization.delta.dx,
        dy: ancestorLocalization.delta.dy,
        dw: ancestorLocalization.delta.dw,
        dh: ancestorLocalization.delta.dh,
      },
      scores: {
        ...ancestorLocalization.scores,
        structural: roundMetric(Math.max(0.5, ancestorLocalization.scores.structural - 0.05)),
      },
    });
  }
}

function buildProjectedRefinementCandidates(
  groups: GroupNode[],
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): Array<{ group: GroupNode; delta: NonNullable<GroupLocalization["delta"]> }> {
  const candidates: Array<{ group: GroupNode; delta: NonNullable<GroupLocalization["delta"]> }> =
    [];

  for (const group of groups) {
    if (localizationsByGroupId.has(group.id)) {
      continue;
    }

    const ancestorLocalization = nearestLocalizedAncestor(
      group,
      groupsById,
      localizationsByGroupId,
    );

    if (
      !ancestorLocalization?.delta ||
      ancestorLocalization.confidence < CORRESPONDENCE_PROJECTED_REFINEMENT_MIN_CONFIDENCE
    ) {
      continue;
    }

    if (!group.traits.hasOwnText && !group.traits.isInteractive) {
      continue;
    }

    candidates.push({
      group,
      delta: ancestorLocalization.delta,
    });
  }

  return candidates.sort((left, right) => {
    const leftScore =
      (left.group.traits.hasOwnText ? 2 : 0) +
      (left.group.traits.isInteractive ? 1 : 0) +
      left.group.area / 10_000;
    const rightScore =
      (right.group.traits.hasOwnText ? 2 : 0) +
      (right.group.traits.isInteractive ? 1 : 0) +
      right.group.area / 10_000;

    return rightScore - leftScore;
  });
}

function buildChildLocalSearchCandidates(
  groups: GroupNode[],
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): Array<{
  group: GroupNode;
  delta: NonNullable<GroupLocalization["delta"]>;
  padding: number;
}> {
  const candidates: Array<{
    group: GroupNode;
    delta: NonNullable<GroupLocalization["delta"]>;
    padding: number;
  }> = [];

  for (const group of groups) {
    if (localizationsByGroupId.has(group.id)) {
      continue;
    }

    if (!group.traits.hasOwnText && !group.traits.isInteractive && !group.traits.isGraphicsOnly) {
      continue;
    }

    const prior =
      bestLocalizedSibling(group, groupsById, localizationsByGroupId) ??
      nearestLocalizedAncestor(group, groupsById, localizationsByGroupId);

    if (!prior?.delta || prior.confidence < CORRESPONDENCE_CHILD_SEARCH_MIN_CONFIDENCE) {
      continue;
    }

    candidates.push({
      group,
      delta: prior.delta,
      padding: group.traits.hasOwnText
        ? CORRESPONDENCE_CHILD_SEARCH_TEXT_PADDING_PX
        : CORRESPONDENCE_CHILD_SEARCH_GRAPHICS_PADDING_PX,
    });
  }

  return candidates.sort((left, right) => {
    const leftScore =
      (left.group.traits.hasOwnText ? 3 : 0) +
      (left.group.traits.isInteractive ? 2 : 0) +
      (left.group.traits.isGraphicsOnly ? 1 : 0);
    const rightScore =
      (right.group.traits.hasOwnText ? 3 : 0) +
      (right.group.traits.isInteractive ? 2 : 0) +
      (right.group.traits.isGraphicsOnly ? 1 : 0);

    return rightScore - leftScore;
  });
}

function buildSpecializedFallbackCandidates(
  groups: GroupNode[],
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): Array<{
  group: GroupNode;
  delta?: NonNullable<GroupLocalization["delta"]>;
  padding?: number;
}> {
  const textCandidates = groups
    .filter((group) => !localizationsByGroupId.has(group.id) && group.traits.hasOwnText)
    .sort((left, right) => {
      if (left.mismatchWeight !== right.mismatchWeight) {
        return right.mismatchWeight - left.mismatchWeight;
      }

      return right.area - left.area;
    })
    .slice(0, CORRESPONDENCE_MAX_TEXT_FALLBACKS)
    .map((group) => ({ group }));

  const graphicsCandidates = groups
    .filter(
      (group) =>
        !localizationsByGroupId.has(group.id) &&
        group.traits.isGraphicsOnly &&
        group.area <= CORRESPONDENCE_SMALL_GRAPHICS_MAX_AREA_PX,
    )
    .map((group) => {
      const prior =
        bestLocalizedSibling(group, groupsById, localizationsByGroupId) ??
        nearestLocalizedAncestor(group, groupsById, localizationsByGroupId);

      return prior?.delta
        ? {
            group,
            delta: prior.delta,
            padding: CORRESPONDENCE_GRAPHICS_FALLBACK_PADDING_PX,
            confidence: prior.confidence,
          }
        : null;
    })
    .filter(
      (
        candidate,
      ): candidate is {
        group: GroupNode;
        delta: NonNullable<GroupLocalization["delta"]>;
        padding: number;
        confidence: number;
      } => candidate !== null,
    )
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, CORRESPONDENCE_MAX_GRAPHICS_FALLBACKS)
    .map(({ confidence: _confidence, ...candidate }) => candidate);

  return [...textCandidates, ...graphicsCandidates];
}

function buildRelativeTinyGraphicsCandidates(
  groups: GroupNode[],
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): Array<{
  group: GroupNode;
  delta: NonNullable<GroupLocalization["delta"]>;
  padding: number;
}> {
  const candidates: Array<{
    group: GroupNode;
    delta: NonNullable<GroupLocalization["delta"]>;
    padding: number;
    confidence: number;
  }> = [];

  for (const group of groups) {
    if (localizationsByGroupId.has(group.id)) {
      continue;
    }

    if (!group.traits.isGraphicsOnly || group.area > CORRESPONDENCE_RELATIVE_ICON_MAX_AREA_PX) {
      continue;
    }

    const ancestorPrior = nearestLocalizedAncestorWithGroup(
      group,
      groupsById,
      localizationsByGroupId,
    );

    if (!ancestorPrior?.localization.matchedReferenceBBox) {
      continue;
    }

    const expectedBox = projectBoxFromAncestor(
      group.bbox,
      ancestorPrior.group.bbox,
      ancestorPrior.localization.matchedReferenceBBox,
    );

    candidates.push({
      group,
      delta: {
        dx: expectedBox.x - group.bbox.x,
        dy: expectedBox.y - group.bbox.y,
        dw: expectedBox.width - group.bbox.width,
        dh: expectedBox.height - group.bbox.height,
      },
      padding: CORRESPONDENCE_RELATIVE_ICON_PADDING_PX,
      confidence: ancestorPrior.localization.confidence,
    });
  }

  return candidates
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, CORRESPONDENCE_MAX_GRAPHICS_FALLBACKS)
    .map(({ confidence: _confidence, ...candidate }) => candidate);
}

function localizeTinyGraphicGroup(params: {
  groupId: string;
  groupBox: BoundingBox;
  previewGray: ImageLike;
  previewEdge: ImageLike;
  referenceGray: ImageLike;
  referenceEdge: ImageLike;
  width: number;
  height: number;
  projectedDelta: { dx: number; dy: number; dw: number; dh: number };
  projectedPadding: number;
}): {
  localization: GroupLocalization;
  refinedCandidateCount: number;
  refinementMs: number;
} {
  const startedAt = performance.now();
  const previewGrayPatch = cropImage(params.previewGray, params.groupBox);
  const previewEdgePatch = cropImage(params.previewEdge, params.groupBox);
  const previewGrayThumb = resizeToDimensions(previewGrayPatch, 10, 10);
  const previewEdgeThumb = resizeToDimensions(previewEdgePatch, 10, 10);
  const searchWindow = buildProjectedSearchWindow(
    params.groupBox,
    params.projectedDelta,
    params.projectedPadding,
    params.width,
    params.height,
  );
  const maxX = searchWindow.width - params.groupBox.width;
  const maxY = searchWindow.height - params.groupBox.height;

  if (maxX < 0 || maxY < 0) {
    return {
      localization: missingLocalization(params.groupId),
      refinedCandidateCount: 0,
      refinementMs: performance.now() - startedAt,
    };
  }

  let best = {
    bbox: {
      x: searchWindow.x,
      y: searchWindow.y,
      width: params.groupBox.width,
      height: params.groupBox.height,
    },
    score: Number.NEGATIVE_INFINITY,
    method: "template+edge" as "template" | "template+edge",
  };

  for (let y = 0; y <= maxY; y += 1) {
    for (let x = 0; x <= maxX; x += 1) {
      const bbox = {
        x: searchWindow.x + x,
        y: searchWindow.y + y,
        width: params.groupBox.width,
        height: params.groupBox.height,
      };
      const grayThumb = resizeToDimensions(cropImage(params.referenceGray, bbox), 10, 10);
      const edgeThumb = resizeToDimensions(cropImage(params.referenceEdge, bbox), 10, 10);
      const grayScore = thumbnailSimilarity(previewGrayThumb, grayThumb);
      const edgeScore = edgeOverlap(previewEdgeThumb, edgeThumb);
      const score = grayScore * 0.3 + edgeScore * 0.7;

      if (score > best.score) {
        best = {
          bbox,
          score,
          method: edgeScore >= grayScore ? "template+edge" : "template",
        };
      }
    }
  }

  if (best.score < CORRESPONDENCE_TINY_ICON_MIN_SCORE) {
    return {
      localization: missingLocalization(params.groupId),
      refinedCandidateCount: 1,
      refinementMs: performance.now() - startedAt,
    };
  }

  const confidence = roundMetric(best.score);

  return {
    localization: {
      groupId: params.groupId,
      attempted: true,
      found: true,
      reliable: confidence >= CORRESPONDENCE_TINY_ICON_RELIABLE_CONFIDENCE,
      method: best.method,
      confidence,
      ambiguity: 0.2,
      matchedReferenceBBox: best.bbox,
      delta: {
        dx: best.bbox.x - params.groupBox.x,
        dy: best.bbox.y - params.groupBox.y,
        dw: 0,
        dh: 0,
      },
      scores: {
        thumbnail: confidence,
        edge: confidence,
        ssim: confidence,
        geometry: 0.8,
        structural: 0.8,
      },
    },
    refinedCandidateCount: 1,
    refinementMs: performance.now() - startedAt,
  };
}

interface LocalizationAttemptMetrics {
  localization: GroupLocalization;
  refinedCandidateCount: number;
  refinementMs: number;
  totalMs?: number;
  denseSearchFallbackUsed?: boolean;
}

function recordLocalizationAttempt(
  profile: CorrespondenceProfile,
  localizationsByGroupId: Map<string, GroupLocalization>,
  groupId: string,
  result: LocalizationAttemptMetrics,
  persistMissing: boolean,
): void {
  if (!result.localization.found && !persistMissing) {
    return;
  }

  localizationsByGroupId.set(
    groupId,
    result.localization.found ? result.localization : missingLocalization(groupId),
  );
  profile.counts.groupsSearched += 1;
  profile.counts.candidateWindowsRefined += result.refinedCandidateCount;
  profile.counts.denseSearchFallbacks += result.denseSearchFallbackUsed ? 1 : 0;

  if (typeof result.totalMs === "number") {
    profile.timingsMs.coarseSearch = roundMetric(
      profile.timingsMs.coarseSearch + (result.totalMs - result.refinementMs),
    );
  }

  profile.timingsMs.refinement = roundMetric(profile.timingsMs.refinement + result.refinementMs);
}

function nearestLocalizedAncestor(
  group: GroupNode,
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): GroupLocalization | null {
  let currentParentId = group.parentGroupId;

  while (currentParentId) {
    const localization = localizationsByGroupId.get(currentParentId);

    if (localization?.found) {
      return localization;
    }

    currentParentId = groupsById.get(currentParentId)?.parentGroupId ?? null;
  }

  return null;
}

function nearestLocalizedAncestorWithGroup(
  group: GroupNode,
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): { group: GroupNode; localization: GroupLocalization } | null {
  let currentParentId = group.parentGroupId;

  while (currentParentId) {
    const localization = localizationsByGroupId.get(currentParentId);
    const parentGroup = groupsById.get(currentParentId);

    if (localization?.found && parentGroup) {
      return {
        group: parentGroup,
        localization,
      };
    }

    currentParentId = groupsById.get(currentParentId)?.parentGroupId ?? null;
  }

  return null;
}

function bestLocalizedSibling(
  group: GroupNode,
  groupsById: Map<string, GroupNode>,
  localizationsByGroupId: Map<string, GroupLocalization>,
): GroupLocalization | null {
  if (!group.parentGroupId) {
    return null;
  }

  const parent = groupsById.get(group.parentGroupId);

  if (!parent) {
    return null;
  }

  let best: GroupLocalization | null = null;

  for (const siblingId of parent.childGroupIds) {
    if (siblingId === group.id) {
      continue;
    }

    const localization = localizationsByGroupId.get(siblingId);

    if (!localization?.found || !localization.delta) {
      continue;
    }

    if (!best || localization.confidence > best.confidence) {
      best = localization;
    }
  }

  return best;
}

function buildProjectedSearchWindow(
  groupBox: BoundingBox,
  delta: { dx: number; dy: number; dw: number; dh: number },
  padding: number,
  width: number,
  height: number,
): BoundingBox {
  const projected = {
    x: groupBox.x + delta.dx,
    y: groupBox.y + delta.dy,
    width: Math.max(1, groupBox.width + delta.dw),
    height: Math.max(1, groupBox.height + delta.dh),
  };

  return {
    x: Math.max(0, projected.x - padding),
    y: Math.max(0, projected.y - padding),
    width:
      Math.min(width, projected.x + projected.width + padding) - Math.max(0, projected.x - padding),
    height:
      Math.min(height, projected.y + projected.height + padding) -
      Math.max(0, projected.y - padding),
  };
}

function projectBoxFromAncestor(
  childBox: BoundingBox,
  ancestorBox: BoundingBox,
  localizedAncestorBox: BoundingBox,
): BoundingBox {
  const relativeX = (childBox.x - ancestorBox.x) / Math.max(1, ancestorBox.width);
  const relativeY = (childBox.y - ancestorBox.y) / Math.max(1, ancestorBox.height);
  const relativeWidth = childBox.width / Math.max(1, ancestorBox.width);
  const relativeHeight = childBox.height / Math.max(1, ancestorBox.height);

  return {
    x: Math.round(localizedAncestorBox.x + localizedAncestorBox.width * relativeX),
    y: Math.round(localizedAncestorBox.y + localizedAncestorBox.height * relativeY),
    width: Math.max(1, Math.round(localizedAncestorBox.width * relativeWidth)),
    height: Math.max(1, Math.round(localizedAncestorBox.height * relativeHeight)),
  };
}

function missingLocalization(groupId: string): GroupLocalization {
  return {
    groupId,
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
  };
}

function validateLocalization(params: {
  groupId: string;
  groupBox: BoundingBox;
  alignment: GlobalAlignment;
  refined: ReturnType<typeof refineCandidates>;
  previewGrayPatch: ImageLike;
  previewEdgePatch: ImageLike;
  referenceGray: ImageLike;
  referenceEdge: ImageLike;
}): GroupLocalization {
  const best = params.refined[0];
  const second = params.refined[1];

  if (!best) {
    return missingLocalization(params.groupId);
  }

  const referenceGrayPatch = cropImage(params.referenceGray, best.bbox);
  const referenceEdgePatch = cropImage(params.referenceEdge, best.bbox);
  const thumbnail = thumbnailSimilarity(params.previewGrayPatch, referenceGrayPatch);
  const edge = edgeOverlap(params.previewEdgePatch, referenceEdgePatch);
  const ssim = structuralSimilarity(params.previewGrayPatch, referenceGrayPatch);
  const geometry = geometryConsistency(params.groupBox, best.bbox, params.alignment);
  const structural = structuralConsistency(params.groupBox, best.bbox);
  const confidence = roundMetric(
    thumbnail * 0.35 + edge * 0.2 + ssim * 0.2 + geometry * 0.15 + structural * 0.1,
  );
  const ambiguity = roundMetric(
    clamp01(
      (second ? Math.max(0, 0.2 - (best.score - second.score)) : 0) +
        Math.max(0, CORRESPONDENCE_CONFIDENCE_RELIABLE - confidence),
    ),
  );

  return {
    groupId: params.groupId,
    attempted: true,
    found: true,
    reliable:
      confidence >= CORRESPONDENCE_CONFIDENCE_RELIABLE &&
      ambiguity <= CORRESPONDENCE_AMBIGUITY_THRESHOLD,
    method: edge > thumbnail ? "template+edge" : "template",
    confidence,
    ambiguity,
    matchedReferenceBBox: best.bbox,
    delta: {
      dx: Math.round(best.bbox.x - params.groupBox.x),
      dy: Math.round(best.bbox.y - params.groupBox.y),
      dw: Math.round(best.bbox.width - params.groupBox.width),
      dh: Math.round(best.bbox.height - params.groupBox.height),
    },
    scores: {
      thumbnail: roundMetric(thumbnail),
      edge: roundMetric(edge),
      ssim: roundMetric(ssim),
      geometry: roundMetric(geometry),
      structural: roundMetric(structural),
    },
  };
}

function estimateGlobalAlignment(preview: ImageLike, reference: ImageLike): GlobalAlignment {
  const previewSmall = resizeForAlignment(preview);
  const referenceSmall = resizeForAlignment(reference);
  let best = {
    tx: 0,
    ty: 0,
    score: scoreTranslation(previewSmall.image, referenceSmall.image, 0, 0),
  };

  for (let ty = -12; ty <= 12; ty += 2) {
    for (let tx = -12; tx <= 12; tx += 2) {
      const score = scoreTranslation(previewSmall.image, referenceSmall.image, tx, ty);

      if (score > best.score) {
        best = { tx, ty, score };
      }
    }
  }

  return {
    method: "translation",
    score: roundMetric(best.score),
    reliable: best.score >= CORRESPONDENCE_ALIGNMENT_RELIABLE_THRESHOLD,
    transform: {
      tx: roundMetric(best.tx / previewSmall.scale),
      ty: roundMetric(best.ty / previewSmall.scale),
      scale: 1,
    },
  };
}

function buildSearchWindow(
  groupBox: BoundingBox,
  alignment: GlobalAlignment,
  width: number,
  height: number,
): BoundingBox {
  const tx = alignment.transform?.tx ?? 0;
  const ty = alignment.transform?.ty ?? 0;
  const expandX = alignment.reliable
    ? Math.max(20, groupBox.width * 0.25)
    : Math.max(48, groupBox.width * 0.5);
  const expandY = alignment.reliable
    ? Math.max(20, groupBox.height * 0.25)
    : Math.max(48, groupBox.height * 0.5);
  const x = Math.max(0, Math.floor(groupBox.x + tx - expandX));
  const y = Math.max(0, Math.floor(groupBox.y + ty - expandY));
  const right = Math.min(width, Math.ceil(groupBox.x + tx + groupBox.width + expandX));
  const bottom = Math.min(height, Math.ceil(groupBox.y + ty + groupBox.height + expandY));

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function resizeForAlignment(image: ImageLike): { image: ImageLike; scale: number } {
  const maxSide = 96;
  const currentMax = Math.max(image.width, image.height);

  if (currentMax <= maxSide) {
    return { image, scale: 1 };
  }

  const scale = maxSide / currentMax;
  const resized = resizeToNearest(image, scale);
  return { image: resized, scale };
}

function resizeToNearest(image: ImageLike, scale: number): ImageLike {
  const width = Math.max(16, Math.round(image.width * scale));
  const height = Math.max(16, Math.round(image.height * scale));
  const data = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        image.width - 1,
        Math.round((x / Math.max(1, width - 1)) * (image.width - 1)),
      );
      const sourceY = Math.min(
        image.height - 1,
        Math.round((y / Math.max(1, height - 1)) * (image.height - 1)),
      );
      data[y * width + x] = image.data[sourceY * image.width + sourceX];
    }
  }

  return { width, height, data };
}

function scoreTranslation(
  preview: ImageLike,
  reference: ImageLike,
  tx: number,
  ty: number,
): number {
  const overlapLeft = Math.max(0, tx);
  const overlapTop = Math.max(0, ty);
  const referenceLeft = Math.max(0, -tx);
  const referenceTop = Math.max(0, -ty);
  const overlapWidth = Math.min(preview.width - overlapLeft, reference.width - referenceLeft);
  const overlapHeight = Math.min(preview.height - overlapTop, reference.height - referenceTop);

  if (overlapWidth <= 4 || overlapHeight <= 4) {
    return 0;
  }

  let diff = 0;
  let count = 0;

  for (let y = 0; y < overlapHeight; y += 2) {
    for (let x = 0; x < overlapWidth; x += 2) {
      const previewValue = preview.data[(overlapTop + y) * preview.width + overlapLeft + x];
      const referenceValue =
        reference.data[(referenceTop + y) * reference.width + referenceLeft + x];
      diff += Math.abs(previewValue - referenceValue);
      count += 1;
    }
  }

  return 1 - diff / (count * 255);
}

function thumbnailSimilarity(left: ImageLike, right: ImageLike): number {
  const leftThumb = resizeToDimensions(left, 12, 12);
  const rightThumb = resizeToDimensions(right, 12, 12);
  let diff = 0;

  for (let index = 0; index < leftThumb.data.length; index += 1) {
    diff += Math.abs(leftThumb.data[index] - rightThumb.data[index]);
  }

  return clamp01(1 - diff / (leftThumb.data.length * 255));
}

function edgeOverlap(left: ImageLike, right: ImageLike): number {
  const leftThumb = resizeToDimensions(left, 12, 12);
  const rightThumb = resizeToDimensions(right, 12, 12);
  let overlap = 0;
  let union = 0;

  for (let index = 0; index < leftThumb.data.length; index += 1) {
    const leftEdge = leftThumb.data[index] > 0 ? 1 : 0;
    const rightEdge = rightThumb.data[index] > 0 ? 1 : 0;

    if (leftEdge || rightEdge) {
      union += 1;
    }

    if (leftEdge && rightEdge) {
      overlap += 1;
    }
  }

  return union === 0 ? 1 : overlap / union;
}

function structuralSimilarity(left: ImageLike, right: ImageLike): number {
  const length = Math.min(left.data.length, right.data.length);
  let leftMean = 0;
  let rightMean = 0;

  for (let index = 0; index < length; index += 1) {
    leftMean += left.data[index];
    rightMean += right.data[index];
  }

  leftMean /= length;
  rightMean /= length;

  let leftVar = 0;
  let rightVar = 0;
  let covariance = 0;

  for (let index = 0; index < length; index += 1) {
    const leftDelta = left.data[index] - leftMean;
    const rightDelta = right.data[index] - rightMean;
    leftVar += leftDelta * leftDelta;
    rightVar += rightDelta * rightDelta;
    covariance += leftDelta * rightDelta;
  }

  leftVar /= length;
  rightVar /= length;
  covariance /= length;

  const c1 = 6.5025;
  const c2 = 58.5225;
  const numerator = (2 * leftMean * rightMean + c1) * (2 * covariance + c2);
  const denominator =
    (leftMean * leftMean + rightMean * rightMean + c1) * (leftVar + rightVar + c2);

  return denominator <= 0 ? 0 : clamp01(numerator / denominator);
}

function geometryConsistency(
  groupBox: BoundingBox,
  candidateBox: BoundingBox,
  alignment: GlobalAlignment,
): number {
  const expectedX = groupBox.x + (alignment.transform?.tx ?? 0);
  const expectedY = groupBox.y + (alignment.transform?.ty ?? 0);
  const diagonal = Math.sqrt(groupBox.width ** 2 + groupBox.height ** 2);
  const centerDistance = Math.sqrt(
    (candidateBox.x - expectedX) ** 2 + (candidateBox.y - expectedY) ** 2,
  );

  return clamp01(1 - centerDistance / Math.max(1, diagonal * 2));
}

function structuralConsistency(groupBox: BoundingBox, candidateBox: BoundingBox): number {
  const widthRatio = Math.abs(candidateBox.width - groupBox.width) / Math.max(1, groupBox.width);
  const heightRatio =
    Math.abs(candidateBox.height - groupBox.height) / Math.max(1, groupBox.height);
  return clamp01(1 - (widthRatio + heightRatio) / 2);
}

function selectRefinementMode(
  groupBox: BoundingBox,
  groupId: string,
  previewGray: ImageLike,
  previewEdge: ImageLike,
): RefinementMode {
  const patch = cropImage(previewGray, groupBox);
  const edgePatch = cropImage(previewEdge, groupBox);
  const edgeDensity =
    edgePatch.data.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0) / edgePatch.data.length;
  const fillRatio =
    patch.data.reduce((sum, value) => sum + (value < 235 ? 1 : 0), 0) / patch.data.length;
  const smallArea = groupBox.width * groupBox.height <= CORRESPONDENCE_SMALL_GROUP_AREA_PX;
  const textLikeShape = groupBox.height <= 64 && groupBox.width >= groupBox.height * 2;

  if (textLikeShape && fillRatio < 0.35) {
    return "text";
  }

  if (smallArea || (edgeDensity > 0.16 && fillRatio < 0.5)) {
    return "graphics";
  }

  return "generic";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

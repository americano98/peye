import { createHash } from "node:crypto";
import {
  DEFAULT_CLUSTER_PADDING_PX,
  DEFAULT_DOM_OVERLAP_THRESHOLD,
  DEFAULT_HOTSPOT_CLUSTER_PADDING_PX,
  DEFAULT_HOTSPOT_LIMIT_PER_FINDING,
  DEFAULT_MAX_TAG_ROLLUPS,
  DEFAULT_REPORT_FINDINGS_LIMIT,
} from "../config/defaults.js";
import type {
  ComparisonRegion,
  DomBindingCandidate,
  DomSnapshot,
  DomSnapshotElement,
} from "../types/internal.js";
import type {
  ActionTargetReport,
  AffectedPropertyCode,
  AnalysisMode,
  BoundingBox,
  CaptureEdge,
  FindingCode,
  FindingContextReport,
  FindingElementReport,
  FindingEvidenceRefReport,
  FindingReport,
  FindingMetricKey,
  FindingSignalReport,
  FindingSource,
  IssueType,
  KindRollup,
  OmittedRegionRollup,
  OmittedSelectorRollup,
  RegionKind,
  RollupsReport,
  RootCauseGroupId,
  Severity,
  SeverityRollup,
  TagRollup,
} from "../types/report.js";
import { rootCauseGroupIdForFinding } from "./root-cause-groups.js";
import { AppError } from "../utils/errors.js";
import { compareSeverityDescending, maxSeverity } from "../utils/severity.js";

interface DraftFinding {
  rootCauseGroupId: RootCauseGroupId;
  source: FindingSource;
  kind: RegionKind;
  code: FindingCode;
  severity: Severity;
  confidence: number;
  summary: string;
  fixHint: string;
  bbox: BoundingBox;
  regionCount: number;
  mismatchPixels: number;
  mismatchPercentOfCanvas: number;
  issueTypes: IssueType[];
  likelyAffectedProperties: AffectedPropertyCode[];
  signals: FindingSignalReport[];
  evidenceRefs: FindingEvidenceRefReport[];
  hotspots: BoundingBox[];
  actionTarget: ActionTargetReport | null;
  element: FindingElementReport | null;
  context: FindingContextReport | null;
}

interface DraftFindingGroup {
  finding: DraftFinding;
  regions: ComparisonRegion[];
}

interface DomAssignmentResult {
  candidate: DomBindingCandidate;
  anchor: DomSnapshotElement;
  context: FindingContextReport;
  assignmentConfidence: number;
  region: ComparisonRegion;
}

export interface FindingVisualization {
  severity: Severity;
  primaryBox: BoundingBox;
  hotspotBoxes: BoundingBox[];
}

const FINDING_KIND_ORDER: RegionKind[] = ["dimension", "mixed", "layout", "color", "pixel"];
const WEAK_DOM_ASSIGNMENT_THRESHOLD = 0.1;

export function buildFindingsAnalysis(params: {
  analysisMode: AnalysisMode;
  rawRegions: ComparisonRegion[];
  domSnapshot: DomSnapshot | null;
  width: number;
  height: number;
}): {
  findings: FindingReport[];
  fullFindings: FindingReport[];
  rollups: RollupsReport;
  metrics: {
    findingsCount: number;
    affectedElementCount: number;
  };
  visuals: FindingVisualization[];
} {
  const totalPixels = params.width * params.height;
  const draftFindingGroups =
    params.analysisMode === "dom-elements"
      ? buildDomFindings(
          params.rawRegions,
          params.domSnapshot,
          params.width,
          params.height,
          totalPixels,
        )
      : buildVisualClusterFindings(params.rawRegions, totalPixels, params.width, params.height);
  const sortedGroups = draftFindingGroups.sort((left, right) =>
    compareDraftFindings(left.finding, right.finding),
  );
  const sortedFindings = assignStableFindingIds(
    sortedGroups.map((group) => group.finding),
    params.width,
    params.height,
  );
  const limitedFindings = sortedFindings.slice(0, DEFAULT_REPORT_FINDINGS_LIMIT);
  const omittedFindings = sortedFindings.slice(DEFAULT_REPORT_FINDINGS_LIMIT);
  const affectedElementCount =
    params.analysisMode === "dom-elements"
      ? new Set(
          sortedFindings
            .map((finding) => finding.element?.selector ?? null)
            .filter((selector): selector is string => selector !== null),
        ).size
      : 0;

  return {
    findings: limitedFindings,
    fullFindings: sortedFindings,
    rollups: {
      bySeverity: buildSeverityRollups(sortedFindings),
      byKind: buildKindRollups(sortedFindings),
      byTag:
        params.analysisMode === "dom-elements"
          ? buildTagRollups(sortedFindings).slice(0, DEFAULT_MAX_TAG_ROLLUPS)
          : [],
      rawRegionCount: params.rawRegions.length,
      findingsCount: sortedFindings.length,
      affectedElementCount,
      omittedFindings: omittedFindings.length,
      omittedBySeverity: buildSeverityRollups(omittedFindings),
      omittedByKind: buildKindRollups(omittedFindings),
      topOmittedSelectors: buildTopOmittedSelectors(omittedFindings),
      largestOmittedRegions: buildLargestOmittedRegions(omittedFindings),
      tailAreaPercent: Number(
        omittedFindings
          .reduce((sum, finding) => sum + finding.mismatchPercentOfCanvas, 0)
          .toFixed(4),
      ),
    },
    metrics: {
      findingsCount: sortedFindings.length,
      affectedElementCount,
    },
    visuals: sortedGroups.map((group) => {
      const primaryBox = group.finding.element?.bbox ?? group.finding.bbox;

      return {
        severity: group.finding.severity,
        primaryBox,
        hotspotBoxes: group.finding.hotspots,
      };
    }),
  };
}

function assignStableFindingIds(
  findings: DraftFinding[],
  canvasWidth: number,
  canvasHeight: number,
): FindingReport[] {
  const baseIds = findings.map((finding) =>
    buildStableFindingBaseId(finding, canvasWidth, canvasHeight),
  );
  const collisions = new Map<string, number[]>();

  for (let index = 0; index < baseIds.length; index += 1) {
    const baseId = baseIds[index];
    const existing = collisions.get(baseId);

    if (existing) {
      existing.push(index);
    } else {
      collisions.set(baseId, [index]);
    }
  }

  const ids = new Array<string>(findings.length);

  for (const [baseId, indexes] of collisions.entries()) {
    if (indexes.length === 1) {
      ids[indexes[0]] = baseId;
      continue;
    }

    indexes
      .slice()
      .sort((leftIndex, rightIndex) =>
        compareStableIdCollision(findings[leftIndex], findings[rightIndex]),
      )
      .forEach((findingIndex, collisionIndex) => {
        ids[findingIndex] =
          collisionIndex === 0
            ? baseId
            : `${baseId}-${String(collisionIndex + 1).padStart(2, "0")}`;
      });
  }

  return findings.map((finding, index) => ({
    id: ids[index],
    ...finding,
  }));
}

function buildStableFindingBaseId(
  finding: DraftFinding,
  canvasWidth: number,
  canvasHeight: number,
): string {
  const primaryBox = primaryBoxForFinding(finding);
  const signature = [
    finding.code,
    finding.source,
    ...normalizeBoxForStableSignature(primaryBox, canvasWidth, canvasHeight),
    targetKeyForFinding(finding),
    [...finding.issueTypes].sort().join(","),
  ].join("|");

  return `finding-${createHash("sha256").update(signature).digest("hex").slice(0, 12)}`;
}

function normalizeBoxForStableSignature(
  box: BoundingBox,
  canvasWidth: number,
  canvasHeight: number,
): [string, string, string, string] {
  const safeWidth = Math.max(1, canvasWidth);
  const safeHeight = Math.max(1, canvasHeight);

  return [
    (box.x / safeWidth).toFixed(4),
    (box.y / safeHeight).toFixed(4),
    (box.width / safeWidth).toFixed(4),
    (box.height / safeHeight).toFixed(4),
  ];
}

function primaryBoxForFinding(
  finding: Pick<DraftFinding, "bbox" | "element"> | Pick<FindingReport, "bbox" | "element">,
): BoundingBox {
  return finding.element?.bbox ?? finding.bbox;
}

function targetKeyForFinding(
  finding:
    | Pick<DraftFinding, "actionTarget" | "element">
    | Pick<FindingReport, "actionTarget" | "element">,
): string {
  const selector = selectorHintForFinding(finding);

  if (selector) {
    return selector;
  }

  return fallbackTargetKeyForFinding(finding);
}

function selectorHintForFinding(
  finding:
    | Pick<DraftFinding, "actionTarget" | "element">
    | Pick<FindingReport, "actionTarget" | "element">,
): string | null {
  return finding.actionTarget?.selector ?? finding.element?.selector ?? null;
}

function fallbackTargetKeyForFinding(
  finding:
    | Pick<DraftFinding, "actionTarget" | "element">
    | Pick<FindingReport, "actionTarget" | "element">,
): string {
  const tag = normalizeTargetFragment(finding.element?.tag ?? finding.actionTarget?.tag ?? null);
  const role = normalizeTargetFragment(finding.element?.role ?? finding.actionTarget?.role ?? null);
  const textSnippet = normalizeTargetFragment(
    finding.element?.textSnippet ?? finding.actionTarget?.textSnippet ?? null,
  );

  if (tag === null && role === null && textSnippet === null) {
    return "visual-cluster";
  }

  return [tag ?? "", role ?? "", textSnippet ?? ""].join("|");
}

function normalizeTargetFragment(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized.length === 0 ? null : normalized;
}

function compareStableIdCollision(left: DraftFinding, right: DraftFinding): number {
  const leftBox = primaryBoxForFinding(left);
  const rightBox = primaryBoxForFinding(right);

  for (const delta of [
    leftBox.y - rightBox.y,
    leftBox.x - rightBox.x,
    leftBox.width - rightBox.width,
    leftBox.height - rightBox.height,
  ]) {
    if (delta !== 0) {
      return delta;
    }
  }

  if (left.mismatchPixels !== right.mismatchPixels) {
    return right.mismatchPixels - left.mismatchPixels;
  }

  const fallbackTargetOrder = fallbackTargetKeyForFinding(left).localeCompare(
    fallbackTargetKeyForFinding(right),
  );

  if (fallbackTargetOrder !== 0) {
    return fallbackTargetOrder;
  }

  return compareDraftFindings(left, right);
}

function buildDomFindings(
  rawRegions: ComparisonRegion[],
  domSnapshot: DomSnapshot | null,
  width: number,
  height: number,
  totalPixels: number,
): DraftFindingGroup[] {
  if (!domSnapshot) {
    throw new AppError("Preview URL capture did not produce a DOM snapshot.", {
      exitCode: 3,
      recommendation: "needs_human_review",
      severity: "high",
      code: "dom_snapshot_missing",
    });
  }

  if (rawRegions.length === 0) {
    return [];
  }

  const anchorsById = new Map(
    [domSnapshot.root, ...domSnapshot.elements].map((element) => [element.id, element]),
  );
  const groupsByAnchorId = new Map<
    string,
    {
      anchor: DomSnapshotElement;
      regions: ComparisonRegion[];
      assignments: DomAssignmentResult[];
    }
  >();

  for (const region of rawRegions) {
    const assignment = resolveDomAssignmentForRegion(
      region,
      domSnapshot.bindingCandidates,
      anchorsById,
    );
    const existing = groupsByAnchorId.get(assignment.anchor.id);

    if (existing) {
      existing.regions.push(region);
      existing.assignments.push(assignment);
    } else {
      groupsByAnchorId.set(assignment.anchor.id, {
        anchor: assignment.anchor,
        regions: [region],
        assignments: [assignment],
      });
    }
  }

  return Array.from(groupsByAnchorId.values(), ({ anchor, regions, assignments }) => {
    const representativeAssignment = selectRepresentativeDomAssignment(assignments);

    return {
      finding: buildDraftFinding({
        source: "dom-element",
        regions,
        totalPixels,
        element: anchor,
        signalElement: representativeAssignment.candidate,
        context: representativeAssignment.context,
        canvasWidth: width,
        canvasHeight: height,
      }),
      regions,
    };
  });
}

function buildVisualClusterFindings(
  rawRegions: ComparisonRegion[],
  totalPixels: number,
  width: number,
  height: number,
): DraftFindingGroup[] {
  if (rawRegions.length === 0) {
    return [];
  }

  const clusters = clusterRegions(rawRegions);
  return clusters.map((cluster) => ({
    finding: buildDraftFinding({
      source: "visual-cluster",
      regions: cluster,
      totalPixels,
      element: null,
      signalElement: null,
      context: null,
      canvasWidth: width,
      canvasHeight: height,
    }),
    regions: cluster,
  }));
}

function buildDraftFinding(params: {
  source: FindingSource;
  regions: ComparisonRegion[];
  totalPixels: number;
  element: DomSnapshotElement | null;
  signalElement: DomSnapshotElement | null;
  context: FindingContextReport | null;
  canvasWidth: number;
  canvasHeight: number;
}): DraftFinding {
  const bbox = unionRegionBoxes(params.regions);
  const mismatchPixels = params.regions.reduce((sum, region) => sum + region.pixelCount, 0);
  const kind = aggregateKind(params.regions);
  const elementReport = params.element ? toElementReport(params.element) : null;
  const actionTarget = params.element ? toActionTargetReport(params.element) : null;
  const primaryBox = elementReport?.bbox ?? bbox;
  const signals = buildFindingSignals({
    kind,
    bbox,
    element: params.signalElement,
    canvasWidth: params.canvasWidth,
    canvasHeight: params.canvasHeight,
  });
  const code = buildFindingCode(kind, signals);
  const hotspots = buildHotspotBoxes(params.regions, primaryBox);
  const issueTypes = issueTypesForKind(kind);
  const findingWithoutRootCause = {
    code,
    signals,
    element: elementReport,
  };

  return {
    rootCauseGroupId: rootCauseGroupIdForFinding(findingWithoutRootCause),
    source: params.source,
    kind,
    code,
    severity: maxSeverity(params.regions.map((region) => region.severity)),
    confidence: buildFindingConfidence({
      source: params.source,
      kind,
      signals,
      actionTarget,
    }),
    summary: buildFindingSummary(kind, elementReport?.tag ?? null),
    fixHint: findingFixHintForCode(code),
    bbox,
    regionCount: params.regions.length,
    mismatchPixels,
    mismatchPercentOfCanvas:
      params.totalPixels === 0
        ? 0
        : Number(((mismatchPixels / params.totalPixels) * 100).toFixed(4)),
    issueTypes,
    likelyAffectedProperties: findingAffectedPropertiesForCode(code),
    signals,
    evidenceRefs: buildFindingEvidenceRefs(code, signals, hotspots),
    hotspots,
    actionTarget,
    element: elementReport,
    context: params.context,
  };
}

function selectRepresentativeDomAssignment(
  assignments: DomAssignmentResult[],
): DomAssignmentResult {
  return assignments.slice().sort((left, right) => {
    if (left.assignmentConfidence !== right.assignmentConfidence) {
      return right.assignmentConfidence - left.assignmentConfidence;
    }

    if (left.region.pixelCount !== right.region.pixelCount) {
      return right.region.pixelCount - left.region.pixelCount;
    }

    return left.anchor.selector.localeCompare(right.anchor.selector);
  })[0];
}

function resolveDomAssignmentForRegion(
  region: ComparisonRegion,
  candidates: DomBindingCandidate[],
  anchorsById: Map<string, DomSnapshotElement>,
): DomAssignmentResult {
  const centerX = region.x + region.width / 2;
  const centerY = region.y + region.height / 2;
  const regionBox = {
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  };
  const centerHitCandidates = candidates
    .filter((candidate) => containsPoint(candidate.bbox, centerX, centerY))
    .map((candidate) => ({
      candidate,
      overlapScore: overlapRatio(regionBox, candidate.bbox),
    }));
  const overlapCandidates =
    centerHitCandidates.length > 0
      ? centerHitCandidates
      : candidates
          .map((candidate) => ({
            candidate,
            overlapScore: overlapRatio(regionBox, candidate.bbox),
          }))
          .filter(({ overlapScore }) => overlapScore > 0);
  const shortlist = overlapCandidates.slice().sort(compareBindingCandidates);

  if (shortlist.length === 0) {
    throw new AppError(
      `Could not assign mismatch region at (${region.x}, ${region.y}, ${region.width}x${region.height}) to a DOM element.`,
      {
        exitCode: 3,
        recommendation: "needs_human_review",
        severity: "high",
        code: "dom_region_assignment_failed",
      },
    );
  }

  const selected = shortlist[0];
  const isCenterHit = centerHitCandidates.length > 0;

  if (!isCenterHit && selected.overlapScore < WEAK_DOM_ASSIGNMENT_THRESHOLD) {
    throw new AppError(
      `Could not assign mismatch region at (${region.x}, ${region.y}, ${region.width}x${region.height}) to a DOM element.`,
      {
        exitCode: 3,
        recommendation: "needs_human_review",
        severity: "high",
        code: "dom_region_assignment_failed",
      },
    );
  }

  const anchor = anchorsById.get(selected.candidate.anchorElementId);

  if (!anchor) {
    throw new AppError(
      `DOM element snapshot missing for binding anchor ${selected.candidate.anchorElementId}.`,
      {
        exitCode: 3,
        recommendation: "needs_human_review",
        severity: "high",
        code: "dom_snapshot_element_missing",
      },
    );
  }

  const maxDepth = Math.max(...shortlist.map(({ candidate }) => candidate.depth), 1);
  const depthScore = Number((selected.candidate.depth / maxDepth).toFixed(4));
  const overlapScore = Number(selected.overlapScore.toFixed(4));
  const assignmentMethod =
    isCenterHit && selected.candidate.anchorElementId === selected.candidate.id
      ? "center-hit"
      : isCenterHit
        ? "ancestor-proxy"
        : "overlap-best-fit";
  const fallbackMarker =
    selected.candidate.anchorElementId !== selected.candidate.id
      ? "inline-proxy"
      : !isCenterHit && overlapScore < DEFAULT_DOM_OVERLAP_THRESHOLD
        ? "weak-overlap"
        : !isCenterHit
          ? "anchor-fallback"
          : "none";
  const baseConfidence =
    assignmentMethod === "center-hit" ? 0.82 : assignmentMethod === "ancestor-proxy" ? 0.7 : 0.58;
  const assignmentConfidence = roundConfidence(
    baseConfidence + overlapScore * 0.15 + depthScore * 0.1 - (fallbackMarker !== "none" ? 0.1 : 0),
  );

  return {
    candidate: selected.candidate,
    anchor,
    context: {
      binding: {
        assignmentMethod,
        assignmentConfidence,
        candidateCount: shortlist.length,
        overlapScore,
        depthScore,
        fallbackMarker,
        selectedCandidate: selected.candidate.locator,
        anchorElement: anchor.locator,
      },
      semantic: {
        ancestry: anchor.ancestry,
        identity: anchor.identity,
        computedStyle: anchor.computedStyle,
        textLayout: anchor.textLayout,
        visibility: anchor.visibility,
        interactivity: anchor.interactivity,
        overlapHints: selected.candidate.overlapHints,
      },
    },
    assignmentConfidence,
    region,
  };
}

function compareBindingCandidates(
  left: { candidate: DomBindingCandidate; overlapScore: number },
  right: { candidate: DomBindingCandidate; overlapScore: number },
): number {
  if (left.candidate.depth !== right.candidate.depth) {
    return right.candidate.depth - left.candidate.depth;
  }

  const leftArea = left.candidate.bbox.width * left.candidate.bbox.height;
  const rightArea = right.candidate.bbox.width * right.candidate.bbox.height;

  if (leftArea !== rightArea) {
    return leftArea - rightArea;
  }

  if (left.overlapScore !== right.overlapScore) {
    return right.overlapScore - left.overlapScore;
  }

  return left.candidate.selector.localeCompare(right.candidate.selector);
}

function clusterRegions(
  rawRegions: ComparisonRegion[],
  padding = DEFAULT_CLUSTER_PADDING_PX,
): ComparisonRegion[][] {
  const visited = new Uint8Array(rawRegions.length);
  const clusters: ComparisonRegion[][] = [];

  for (let index = 0; index < rawRegions.length; index += 1) {
    if (visited[index] === 1) {
      continue;
    }

    visited[index] = 1;
    const queue = [index];
    const cluster: ComparisonRegion[] = [];

    while (queue.length > 0) {
      const currentIndex = queue.shift();

      if (currentIndex === undefined) {
        break;
      }

      const currentRegion = rawRegions[currentIndex];
      cluster.push(currentRegion);

      for (let candidateIndex = 0; candidateIndex < rawRegions.length; candidateIndex += 1) {
        if (visited[candidateIndex] === 1) {
          continue;
        }

        if (expandedBoxesIntersect(currentRegion, rawRegions[candidateIndex], padding)) {
          visited[candidateIndex] = 1;
          queue.push(candidateIndex);
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

function expandedBoxesIntersect(left: BoundingBox, right: BoundingBox, padding: number): boolean {
  return boxesIntersect(expandBox(left, padding), expandBox(right, padding));
}

function expandBox(box: BoundingBox, padding: number): BoundingBox {
  return {
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + padding * 2,
    height: box.height + padding * 2,
  };
}

function boxesIntersect(left: BoundingBox, right: BoundingBox): boolean {
  return !(
    left.x + left.width < right.x ||
    right.x + right.width < left.x ||
    left.y + left.height < right.y ||
    right.y + right.height < left.y
  );
}

function containsPoint(box: BoundingBox, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

function overlapRatio(left: BoundingBox, right: BoundingBox): number {
  const intersectionWidth =
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const intersectionHeight =
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);

  if (intersectionWidth <= 0 || intersectionHeight <= 0) {
    return 0;
  }

  const regionArea = Math.max(1, left.width * left.height);
  return (intersectionWidth * intersectionHeight) / regionArea;
}

function unionRegionBoxes(regions: ComparisonRegion[]): BoundingBox {
  const minX = Math.min(...regions.map((region) => region.x));
  const minY = Math.min(...regions.map((region) => region.y));
  const maxX = Math.max(...regions.map((region) => region.x + region.width));
  const maxY = Math.max(...regions.map((region) => region.y + region.height));

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function buildHotspotBoxes(regions: ComparisonRegion[], primaryBox: BoundingBox): BoundingBox[] {
  if (regions.length <= 1) {
    return [];
  }

  return clusterRegions(regions, DEFAULT_HOTSPOT_CLUSTER_PADDING_PX)
    .map((cluster) => ({
      bbox: unionRegionBoxes(cluster),
      mismatchPixels: cluster.reduce((sum, region) => sum + region.pixelCount, 0),
    }))
    .filter(({ bbox }) => !isNearlySameBox(bbox, primaryBox))
    .sort((left, right) => {
      if (left.mismatchPixels !== right.mismatchPixels) {
        return right.mismatchPixels - left.mismatchPixels;
      }

      if (left.bbox.y !== right.bbox.y) {
        return left.bbox.y - right.bbox.y;
      }

      return left.bbox.x - right.bbox.x;
    })
    .slice(0, DEFAULT_HOTSPOT_LIMIT_PER_FINDING)
    .map(({ bbox }) => bbox);
}

function isNearlySameBox(left: BoundingBox, right: BoundingBox): boolean {
  const leftArea = Math.max(1, left.width * left.height);
  const rightArea = Math.max(1, right.width * right.height);
  const areaRatio = Math.min(leftArea, rightArea) / Math.max(leftArea, rightArea);

  return areaRatio >= 0.9 && overlapRatio(left, right) >= 0.9;
}

function aggregateKind(regions: ComparisonRegion[]): RegionKind {
  const kinds = new Set(regions.map((region) => region.kind));

  if (kinds.has("dimension")) {
    return "dimension";
  }

  if (kinds.has("mixed")) {
    return "mixed";
  }

  if (kinds.has("layout") && (kinds.has("color") || kinds.has("pixel"))) {
    return "mixed";
  }

  if (kinds.has("layout")) {
    return "layout";
  }

  if (kinds.has("color")) {
    return "color";
  }

  return "pixel";
}

function buildFindingSummary(kind: RegionKind, tag: string | null): string {
  const subject = tag ? `Element <${tag}>` : "Visual cluster";

  switch (kind) {
    case "dimension":
      return `${subject} has missing, extra, or misframed content.`;
    case "layout":
      return `${subject} has layout drift.`;
    case "color":
      return `${subject} has style drift.`;
    case "mixed":
      return `${subject} has layout and style drift.`;
    case "pixel":
    default:
      return `${subject} has rendering drift.`;
  }
}

function issueTypesForKind(kind: RegionKind): IssueType[] {
  switch (kind) {
    case "dimension":
      return ["missing_or_extra", "size"];
    case "layout":
      return ["position", "spacing"];
    case "color":
      return ["color", "style"];
    case "mixed":
      return ["position", "spacing", "style"];
    case "pixel":
    default:
      return ["style"];
  }
}

function buildFindingCode(kind: RegionKind, signals: FindingSignalReport[]): FindingCode {
  for (const signalCode of [
    "probable_text_clipping",
    "possible_capture_crop",
    "possible_viewport_mismatch",
  ] as const) {
    if (!signals.some((signal) => signal.code === signalCode)) {
      continue;
    }

    switch (signalCode) {
      case "probable_text_clipping":
        return "text_clipping";
      case "possible_capture_crop":
        return "capture_crop";
      case "possible_viewport_mismatch":
        return "viewport_mismatch";
      default:
        break;
    }
  }

  switch (kind) {
    case "dimension":
      return "missing_or_extra_content";
    case "mixed":
      return "layout_style_mismatch";
    case "layout":
      return "layout_mismatch";
    case "color":
      return "style_mismatch";
    case "pixel":
    default:
      return "rendering_mismatch";
  }
}

function findingFixHintForCode(code: FindingCode): string {
  switch (code) {
    case "text_clipping":
      return "Fix text overflow, line clamp, or available width.";
    case "capture_crop":
      return "Recapture with a broader selector scope or viewport.";
    case "viewport_mismatch":
      return "Verify viewport, selected frame, and capture target before retrying.";
    case "missing_or_extra_content":
      return "Verify the target content and frame, then fix missing or extra UI.";
    case "layout_mismatch":
      return "Fix positioning, spacing, or alignment.";
    case "style_mismatch":
      return "Fix colors, fills, borders, or shadows.";
    case "layout_style_mismatch":
      return "Fix both layout alignment and visual styles.";
    case "rendering_mismatch":
    default:
      return "Tighten typography, radius, or shadow styling.";
  }
}

function findingAffectedPropertiesForCode(code: FindingCode): AffectedPropertyCode[] {
  switch (code) {
    case "text_clipping":
      return ["text.overflow", "text.lineClamp", "size.width"];
    case "capture_crop":
      return ["capture.selectorScope", "capture.viewport"];
    case "viewport_mismatch":
      return ["capture.viewport", "reference.frame"];
    case "missing_or_extra_content":
      return ["size.width", "size.height", "reference.frame"];
    case "layout_mismatch":
      return ["layout.position", "layout.spacing", "layout.alignment"];
    case "style_mismatch":
      return ["style.color", "style.background", "style.border"];
    case "layout_style_mismatch":
      return ["layout.position", "layout.spacing", "style.color", "style.background"];
    case "rendering_mismatch":
    default:
      return ["style.typography", "style.shadow"];
  }
}

function buildFindingConfidence(params: {
  source: FindingSource;
  kind: RegionKind;
  signals: FindingSignalReport[];
  actionTarget: ActionTargetReport | null;
}): number {
  const baseline = baselineFindingConfidence(params.source, params.kind);
  const signalScore = params.signals.reduce((maxScore, signal) => {
    const score = signalConfidenceScore(signal.confidence);
    return score > maxScore ? score : maxScore;
  }, 0);
  const selectorBonus = params.actionTarget?.selector ? 0.05 : 0;

  return roundConfidence(Math.max(baseline, signalScore) + selectorBonus);
}

function baselineFindingConfidence(source: FindingSource, kind: RegionKind): number {
  if (source === "dom-element") {
    if (kind === "dimension") {
      return 0.78;
    }

    if (kind === "pixel") {
      return 0.64;
    }

    return 0.72;
  }

  if (kind === "dimension") {
    return 0.72;
  }

  if (kind === "pixel") {
    return 0.5;
  }

  return 0.58;
}

function signalConfidenceScore(confidence: FindingSignalReport["confidence"]): number {
  switch (confidence) {
    case "high":
      return 0.9;
    case "medium":
      return 0.75;
    case "low":
    default:
      return 0.55;
  }
}

function buildFindingEvidenceRefs(
  code: FindingCode,
  signals: FindingSignalReport[],
  hotspots: BoundingBox[],
): FindingEvidenceRefReport[] {
  const evidenceRefs: FindingEvidenceRefReport[] = signals.map((signal) => ({
    type: "signal",
    code: signal.code,
  }));
  const metricKey = metricKeyForFindingCode(code);

  if (metricKey) {
    evidenceRefs.push({
      type: "metric",
      key: metricKey,
    });
  }

  for (let index = 0; index < hotspots.length; index += 1) {
    evidenceRefs.push({
      type: "hotspot",
      index,
    });
  }

  evidenceRefs.push(
    {
      type: "artifact",
      key: "heatmap",
    },
    {
      type: "artifact",
      key: "diff",
    },
  );

  return evidenceRefs;
}

function metricKeyForFindingCode(code: FindingCode): FindingMetricKey {
  switch (code) {
    case "viewport_mismatch":
    case "missing_or_extra_content":
      return "dimensionMismatch";
    case "layout_mismatch":
    case "layout_style_mismatch":
      return "structuralMismatchPercent";
    case "style_mismatch":
      return "meanColorDelta";
    case "text_clipping":
    case "capture_crop":
    case "rendering_mismatch":
    default:
      return "mismatchPercent";
  }
}

function buildFindingSignals(params: {
  kind: RegionKind;
  bbox: BoundingBox;
  element: DomSnapshotElement | null;
  canvasWidth: number;
  canvasHeight: number;
}): FindingSignalReport[] {
  const signals: FindingSignalReport[] = [];
  const textClippingSignal = buildTextClippingSignal(params.element);

  if (textClippingSignal) {
    signals.push(textClippingSignal);
  }

  const captureCropSignal = buildCaptureCropSignal(params.element);

  if (captureCropSignal) {
    signals.push(captureCropSignal);
  } else {
    const viewportSignal = buildViewportMismatchSignal(
      params.kind,
      params.bbox,
      params.canvasWidth,
      params.canvasHeight,
    );

    if (viewportSignal) {
      signals.push(viewportSignal);
    }
  }

  return signals;
}

function buildTextClippingSignal(element: DomSnapshotElement | null): FindingSignalReport | null {
  if (!element?.textSnippet || !element.textMetrics) {
    return null;
  }

  const { textMetrics } = element;
  const hasOverflowX = textMetrics.scrollWidth > textMetrics.clientWidth + 1;
  const hasOverflowY = textMetrics.scrollHeight > textMetrics.clientHeight + 1;
  const clipsX =
    hasOverflowX &&
    (textMetrics.overflowX === "hidden" ||
      textMetrics.overflowX === "clip" ||
      textMetrics.textOverflow === "ellipsis");
  const lineClampActive =
    textMetrics.lineClamp !== null &&
    textMetrics.lineClamp !== "" &&
    textMetrics.lineClamp !== "none" &&
    textMetrics.lineClamp !== "0" &&
    textMetrics.lineClamp !== "normal";
  const clipsY =
    hasOverflowY &&
    (textMetrics.overflowY === "hidden" || textMetrics.overflowY === "clip" || lineClampActive);

  if (!clipsX && !clipsY) {
    return null;
  }

  const axis =
    clipsX && clipsY
      ? "horizontal and vertical axes"
      : clipsX
        ? "horizontal axis"
        : "vertical axis";

  return {
    code: "probable_text_clipping",
    confidence: lineClampActive || (clipsX && clipsY) ? "high" : "medium",
    message: `Text content likely overflows the element bounds and is being clipped on the ${axis}.`,
  };
}

function buildCaptureCropSignal(element: DomSnapshotElement | null): FindingSignalReport | null {
  if (!element || element.captureClippedEdges.length === 0) {
    return null;
  }

  return {
    code: "possible_capture_crop",
    confidence: "high",
    message: `Element bounds were clipped by the preview capture on the ${formatEdgeList(element.captureClippedEdges)} edge(s); check selector scope and capture framing.`,
  };
}

function buildViewportMismatchSignal(
  kind: RegionKind,
  bbox: BoundingBox,
  canvasWidth: number,
  canvasHeight: number,
): FindingSignalReport | null {
  if (kind !== "dimension") {
    return null;
  }

  const touchingEdges = boxEdgesAgainstCanvas(bbox, canvasWidth, canvasHeight);

  if (touchingEdges.length === 0) {
    return null;
  }

  return {
    code: "possible_viewport_mismatch",
    confidence: "medium",
    message: `Dimension mismatch reaches the ${formatEdgeList(touchingEdges)} edge(s) of the comparison canvas; verify viewport, selected frame, and capture target.`,
  };
}

function boxEdgesAgainstCanvas(
  box: BoundingBox,
  canvasWidth: number,
  canvasHeight: number,
): CaptureEdge[] {
  const edges: CaptureEdge[] = [];

  if (box.y <= 0) {
    edges.push("top");
  }

  if (box.x + box.width >= canvasWidth) {
    edges.push("right");
  }

  if (box.y + box.height >= canvasHeight) {
    edges.push("bottom");
  }

  if (box.x <= 0) {
    edges.push("left");
  }

  return edges;
}

function formatEdgeList(edges: CaptureEdge[]): string {
  if (edges.length === 1) {
    return edges[0];
  }

  if (edges.length === 2) {
    return `${edges[0]} and ${edges[1]}`;
  }

  return `${edges.slice(0, -1).join(", ")}, and ${edges[edges.length - 1]}`;
}

function toElementReport(element: DomSnapshotElement): FindingElementReport {
  return {
    tag: element.tag,
    selector: element.selector,
    role: element.role,
    testId: element.testId,
    textSnippet: element.textSnippet,
    bbox: element.bbox,
  };
}

function toActionTargetReport(element: DomSnapshotElement): ActionTargetReport {
  return {
    selector: element.selector,
    tag: element.tag,
    role: element.role,
    testId: element.testId,
    textSnippet: element.textSnippet,
  };
}

function roundConfidence(value: number): number {
  return Number(Math.min(0.99, Math.max(0.05, value)).toFixed(2));
}

function buildSeverityRollups(
  findings: Array<Pick<DraftFinding, "severity">> | Array<Pick<FindingReport, "severity">>,
): SeverityRollup[] {
  const severityCounts = new Map<Severity, number>();

  for (const finding of findings) {
    severityCounts.set(finding.severity, (severityCounts.get(finding.severity) ?? 0) + 1);
  }

  return Array.from(severityCounts.entries())
    .map(([severity, count]) => ({ severity, count }))
    .sort((left, right) => compareSeverityDescending(left.severity, right.severity));
}

function buildKindRollups(
  findings: Array<Pick<DraftFinding, "kind">> | Array<Pick<FindingReport, "kind">>,
): KindRollup[] {
  const kindCounts = new Map<RegionKind, number>();

  for (const finding of findings) {
    kindCounts.set(finding.kind, (kindCounts.get(finding.kind) ?? 0) + 1);
  }

  return Array.from(kindCounts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort(
      (left, right) =>
        FINDING_KIND_ORDER.indexOf(left.kind) - FINDING_KIND_ORDER.indexOf(right.kind),
    );
}

function buildTagRollups(
  findings: Array<Pick<DraftFinding, "element">> | Array<Pick<FindingReport, "element">>,
): TagRollup[] {
  const tagCounts = new Map<string, number>();

  for (const finding of findings) {
    const tag = finding.element?.tag;

    if (!tag) {
      continue;
    }

    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  return Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => {
      if (left.count !== right.count) {
        return right.count - left.count;
      }

      return left.tag.localeCompare(right.tag);
    });
}

function buildTopOmittedSelectors(findings: FindingReport[]): OmittedSelectorRollup[] {
  const selectorRollups = new Map<string, OmittedSelectorRollup>();

  for (const finding of findings) {
    const selector = selectorHintForFinding(finding);

    if (!selector) {
      continue;
    }

    const existing = selectorRollups.get(selector);

    if (existing) {
      existing.count += 1;
      existing.mismatchPixels += finding.mismatchPixels;
      continue;
    }

    selectorRollups.set(selector, {
      selector,
      count: 1,
      mismatchPixels: finding.mismatchPixels,
    });
  }

  return Array.from(selectorRollups.values())
    .sort((left, right) => {
      if (left.count !== right.count) {
        return right.count - left.count;
      }

      if (left.mismatchPixels !== right.mismatchPixels) {
        return right.mismatchPixels - left.mismatchPixels;
      }

      return left.selector.localeCompare(right.selector);
    })
    .slice(0, 5);
}

function buildLargestOmittedRegions(findings: FindingReport[]): OmittedRegionRollup[] {
  return findings
    .slice()
    .sort((left, right) => {
      if (left.mismatchPixels !== right.mismatchPixels) {
        return right.mismatchPixels - left.mismatchPixels;
      }

      return compareDraftFindings(left, right);
    })
    .slice(0, 5)
    .map((finding) => ({
      bbox: finding.bbox,
      severity: finding.severity,
      kind: finding.kind,
      rootCauseGroupId: finding.rootCauseGroupId,
      selector: selectorHintForFinding(finding),
    }));
}

function compareDraftFindings(left: DraftFinding, right: DraftFinding): number {
  const severityOrder = compareSeverityDescending(left.severity, right.severity);

  if (severityOrder !== 0) {
    return severityOrder;
  }

  if (left.mismatchPixels !== right.mismatchPixels) {
    return right.mismatchPixels - left.mismatchPixels;
  }

  if (left.bbox.y !== right.bbox.y) {
    return left.bbox.y - right.bbox.y;
  }

  if (left.bbox.x !== right.bbox.x) {
    return left.bbox.x - right.bbox.x;
  }

  const summaryOrder = left.summary.localeCompare(right.summary);

  if (summaryOrder !== 0) {
    return summaryOrder;
  }

  return left.rootCauseGroupId.localeCompare(right.rootCauseGroupId);
}

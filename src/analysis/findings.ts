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
  DomSnapshot,
  DomSnapshotElement,
  CaptureEdge,
} from "../types/internal.js";
import type {
  AnalysisMode,
  BoundingBox,
  FindingElementReport,
  FindingReport,
  FindingSignalReport,
  FindingSource,
  IssueType,
  KindRollup,
  RegionKind,
  RollupsReport,
  Severity,
  SeverityRollup,
  TagRollup,
} from "../types/report.js";
import { AppError } from "../utils/errors.js";
import { compareSeverityDescending, maxSeverity } from "../utils/severity.js";

interface DraftFinding {
  source: FindingSource;
  kind: RegionKind;
  severity: Severity;
  summary: string;
  bbox: BoundingBox;
  regionCount: number;
  mismatchPixels: number;
  mismatchPercentOfCanvas: number;
  issueTypes: IssueType[];
  signals: FindingSignalReport[];
  hotspots: BoundingBox[];
  element: FindingElementReport | null;
}

interface DraftFindingGroup {
  finding: DraftFinding;
  regions: ComparisonRegion[];
}

export interface FindingVisualization {
  severity: Severity;
  primaryBox: BoundingBox;
  hotspotBoxes: BoundingBox[];
}

const FINDING_KIND_ORDER: RegionKind[] = ["dimension", "mixed", "layout", "color", "pixel"];

export function buildFindingsAnalysis(params: {
  analysisMode: AnalysisMode;
  rawRegions: ComparisonRegion[];
  domSnapshot: DomSnapshot | null;
  width: number;
  height: number;
}): {
  findings: FindingReport[];
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
  const sortedFindings = sortedGroups.map((group) => group.finding);
  const limitedGroups = sortedGroups.slice(0, DEFAULT_REPORT_FINDINGS_LIMIT);
  const limitedFindings = limitedGroups.map((group) => group.finding);
  const affectedElementCount =
    params.analysisMode === "dom-elements"
      ? new Set(
          sortedFindings
            .map((finding) => finding.element?.selector ?? null)
            .filter((selector): selector is string => selector !== null),
        ).size
      : 0;

  return {
    findings: limitedFindings.map((finding, index) => ({
      id: `finding-${String(index + 1).padStart(3, "0")}`,
      ...finding,
    })),
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
      omittedFindings: Math.max(0, sortedFindings.length - limitedFindings.length),
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

  const candidates = buildDomCandidates(domSnapshot, width, height);
  const regionsByElement = new Map<string, ComparisonRegion[]>();
  const elementsById = new Map(candidates.map((element) => [element.id, element]));

  for (const region of rawRegions) {
    const element = resolveDomElementForRegion(region, candidates);
    const existing = regionsByElement.get(element.id);

    if (existing) {
      existing.push(region);
    } else {
      regionsByElement.set(element.id, [region]);
    }
  }

  return Array.from(regionsByElement.entries(), ([elementId, regions]) => {
    const element = elementsById.get(elementId);

    if (!element) {
      throw new AppError(`DOM element snapshot missing for finding group ${elementId}.`, {
        exitCode: 3,
        recommendation: "needs_human_review",
        severity: "high",
        code: "dom_snapshot_element_missing",
      });
    }

    return {
      finding: buildDraftFinding({
        source: "dom-element",
        regions,
        totalPixels,
        element,
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
  canvasWidth: number;
  canvasHeight: number;
}): DraftFinding {
  const bbox = unionRegionBoxes(params.regions);
  const mismatchPixels = params.regions.reduce((sum, region) => sum + region.pixelCount, 0);
  const kind = aggregateKind(params.regions);
  const elementReport = params.element ? toElementReport(params.element) : null;
  const primaryBox = elementReport?.bbox ?? bbox;

  return {
    source: params.source,
    kind,
    severity: maxSeverity(params.regions.map((region) => region.severity)),
    summary: buildFindingSummary(kind, elementReport?.tag ?? null),
    bbox,
    regionCount: params.regions.length,
    mismatchPixels,
    mismatchPercentOfCanvas:
      params.totalPixels === 0
        ? 0
        : Number(((mismatchPixels / params.totalPixels) * 100).toFixed(4)),
    issueTypes: issueTypesForKind(kind),
    signals: buildFindingSignals({
      kind,
      bbox,
      element: params.element,
      canvasWidth: params.canvasWidth,
      canvasHeight: params.canvasHeight,
    }),
    hotspots: buildHotspotBoxes(params.regions, primaryBox),
    element: elementReport,
  };
}

function buildDomCandidates(
  domSnapshot: DomSnapshot,
  width: number,
  height: number,
): DomSnapshotElement[] {
  const root: DomSnapshotElement = {
    ...domSnapshot.root,
    bbox: {
      x: 0,
      y: 0,
      width,
      height,
    },
  };

  return [root, ...domSnapshot.elements];
}

function resolveDomElementForRegion(
  region: ComparisonRegion,
  candidates: DomSnapshotElement[],
): DomSnapshotElement {
  const centerX = region.x + region.width / 2;
  const centerY = region.y + region.height / 2;
  const containing = candidates.filter((candidate) =>
    containsPoint(candidate.bbox, centerX, centerY),
  );

  if (containing.length > 0) {
    return containing.sort(compareDomCandidates)[0];
  }

  const regionBox = {
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  };
  let bestCandidate: DomSnapshotElement | null = null;
  let bestOverlap = 0;

  for (const candidate of candidates) {
    const overlap = overlapRatio(regionBox, candidate.bbox);

    if (overlap > bestOverlap) {
      bestCandidate = candidate;
      bestOverlap = overlap;
      continue;
    }

    if (
      overlap === bestOverlap &&
      bestCandidate &&
      compareDomCandidates(candidate, bestCandidate) < 0
    ) {
      bestCandidate = candidate;
    }
  }

  if (bestCandidate && bestOverlap >= DEFAULT_DOM_OVERLAP_THRESHOLD) {
    return bestCandidate;
  }

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

function compareDomCandidates(left: DomSnapshotElement, right: DomSnapshotElement): number {
  if (left.depth !== right.depth) {
    return right.depth - left.depth;
  }

  const leftArea = left.bbox.width * left.bbox.height;
  const rightArea = right.bbox.width * right.bbox.height;

  if (leftArea !== rightArea) {
    return leftArea - rightArea;
  }

  return left.selector.localeCompare(right.selector);
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
      return `${subject} is missing content, has extra content, or was captured at the wrong canvas size.`;
    case "layout":
      return `${subject} differs in position, spacing, or alignment.`;
    case "color":
      return `${subject} differs in color or visual styling.`;
    case "mixed":
      return `${subject} differs in both layout and styling.`;
    case "pixel":
    default:
      return `${subject} differs in rendering or fine-grained styling.`;
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
    textSnippet: element.textSnippet,
    bbox: element.bbox,
  };
}

function buildSeverityRollups(findings: DraftFinding[]): SeverityRollup[] {
  const severityCounts = new Map<Severity, number>();

  for (const finding of findings) {
    severityCounts.set(finding.severity, (severityCounts.get(finding.severity) ?? 0) + 1);
  }

  return Array.from(severityCounts.entries())
    .map(([severity, count]) => ({ severity, count }))
    .sort((left, right) => compareSeverityDescending(left.severity, right.severity));
}

function buildKindRollups(findings: DraftFinding[]): KindRollup[] {
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

function buildTagRollups(findings: DraftFinding[]): TagRollup[] {
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

  return left.summary.localeCompare(right.summary);
}

import type { ComparisonRegion, DomSnapshot, DomSnapshotElement } from "../types/internal.js";
import type { BoundingBox, CorrespondenceMethod } from "../types/report.js";

export interface ImageLike {
  width: number;
  height: number;
  data: Float32Array;
}

export interface AlignmentTransform {
  tx: number;
  ty: number;
  scale: number;
}

export interface GlobalAlignment {
  method: "translation" | "similarity" | "none";
  score: number;
  reliable: boolean;
  transform?: AlignmentTransform;
}

export interface GroupTraits {
  hasOwnText: boolean;
  hasTextDescendant: boolean;
  isInteractive: boolean;
  hasPaintedBox: boolean;
  isGraphicsOnly: boolean;
  isComposite: boolean;
}

export interface GroupNode {
  id: string;
  selector: string;
  representativeElementId: string;
  representativeElement: DomSnapshotElement;
  bbox: BoundingBox;
  area: number;
  depth: number;
  memberElementIds: string[];
  parentGroupId: string | null;
  childGroupIds: string[];
  mismatchWeight: number;
  traits: GroupTraits;
}

export interface GroupBuildResult {
  domSnapshot: DomSnapshot;
  rawRegions: ComparisonRegion[];
  groups: GroupNode[];
  groupsById: Map<string, GroupNode>;
  elementToGroupId: Map<string, string>;
  searchGroupIds: string[];
}

export interface SearchBudget {
  maxSearchGroups: number;
  maxContextGroups: number;
  maxCandidatesPerGroup: number;
  maxRefinedCandidatesPerGroup: number;
}

export interface ReferenceCacheLevel {
  scale: number;
  gray: ImageLike;
  edge: ImageLike;
}

export interface ReferenceSearchCache {
  levels: ReferenceCacheLevel[];
}

export interface WindowSignature {
  thumbnail: Float32Array;
  horizontalEdgeProjection: Float32Array;
  verticalEdgeProjection: Float32Array;
  edgeDensity: number;
  fillRatio: number;
  aspectRatio: number;
}

export interface CoarseCandidate {
  bbox: BoundingBox;
  score: number;
  modality: "gray" | "edge";
  levelScale: number;
}

export interface RefinedCandidate {
  bbox: BoundingBox;
  score: number;
  modality: "gray" | "edge";
  coarseScore: number;
}

export interface CorrespondenceScores {
  thumbnail: number;
  edge: number;
  ssim: number;
  geometry: number;
  structural: number;
}

export interface GroupLocalization {
  groupId: string;
  attempted: boolean;
  found: boolean;
  reliable: boolean;
  method: CorrespondenceMethod;
  confidence: number;
  ambiguity: number;
  matchedReferenceBBox?: BoundingBox;
  delta?: {
    dx: number;
    dy: number;
    dw: number;
    dh: number;
  };
  scores: CorrespondenceScores;
}

export interface CorrespondenceSummary {
  processedGroups: number;
  reliableGroups: number;
  ambiguousCorrespondences: number;
  correspondenceCoverage: number;
  correspondenceConfidence: number;
}

export interface CorrespondenceProfile {
  timingsMs: {
    previewCapture?: number;
    referenceFetch?: number;
    compare?: number;
    alignment: number;
    groupBuild: number;
    cacheBuild: number;
    coarseSearch: number;
    refinement: number;
    findings?: number;
  };
  counts: {
    groupsBuilt: number;
    groupsSearched: number;
    candidateWindowsRefined: number;
    groupsSkippedDueToBudget: number;
    denseSearchFallbacks: number;
  };
}

export interface CorrespondenceResult {
  alignment: GlobalAlignment;
  groups: GroupNode[];
  groupsById: Map<string, GroupNode>;
  elementToGroupId: Map<string, string>;
  localizationsByGroupId: Map<string, GroupLocalization>;
  summary: CorrespondenceSummary;
  profile: CorrespondenceProfile;
}

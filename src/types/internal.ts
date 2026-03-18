import type {
  AnalysisMode,
  BoundingBox,
  CaptureEdge,
  ComputedStyleSubsetReport,
  CompareReport,
  DecisionTraceReport,
  DomCandidateKind,
  ElementIdentityReport,
  ElementLocatorReport,
  IgnoreSelectorReport,
  InteractivityStateReport,
  OverlapHintsReport,
  RegionKind,
  ReferenceTransport,
  Recommendation,
  Severity,
  TextLayoutReport,
  VisibilityStateReport,
  Viewport,
} from "./report.js";

interface ResolvedInput {
  input: string;
  resolved: string;
}

export interface UrlPreviewInput extends ResolvedInput {
  kind: "url";
  selector: string | null;
  ignoreSelectors: string[];
  viewport: Viewport;
}

export interface PathPreviewInput extends ResolvedInput {
  kind: "path";
  selector: null;
  ignoreSelectors: [];
  viewport: Viewport | null;
}

export type ParsedPreviewInput = UrlPreviewInput | PathPreviewInput;

export interface LocalReferenceInput extends ResolvedInput {
  kind: "path";
}

export interface FigmaReferenceInput extends ResolvedInput {
  kind: "figma-url";
  fileKey: string;
  nodeId: string;
}

export type ParsedReferenceInput = LocalReferenceInput | FigmaReferenceInput;

export interface PreparedImage {
  path: string;
  width: number;
  height: number;
}

export interface PreparedReferenceImage extends PreparedImage {
  transport: ReferenceTransport;
}

export interface DomTextMetrics {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  overflowX: string;
  overflowY: string;
  textOverflow: string;
  whiteSpace: string;
  lineClamp: string | null;
}

export interface DomSnapshotElement {
  id: string;
  tag: string;
  selector: string;
  role: string | null;
  testId: string | null;
  domId: string | null;
  classSummary: string[];
  textSnippet: string | null;
  bbox: BoundingBox;
  depth: number;
  captureClippedEdges: CaptureEdge[];
  textMetrics: DomTextMetrics | null;
  ancestry: ElementLocatorReport[];
  locator: ElementLocatorReport;
  identity: ElementIdentityReport;
  computedStyle: ComputedStyleSubsetReport;
  textLayout: TextLayoutReport | null;
  visibility: VisibilityStateReport;
  interactivity: InteractivityStateReport;
  overlapHints: OverlapHintsReport;
  candidateKind: DomCandidateKind;
  anchorElementId: string;
}

export type DomBindingCandidate = DomSnapshotElement;

export interface DomSnapshot {
  root: DomSnapshotElement;
  elements: DomSnapshotElement[];
  bindingCandidates: DomBindingCandidate[];
}

export interface PreparedPreviewImage extends PreparedImage {
  analysisMode: AnalysisMode;
  domSnapshot: DomSnapshot | null;
  ignoreRegions: BoundingBox[];
  ignoreSelectorMatches: IgnoreSelectorReport[];
}

export interface NormalizedImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface CompareArtifacts {
  reference: string;
  preview: string;
  overlay: string;
  diff: string;
  heatmap: string;
  report: string;
}

export interface ComparisonRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelCount: number;
  mismatchPercent: number;
  kind: RegionKind;
  severity: Severity;
}

export interface RecommendationDecision {
  recommendation: Recommendation;
  severity: Severity;
  reason: string;
  decisionTrace: DecisionTraceReport[];
}

export interface CompletedRun {
  report: CompareReport;
  exitCode: number;
}

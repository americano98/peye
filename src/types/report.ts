export const COMPARE_MODES = ["all", "pixel", "layout", "color"] as const;
export const ANALYSIS_MODES = ["dom-elements", "visual-clusters"] as const;
export const FINDING_SIGNAL_CODES = [
  "probable_text_clipping",
  "possible_capture_crop",
  "possible_viewport_mismatch",
] as const;
export const SIGNAL_CONFIDENCES = ["low", "medium", "high"] as const;

export type CompareMode = (typeof COMPARE_MODES)[number];
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];
export type FindingSignalCode = (typeof FINDING_SIGNAL_CODES)[number];
export type SignalConfidence = (typeof SIGNAL_CONFIDENCES)[number];

export type Recommendation =
  | "pass"
  | "pass_with_tolerated_differences"
  | "retry_fix"
  | "needs_human_review";

export type Severity = "low" | "medium" | "high" | "critical";

export type RegionKind = "pixel" | "color" | "layout" | "mixed" | "dimension";
export type InputSourceKind = "url" | "path" | "figma-url";
export type ReferenceTransport = "figma-mcp-desktop" | "figma-mcp-remote" | "figma-rest" | "path";
export type FindingSource = "dom-element" | "visual-cluster";
export type IssueType = "position" | "spacing" | "size" | "color" | "style" | "missing_or_extra";

export interface Viewport {
  width: number;
  height: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DimensionMismatch {
  widthDelta: number;
  heightDelta: number;
  aspectRatioDelta: number;
  hasMismatch: boolean;
}

export interface ImageDimensionsReport {
  preview: Viewport | null;
  reference: Viewport | null;
  canvas: Viewport | null;
}

export interface MetricsReport {
  mismatchPixels: number;
  mismatchPercent: number;
  meanColorDelta: number | null;
  maxColorDelta: number | null;
  structuralMismatchPercent: number | null;
  dimensionMismatch: DimensionMismatch;
  findingsCount: number;
  affectedElementCount: number;
}

export interface CompareThresholds {
  pass: number;
  tolerated: number;
  retry: number;
}

export interface InputSourceReport {
  input: string;
  kind: InputSourceKind;
  resolved: string;
  selector: string | null;
}

export interface ReferenceInputSourceReport extends InputSourceReport {
  transport: ReferenceTransport | null;
}

export interface ArtifactReport {
  reference: string | null;
  preview: string | null;
  overlay: string | null;
  diff: string | null;
  heatmap: string | null;
  report: string;
}

export interface SummaryReport {
  recommendation: Recommendation;
  severity: Severity;
  reason: string;
}

export interface ErrorReport {
  code: string;
  message: string;
  exitCode: number;
}

export interface FindingElementReport {
  tag: string;
  selector: string;
  role: string | null;
  textSnippet: string | null;
  bbox: BoundingBox;
}

export interface FindingSignalReport {
  code: FindingSignalCode;
  confidence: SignalConfidence;
  message: string;
}

export interface FindingReport {
  id: string;
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

export interface SeverityRollup {
  severity: Severity;
  count: number;
}

export interface KindRollup {
  kind: RegionKind;
  count: number;
}

export interface TagRollup {
  tag: string;
  count: number;
}

export interface RollupsReport {
  bySeverity: SeverityRollup[];
  byKind: KindRollup[];
  byTag: TagRollup[];
  rawRegionCount: number;
  findingsCount: number;
  affectedElementCount: number;
  omittedFindings: number;
}

export interface CompareReport {
  analysisMode: AnalysisMode;
  summary: SummaryReport;
  inputs: {
    preview: InputSourceReport;
    reference: ReferenceInputSourceReport;
    viewport: Viewport | null;
    mode: CompareMode;
    fullPage: boolean;
  };
  images: ImageDimensionsReport;
  metrics: MetricsReport;
  rollups: RollupsReport;
  findings: FindingReport[];
  artifacts: ArtifactReport;
  error: ErrorReport | null;
}

export interface CompareCommandOptions {
  preview: string;
  reference: string;
  output: string;
  viewport?: string;
  mode: CompareMode;
  selector?: string;
  fullPage: boolean;
  thresholdPass: number;
  thresholdTolerated: number;
  thresholdRetry: number;
}

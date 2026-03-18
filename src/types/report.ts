export const COMPARE_MODES = ["all", "pixel", "layout", "color"] as const;
export const ANALYSIS_MODES = ["dom-elements", "visual-clusters"] as const;
export const FINDING_SIGNAL_CODES = [
  "probable_text_clipping",
  "possible_capture_crop",
  "possible_viewport_mismatch",
] as const;
export const FINDING_CODES = [
  "text_clipping",
  "capture_crop",
  "viewport_mismatch",
  "missing_or_extra_content",
  "layout_mismatch",
  "style_mismatch",
  "rendering_mismatch",
  "layout_style_mismatch",
] as const;
export const SUMMARY_ACTION_CODES = [
  "fix_text_overflow",
  "fix_layout_styles",
  "fix_visual_styles",
  "verify_missing_or_extra_content",
  "recapture_with_broader_scope",
  "verify_viewport_or_reference",
  "fix_preview_setup",
  "fix_reference_setup",
] as const;
export const ROOT_CAUSE_CODES = [
  "text_overflow",
  "capture_scope_too_tight",
  "viewport_or_reference_mismatch",
  "missing_or_extra_content",
  "layout_displacement",
  "visual_style_drift",
  "rendering_drift",
  "preview_input_or_runtime_error",
  "reference_input_or_acquisition_error",
] as const;
export const AFFECTED_PROPERTY_CODES = [
  "layout.position",
  "layout.spacing",
  "layout.alignment",
  "size.width",
  "size.height",
  "style.color",
  "style.background",
  "style.border",
  "style.radius",
  "style.shadow",
  "style.typography",
  "text.overflow",
  "text.lineClamp",
  "capture.selectorScope",
  "capture.viewport",
  "reference.frame",
] as const;
export const FINDING_METRIC_KEYS = [
  "mismatchPercent",
  "structuralMismatchPercent",
  "dimensionMismatch",
  "meanColorDelta",
] as const;
export const FINDING_ARTIFACT_KEYS = ["heatmap", "diff"] as const;
export const SIGNAL_CONFIDENCES = ["low", "medium", "high"] as const;

export type CompareMode = (typeof COMPARE_MODES)[number];
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];
export type FindingSignalCode = (typeof FINDING_SIGNAL_CODES)[number];
export type FindingCode = (typeof FINDING_CODES)[number];
export type SummaryActionCode = (typeof SUMMARY_ACTION_CODES)[number];
export type RootCauseCode = (typeof ROOT_CAUSE_CODES)[number];
export type AffectedPropertyCode = (typeof AFFECTED_PROPERTY_CODES)[number];
export type FindingMetricKey = (typeof FINDING_METRIC_KEYS)[number];
export type FindingArtifactKey = (typeof FINDING_ARTIFACT_KEYS)[number];
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
  ignoredPixels: number;
  ignoredPercent: number;
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

export interface IgnoreSelectorReport {
  selector: string;
  matchedElementCount: number | null;
}

export interface PreviewInputSourceReport extends InputSourceReport {
  ignoreSelectors: IgnoreSelectorReport[];
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
  topActions: SummaryActionReport[];
  rootCauseCandidates: SummaryRootCauseReport[];
  overallConfidence: number;
  safeToAutofix: boolean;
  requiresRecapture: boolean;
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

export interface ActionTargetReport {
  selector: string;
  tag: string;
  role: string | null;
  textSnippet: string | null;
}

export type FindingEvidenceRefReport =
  | {
      type: "signal";
      code: FindingSignalCode;
    }
  | {
      type: "metric";
      key: FindingMetricKey;
    }
  | {
      type: "hotspot";
      index: number;
    }
  | {
      type: "artifact";
      key: FindingArtifactKey;
    };

export interface SummaryActionReport {
  code: SummaryActionCode;
  confidence: number;
  reason: string;
  findingIds: string[];
}

export interface SummaryRootCauseReport {
  code: RootCauseCode;
  confidence: number;
  reason: string;
  findingIds: string[];
  signalCodes: FindingSignalCode[];
}

export interface FindingReport {
  id: string;
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
    preview: PreviewInputSourceReport;
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
  ignoreSelectors: string[];
  fullPage: boolean;
  thresholdPass: number;
  thresholdTolerated: number;
  thresholdRetry: number;
}

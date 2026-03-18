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
  "run_sanity_check_same_target",
  "recapture_with_broader_scope",
  "verify_viewport_or_reference",
  "fix_preview_setup",
  "fix_reference_setup",
  "fix_output_path_or_permissions",
] as const;
export const SUMMARY_AGENT_CHECK_CODES = ["validate_same_target_before_fix"] as const;
export const DECISION_AXES = [
  "pixel",
  "layout",
  "color",
  "dimension",
  "setup_capture_risk",
  "fixability",
  "final",
] as const;
export const DECISION_STRENGTHS = ["low", "medium", "high", "critical"] as const;
export const DECISION_TRACE_CODES = [
  "pixel_strict_pass",
  "pixel_tolerated_pass",
  "pixel_retry_range",
  "pixel_exceeds_retry_range",
  "layout_localized_drift",
  "layout_global_drift",
  "color_localized_drift",
  "color_global_drift",
  "dimension_moderate_mismatch",
  "dimension_strong_mismatch",
  "setup_capture_signal_risk",
  "setup_ignored_area_risk",
  "fixability_localized_actionable",
  "fixability_diffuse_or_unaddressable",
  "final_pass",
  "final_pass_with_tolerated_differences",
  "final_retry_fix",
  "final_needs_human_review",
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
  "artifact_output_failure",
] as const;
export const ROOT_CAUSE_GROUP_IDS = [
  "text-wrap-regression",
  "viewport-crop-risk",
  "container-size-mismatch",
  "content-presence-mismatch",
  "layout-displacement",
  "visual-style-drift",
  "rendering-drift",
  "preview-setup-error",
  "reference-setup-error",
  "output-write-error",
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
export const DECISION_TRACE_METRIC_KEYS = [
  "mismatchPercent",
  "structuralMismatchPercent",
  "meanColorDelta",
  "maxColorDelta",
  "ignoredPercent",
  "dimensionMismatch",
] as const;
export const SIGNAL_CONFIDENCES = ["low", "medium", "high"] as const;

export type CompareMode = (typeof COMPARE_MODES)[number];
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];
export type FindingSignalCode = (typeof FINDING_SIGNAL_CODES)[number];
export type FindingCode = (typeof FINDING_CODES)[number];
export type SummaryActionCode = (typeof SUMMARY_ACTION_CODES)[number];
export type SummaryAgentCheckCode = (typeof SUMMARY_AGENT_CHECK_CODES)[number];
export type DecisionAxis = (typeof DECISION_AXES)[number];
export type DecisionStrength = (typeof DECISION_STRENGTHS)[number];
export type DecisionTraceCode = (typeof DECISION_TRACE_CODES)[number];
export type RootCauseCode = (typeof ROOT_CAUSE_CODES)[number];
export type RootCauseGroupId = (typeof ROOT_CAUSE_GROUP_IDS)[number];
export type AffectedPropertyCode = (typeof AFFECTED_PROPERTY_CODES)[number];
export type DecisionTraceMetricKey = (typeof DECISION_TRACE_METRIC_KEYS)[number];
export type SignalConfidence = (typeof SIGNAL_CONFIDENCES)[number];

export type Recommendation =
  | "pass"
  | "pass_with_tolerated_differences"
  | "retry_fix"
  | "needs_human_review";

export type Severity = "low" | "medium" | "high" | "critical";
export type CaptureEdge = "top" | "right" | "bottom" | "left";
export type FindingAssignmentMethod = "center-hit" | "overlap-best-fit" | "ancestor-proxy";
export type FindingAssignmentFallbackMarker =
  | "none"
  | "weak-overlap"
  | "inline-proxy"
  | "anchor-fallback";
export type DomCandidateKind = "anchor" | "inline-descendant" | "leaf-proxy";
export type TextWrapState = "clamped" | "overflowing" | "wrapped" | "single-line" | "unknown";

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
  decisionTrace: DecisionTraceReport[];
  topActions: SummaryActionReport[];
  agentChecks: SummaryAgentCheckReport[];
  primaryBlockers: PrimaryBlockerReport[];
  overallConfidence: number;
  safeToAutofix: boolean;
  requiresRecapture: boolean;
  requiresSanityCheck: boolean;
}

export interface ErrorReport {
  code: string;
  message: string;
  exitCode: number;
}

export interface FindingElementReport {
  tag: string;
  selector: string;
  role?: string;
  testId?: string;
  textSnippet?: string;
}

export interface FindingSignalReport {
  code: FindingSignalCode;
  confidence: SignalConfidence;
  message: string;
}

export interface ElementLocatorReport {
  tag: string;
  selector: string;
  role: string | null;
  testId: string | null;
  domId: string | null;
  classSummary: string[];
}

export interface ElementIdentityReport {
  domId: string | null;
  classSummary: string[];
  testId: string | null;
  semanticTag: string | null;
  candidateKind: DomCandidateKind;
}

export interface ComputedStyleSubsetReport {
  fontSize: string;
  lineHeight: string;
  fontWeight: string;
  color: string;
  backgroundColor: string;
  borderRadius: string;
  gap: string;
  padding: string;
  width: string;
  height: string;
  margin: string;
}

export interface TextLayoutReport {
  lineCount: number;
  wrapState: TextWrapState;
  hasEllipsis: boolean;
  lineClamp: string | null;
  overflowsX: boolean;
  overflowsY: boolean;
}

export interface VisibilityStateReport {
  isVisible: boolean;
  display: string;
  visibility: string;
  opacity: number;
  pointerEvents: string;
  ariaHidden: boolean | null;
}

export interface InteractivityStateReport {
  isInteractive: boolean;
  disabled: boolean | null;
  tabIndex: number | null;
  cursor: string;
}

export interface OverlapHintsReport {
  topMostAtCenter: string | null;
  stackDepthAtCenter: number;
  occludingSelector: string | null;
  captureClippedEdges: CaptureEdge[];
}

export interface FindingBindingReport {
  assignmentMethod: FindingAssignmentMethod;
  assignmentConfidence: number;
  fallbackMarker?: Exclude<FindingAssignmentFallbackMarker, "none">;
}

export interface FindingSemanticContextReport {
  computedStyle?: ComputedStyleSubsetReport;
  textLayout?: TextLayoutReport;
  captureClippedEdges?: CaptureEdge[];
}

export interface FindingContextReport {
  binding: FindingBindingReport;
  semantic?: FindingSemanticContextReport;
}

export interface SummaryActionReport {
  code: SummaryActionCode;
  confidence: number;
  reason: string;
  findingIds: string[];
}

export interface SummaryAgentCheckReport {
  code: SummaryAgentCheckCode;
  confidence: number;
  reason: string;
  findingIds: string[];
  signalCodes: FindingSignalCode[];
}

export interface PrimaryBlockerReport {
  rootCauseGroupId: RootCauseGroupId;
  severity: Severity;
  confidence: number;
  reason: string;
  findingCount: number;
  omittedFindingCount: number;
  sampleFindingIds: string[];
  signalCodes: FindingSignalCode[];
  topSelectors: string[];
  affectedAreaPercent: number;
}

export interface DecisionTraceReport {
  axis: DecisionAxis;
  code: DecisionTraceCode;
  outcome: Recommendation;
  strength: DecisionStrength;
  reason: string;
  findingIds: string[];
  signalCodes: FindingSignalCode[];
  metricKeys: DecisionTraceMetricKey[];
}

export interface FindingReport {
  id: string;
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
  element?: FindingElementReport;
  context?: FindingContextReport;
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

export interface OmittedSelectorRollup {
  selector: string;
  count: number;
  mismatchPixels: number;
}

export interface OmittedRegionRollup {
  bbox: BoundingBox;
  severity: Severity;
  kind: RegionKind;
  rootCauseGroupId: RootCauseGroupId;
  selector: string | null;
}

export interface RollupsReport {
  bySeverity: SeverityRollup[];
  byKind: KindRollup[];
  byTag: TagRollup[];
  rawRegionCount: number;
  findingsCount: number;
  affectedElementCount: number;
  omittedFindings: number;
  omittedBySeverity: SeverityRollup[];
  omittedByKind: KindRollup[];
  topOmittedSelectors: OmittedSelectorRollup[];
  largestOmittedRegions: OmittedRegionRollup[];
  tailAreaPercent: number;
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

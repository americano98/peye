import type {
  ArtifactReport,
  AnalysisMode,
  CompareReport,
  ErrorReport,
  ImageDimensionsReport,
  MetricsReport,
  Recommendation,
  Severity,
} from "../types/report.js";

export interface AppErrorOptions {
  exitCode?: number;
  recommendation?: Recommendation | null;
  severity?: Severity | null;
  code?: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly recommendation: Recommendation | null;
  readonly severity: Severity | null;

  constructor(message: string, options?: AppErrorOptions) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = options?.code ?? "app_error";
    this.exitCode = options?.exitCode ?? 1;
    this.recommendation = options?.recommendation ?? null;
    this.severity = options?.severity ?? null;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown error");
}

export function createFailureReport(params: {
  summary: CompareReport["summary"];
  preview: CompareReport["inputs"]["preview"];
  reference: CompareReport["inputs"]["reference"];
  viewport: CompareReport["inputs"]["viewport"];
  analysisMode: AnalysisMode;
  mode: CompareReport["inputs"]["mode"];
  fullPage: boolean;
  images: ImageDimensionsReport;
  artifacts: ArtifactReport;
  error: ErrorReport;
}): CompareReport {
  const emptyMetrics: MetricsReport = {
    mismatchPixels: 0,
    mismatchPercent: 0,
    ignoredPixels: 0,
    ignoredPercent: 0,
    meanColorDelta: null,
    maxColorDelta: null,
    structuralMismatchPercent: null,
    dimensionMismatch: {
      widthDelta: 0,
      heightDelta: 0,
      aspectRatioDelta: 0,
      hasMismatch: false,
    },
    findingsCount: 0,
    affectedElementCount: 0,
  };

  return {
    analysisMode: params.analysisMode,
    summary: params.summary,
    inputs: {
      preview: params.preview,
      reference: params.reference,
      viewport: params.viewport,
      mode: params.mode,
      fullPage: params.fullPage,
    },
    images: params.images,
    metrics: emptyMetrics,
    rollups: {
      bySeverity: [],
      byKind: [],
      byTag: [],
      rawRegionCount: 0,
      findingsCount: 0,
      affectedElementCount: 0,
      omittedFindings: 0,
      omittedBySeverity: [],
      omittedByKind: [],
      topOmittedSelectors: [],
      largestOmittedRegions: [],
      tailAreaPercent: 0,
    },
    findings: [],
    artifacts: params.artifacts,
    error: params.error,
  };
}

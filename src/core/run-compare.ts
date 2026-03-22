import path from "node:path";
import { DEFAULT_MODE } from "../config/defaults.js";
import { buildFindingsAnalysis } from "../analysis/findings.js";
import { decideRecommendation } from "../analysis/recommendation.js";
import { buildSummaryReport, type FailureOrigin } from "../analysis/summary.js";
import { buildMarkdownTextReport } from "../analysis/text-report.js";
import { materializePreviewImage } from "../capture/playwright-capture.js";
import { runComparisonEngine } from "../compare/engine.js";
import { createHeatmapArtifact } from "../compare/heatmap.js";
import { localizeElementGroups } from "../correspond/index.js";
import { ensureDirectory, pathExists, writeJsonFile, writeTextFile } from "../io/fs.js";
import { loadNormalizedImage, padImageToCanvas, writeRawRgbaPng } from "../io/image.js";
import {
  buildIgnoreSelectorReports,
  inferPreviewInputSource,
  inferReferenceInputSource,
  parsePreviewInput,
  parseReferenceInput,
  resolveViewportForReport,
} from "../io/inputs.js";
import { materializeReferenceImage } from "../reference/index.js";
import type {
  CompareArtifacts,
  CompletedRun,
  ParsedPreviewInput,
  ParsedReferenceInput,
  PreparedImage,
  PreparedPreviewImage,
  PreparedReferenceImage,
} from "../types/internal.js";
import type {
  CompareCommandOptions,
  CompareReport,
  ErrorReport,
  PreviewInputSourceReport,
  Recommendation,
  ReferenceInputSourceReport,
} from "../types/report.js";
import { AppError, createFailureReport, isAppError } from "../utils/errors.js";

export async function runCompare(options: CompareCommandOptions): Promise<CompletedRun> {
  validateThresholdOrdering(options);
  const outputDir = await ensureDirectory(options.output);
  const artifactPaths = createArtifactPaths(outputDir);
  const profilePath = path.join(outputDir, "profile.json");
  const outerTimingsMs: {
    previewCapture?: number;
    referenceFetch?: number;
    compare?: number;
    findings?: number;
  } = {};

  let previewInput: ParsedPreviewInput | null = null;
  let referenceInput: ParsedReferenceInput | null = null;
  let preparedPreview: PreparedPreviewImage | null = null;
  let preparedReference: PreparedReferenceImage | null = null;

  try {
    previewInput = await parsePreviewInput(options);
    referenceInput = await parseReferenceInput(options.reference);
    const previewCapturePromise = (async () => {
      const startedAt = performance.now();
      const prepared = await materializePreviewImage(
        previewInput,
        artifactPaths.preview,
        options.fullPage,
      );
      outerTimingsMs.previewCapture = roundMetric(performance.now() - startedAt);
      return prepared;
    })();
    const referenceFetchPromise = (async () => {
      const startedAt = performance.now();
      const prepared = await materializeReferenceImage(referenceInput, artifactPaths.reference);
      outerTimingsMs.referenceFetch = roundMetric(performance.now() - startedAt);
      return prepared;
    })();
    const [previewResult, referenceResult] = await Promise.allSettled([
      previewCapturePromise,
      referenceFetchPromise,
    ]);

    if (previewResult.status === "fulfilled") {
      preparedPreview = previewResult.value;
    }

    if (referenceResult.status === "fulfilled") {
      preparedReference = referenceResult.value;
    }

    if (previewResult.status === "rejected") {
      throw previewResult.reason;
    }

    if (referenceResult.status === "rejected") {
      throw referenceResult.reason;
    }

    const finalPreparedPreview = preparedPreview;
    const finalPreparedReference = preparedReference;

    if (!finalPreparedPreview || !finalPreparedReference) {
      throw new AppError("Preview or reference could not be prepared for comparison.", {
        code: "compare_inputs_not_prepared",
      });
    }

    const previewImage = await loadNormalizedImage(finalPreparedPreview.path);
    const referenceImage = await loadNormalizedImage(finalPreparedReference.path);
    const width = Math.max(previewImage.width, referenceImage.width);
    const height = Math.max(previewImage.height, referenceImage.height);
    const paddedPreview = padImageToCanvas(previewImage, width, height);
    const paddedReference = padImageToCanvas(referenceImage, width, height);

    const comparison = (() => {
      const startedAt = performance.now();
      const result = runComparisonEngine({
        reference: paddedReference.data,
        preview: paddedPreview.data,
        width,
        height,
        ignoreRegions: finalPreparedPreview.ignoreRegions,
        referenceOriginal: {
          width: referenceImage.width,
          height: referenceImage.height,
        },
        previewOriginal: {
          width: previewImage.width,
          height: previewImage.height,
        },
        mode: options.mode ?? DEFAULT_MODE,
      });
      outerTimingsMs.compare = roundMetric(performance.now() - startedAt);
      return result;
    })();
    const corresponded =
      finalPreparedPreview.analysisMode === "dom-elements" && finalPreparedPreview.domSnapshot !== null
        ? localizeElementGroups({
            preview: paddedPreview.data,
            reference: paddedReference.data,
            width,
            height,
            rawRegions: comparison.rawRegions,
            domSnapshot: finalPreparedPreview.domSnapshot,
          })
        : null;
    const findingsAnalysis = (() => {
      const startedAt = performance.now();
      const result = buildFindingsAnalysis({
        analysisMode: finalPreparedPreview.analysisMode,
        rawRegions: comparison.rawRegions,
        domSnapshot: finalPreparedPreview.domSnapshot,
        groupsById: corresponded?.groupsById ?? null,
        elementToGroupId: corresponded?.elementToGroupId ?? null,
        localizationsByGroupId: corresponded?.localizationsByGroupId ?? null,
        width,
        height,
      });
      outerTimingsMs.findings = roundMetric(performance.now() - startedAt);
      return result;
    })();
    const heatmap = createHeatmapArtifact({
      reference: paddedReference.data,
      preview: paddedPreview.data,
      mismatchMask: comparison.mismatchMask,
      visuals: findingsAnalysis.visuals,
      width,
      height,
    });
    const metrics = {
      ...comparison.metrics,
      findingsCount: findingsAnalysis.metrics.findingsCount,
      affectedElementCount: findingsAnalysis.metrics.affectedElementCount,
    };
    const decision = decideRecommendation({
      metrics,
      thresholds: {
        pass: options.thresholdPass,
        tolerated: options.thresholdTolerated,
        retry: options.thresholdRetry,
      },
      findings: findingsAnalysis.fullFindings,
    });
    const summary = buildSummaryReport({
      baseDecision: decision,
      findings: findingsAnalysis.findings,
      fullFindings: findingsAnalysis.fullFindings,
      analysisMode: finalPreparedPreview.analysisMode,
      omittedFindings: findingsAnalysis.rollups.omittedFindings,
      error: null,
      correspondenceSummary: corresponded?.summary ?? null,
    });

    const report: CompareReport = {
      analysisMode: finalPreparedPreview.analysisMode,
      summary,
      inputs: {
        preview: {
          input: previewInput.input,
          kind: previewInput.kind,
          resolved: previewInput.resolved,
          selector: previewInput.selector,
          ignoreSelectors: finalPreparedPreview.ignoreSelectorMatches,
        },
        reference: {
          input: referenceInput.input,
          kind: referenceInput.kind,
          resolved: referenceInput.resolved,
          selector: null,
          transport: finalPreparedReference.transport,
        },
        viewport: resolveViewportForReport(previewInput.viewport, {
          width: previewImage.width,
          height: previewImage.height,
        }),
        mode: options.mode,
        fullPage: options.fullPage,
      },
      images: {
        preview: { width: previewImage.width, height: previewImage.height },
        reference: { width: referenceImage.width, height: referenceImage.height },
        canvas: { width, height },
      },
      metrics,
      rollups: findingsAnalysis.rollups,
      findings: findingsAnalysis.findings,
      artifacts: artifactPaths,
      error: null,
    };
    const textSummary = buildMarkdownTextReport(report);

    await Promise.all([
      writeRawRgbaPng(artifactPaths.overlay, comparison.buffers.overlay, width, height),
      writeRawRgbaPng(artifactPaths.diff, comparison.buffers.diff, width, height),
      writeRawRgbaPng(artifactPaths.heatmap, heatmap, width, height),
      writeTextFile(artifactPaths.summary, textSummary),
      ...(isDebugTimingsEnabled() && corresponded !== null
        ? [
            writeJsonFile(profilePath, {
              timingsMs: {
                ...outerTimingsMs,
                ...corresponded.profile.timingsMs,
              },
              counts: {
                ...corresponded.profile.counts,
              },
            }),
          ]
        : []),
    ]);

    await writeJsonFile(artifactPaths.report, report);

    return {
      report,
      exitCode: exitCodeForRecommendation(report.summary.recommendation),
    };
  } catch (error) {
    if (isAppError(error)) {
      const previewSource = toPreviewSourceReport(previewInput, options, preparedPreview);
      const referenceSource = toReferenceSourceReport(
        referenceInput,
        options.reference,
        preparedReference,
      );
      const failureAnalysisMode =
        preparedPreview?.analysisMode ?? inferAnalysisMode(previewInput, options);
      const errorReport: ErrorReport = {
        code: error.code,
        message: error.message,
        exitCode: error.exitCode,
      };
      const summary = buildSummaryReport({
        baseDecision: {
          recommendation: error.recommendation ?? "needs_human_review",
          severity: error.severity ?? (error.exitCode === 1 ? "medium" : "high"),
          reason: error.message,
          decisionTrace: [],
        },
        findings: [],
        fullFindings: [],
        analysisMode: failureAnalysisMode,
        omittedFindings: 0,
        error: errorReport,
        correspondenceSummary: null,
        failureOrigin: inferFailureOrigin({
          errorCode: error.code,
          previewInput,
          referenceInput,
          preparedPreview,
          preparedReference,
        }),
      });
      const report = createFailureReport({
        summary,
        preview: previewSource,
        reference: referenceSource,
        viewport: previewInput?.viewport ?? null,
        analysisMode: failureAnalysisMode,
        mode: options.mode,
        fullPage: options.fullPage,
        images: buildImagesReport(preparedPreview, preparedReference),
        artifacts: {
          ...artifactPaths,
          preview: (await pathExists(artifactPaths.preview)) ? artifactPaths.preview : null,
          reference: (await pathExists(artifactPaths.reference)) ? artifactPaths.reference : null,
          overlay: null,
          diff: null,
          heatmap: null,
        },
        error: errorReport,
      });
      const textSummary = buildMarkdownTextReport(report);

      await Promise.all([
        writeJsonFile(artifactPaths.report, report),
        writeTextFile(artifactPaths.summary, textSummary),
      ]);

      return {
        report,
        exitCode: error.exitCode,
      };
    }

    throw error;
  }
}

function isDebugTimingsEnabled(): boolean {
  return process.env.PEYE_DEBUG_TIMINGS === "1";
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function buildImagesReport(
  preparedPreview: PreparedImage | null,
  preparedReference: PreparedImage | null,
): CompareReport["images"] {
  const preview =
    preparedPreview === null
      ? null
      : {
          width: preparedPreview.width,
          height: preparedPreview.height,
        };
  const reference =
    preparedReference === null
      ? null
      : {
          width: preparedReference.width,
          height: preparedReference.height,
        };

  return {
    preview,
    reference,
    canvas:
      preview === null || reference === null
        ? null
        : {
            width: Math.max(preview.width, reference.width),
            height: Math.max(preview.height, reference.height),
          },
  };
}

function inferAnalysisMode(
  previewInput: ParsedPreviewInput | null,
  options: Pick<CompareCommandOptions, "preview">,
): CompareReport["analysisMode"] {
  if (previewInput) {
    return previewInput.kind === "url" ? "dom-elements" : "visual-clusters";
  }

  return options.preview.startsWith("http://") || options.preview.startsWith("https://")
    ? "dom-elements"
    : "visual-clusters";
}

function createArtifactPaths(outputDir: string): CompareArtifacts {
  return {
    preview: path.join(outputDir, "preview.png"),
    reference: path.join(outputDir, "reference.png"),
    overlay: path.join(outputDir, "overlay.png"),
    diff: path.join(outputDir, "diff.png"),
    heatmap: path.join(outputDir, "heatmap.png"),
    report: path.join(outputDir, "report.json"),
    summary: path.join(outputDir, "summary.md"),
  };
}

function toPreviewSourceReport(
  previewInput: ParsedPreviewInput | null,
  options: Pick<CompareCommandOptions, "preview" | "selector" | "ignoreSelectors">,
  preparedPreview: PreparedPreviewImage | null = null,
): PreviewInputSourceReport {
  if (!previewInput) {
    return inferPreviewInputSource(options);
  }

  return {
    input: previewInput.input,
    kind: previewInput.kind,
    resolved: previewInput.resolved,
    selector: previewInput.selector,
    ignoreSelectors:
      preparedPreview?.ignoreSelectorMatches ??
      buildIgnoreSelectorReports(previewInput.ignoreSelectors),
  };
}

function toReferenceSourceReport(
  referenceInput: ParsedReferenceInput | null,
  reference: string,
  preparedReference: PreparedReferenceImage | null,
): ReferenceInputSourceReport {
  if (preparedReference) {
    const inferred = inferReferenceInputSource(reference);

    return {
      input: referenceInput?.input ?? reference,
      kind: referenceInput?.kind ?? inferred.kind,
      resolved: referenceInput?.resolved ?? inferred.resolved,
      selector: null,
      transport: preparedReference.transport,
    };
  }

  if (!referenceInput) {
    return inferReferenceInputSource(reference);
  }

  return {
    input: referenceInput.input,
    kind: referenceInput.kind,
    resolved: referenceInput.resolved,
    selector: null,
    transport: referenceInput.kind === "path" ? "path" : null,
  };
}

function inferFailureOrigin(params: {
  errorCode: string;
  previewInput: ParsedPreviewInput | null;
  referenceInput: ParsedReferenceInput | null;
  preparedPreview: PreparedPreviewImage | null;
  preparedReference: PreparedReferenceImage | null;
}): FailureOrigin {
  if (
    params.errorCode.startsWith("preview_") ||
    params.errorCode.startsWith("playwright_") ||
    params.errorCode.startsWith("dom_")
  ) {
    return "preview";
  }

  if (
    params.errorCode.startsWith("reference_") ||
    params.errorCode.startsWith("figma_") ||
    params.errorCode === "remote_request_failed"
  ) {
    return "reference";
  }

  if (
    params.errorCode.startsWith("input_file_") ||
    params.errorCode.startsWith("image_") ||
    params.errorCode === "artifact_write_failed"
  ) {
    if (!params.previewInput) {
      return "preview";
    }

    if (!params.referenceInput) {
      return "reference";
    }

    if (params.preparedPreview && !params.preparedReference) {
      return "reference";
    }

    if (!params.preparedPreview) {
      return "preview";
    }
  }

  return "unknown";
}

function validateThresholdOrdering(options: CompareCommandOptions): void {
  if (options.thresholdPass > options.thresholdTolerated) {
    throw new AppError("--threshold-pass must be less than or equal to --threshold-tolerated.");
  }

  if (options.thresholdTolerated > options.thresholdRetry) {
    throw new AppError("--threshold-tolerated must be less than or equal to --threshold-retry.");
  }
}

function exitCodeForRecommendation(recommendation: Recommendation): number {
  switch (recommendation) {
    case "pass":
    case "pass_with_tolerated_differences":
      return 0;
    case "retry_fix":
      return 2;
    case "needs_human_review":
      return 3;
    default:
      return 1;
  }
}

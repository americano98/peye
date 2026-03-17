import path from "node:path";
import { DEFAULT_MODE } from "../config/defaults.js";
import { buildFindingsAnalysis } from "../analysis/findings.js";
import { decideRecommendation } from "../analysis/recommendation.js";
import { materializePreviewImage } from "../capture/playwright-capture.js";
import { runComparisonEngine } from "../compare/engine.js";
import { createHeatmapArtifact } from "../compare/heatmap.js";
import { ensureDirectory, pathExists, writeJsonFile } from "../io/fs.js";
import { loadNormalizedImage, padImageToCanvas, writeRawRgbaPng } from "../io/image.js";
import {
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
  InputSourceReport,
  Recommendation,
  ReferenceInputSourceReport,
} from "../types/report.js";
import { AppError, createFailureReport, isAppError } from "../utils/errors.js";

export async function runCompare(options: CompareCommandOptions): Promise<CompletedRun> {
  validateThresholdOrdering(options);
  const outputDir = await ensureDirectory(options.output);
  const artifactPaths = createArtifactPaths(outputDir);

  let previewInput: ParsedPreviewInput | null = null;
  let referenceInput: ParsedReferenceInput | null = null;
  let preparedPreview: PreparedPreviewImage | null = null;
  let preparedReference: PreparedReferenceImage | null = null;

  try {
    previewInput = await parsePreviewInput(options);
    referenceInput = await parseReferenceInput(options.reference);
    preparedPreview = await materializePreviewImage(
      previewInput,
      artifactPaths.preview,
      options.fullPage,
    );
    preparedReference = await materializeReferenceImage(referenceInput, artifactPaths.reference);

    const previewImage = await loadNormalizedImage(preparedPreview.path);
    const referenceImage = await loadNormalizedImage(preparedReference.path);
    const width = Math.max(previewImage.width, referenceImage.width);
    const height = Math.max(previewImage.height, referenceImage.height);
    const paddedPreview = padImageToCanvas(previewImage, width, height);
    const paddedReference = padImageToCanvas(referenceImage, width, height);

    const comparison = runComparisonEngine({
      reference: paddedReference.data,
      preview: paddedPreview.data,
      width,
      height,
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
    const findingsAnalysis = buildFindingsAnalysis({
      analysisMode: preparedPreview.analysisMode,
      rawRegions: comparison.rawRegions,
      domSnapshot: preparedPreview.domSnapshot,
      width,
      height,
    });
    const heatmap = createHeatmapArtifact({
      reference: paddedReference.data,
      preview: paddedPreview.data,
      mismatchMask: comparison.mismatchMask,
      visuals: findingsAnalysis.visuals,
      width,
      height,
    });

    await Promise.all([
      writeRawRgbaPng(artifactPaths.overlay, comparison.buffers.overlay, width, height),
      writeRawRgbaPng(artifactPaths.diff, comparison.buffers.diff, width, height),
      writeRawRgbaPng(artifactPaths.heatmap, heatmap, width, height),
    ]);

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
      findings: findingsAnalysis.findings,
    });

    const report: CompareReport = {
      analysisMode: preparedPreview.analysisMode,
      summary: decision,
      inputs: {
        preview: {
          input: previewInput.input,
          kind: previewInput.kind,
          resolved: previewInput.resolved,
          selector: previewInput.selector,
        },
        reference: {
          input: referenceInput.input,
          kind: referenceInput.kind,
          resolved: referenceInput.resolved,
          selector: null,
          transport: preparedReference.transport,
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

    await writeJsonFile(artifactPaths.report, report);

    return {
      report,
      exitCode: exitCodeForRecommendation(report.summary.recommendation),
    };
  } catch (error) {
    if (isAppError(error)) {
      const report = createFailureReport({
        reason: error.message,
        recommendation: error.recommendation ?? "needs_human_review",
        severity: error.severity ?? (error.exitCode === 1 ? "medium" : "high"),
        preview: toPreviewSourceReport(previewInput, options),
        reference: toReferenceSourceReport(referenceInput, options.reference, preparedReference),
        viewport: previewInput?.viewport ?? null,
        analysisMode: preparedPreview?.analysisMode ?? inferAnalysisMode(previewInput, options),
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
        error: {
          code: error.code,
          message: error.message,
          exitCode: error.exitCode,
        },
      });

      await writeJsonFile(artifactPaths.report, report);

      return {
        report,
        exitCode: error.exitCode,
      };
    }

    throw error;
  }
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
  };
}

function toPreviewSourceReport(
  previewInput: ParsedPreviewInput | null,
  options: Pick<CompareCommandOptions, "preview" | "selector">,
): InputSourceReport {
  if (!previewInput) {
    return inferPreviewInputSource(options);
  }

  return {
    input: previewInput.input,
    kind: previewInput.kind,
    resolved: previewInput.resolved,
    selector: previewInput.selector,
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

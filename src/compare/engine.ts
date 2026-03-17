import pixelmatch from "pixelmatch";
import {
  COLOR_REGION_DELTA_THRESHOLD,
  DEFAULT_PIXELMATCH_THRESHOLD,
  LAYOUT_EDGE_RATIO_THRESHOLD,
  MAX_RGB_DISTANCE,
  STRONG_DIMENSION_ASPECT_DELTA,
  STRONG_DIMENSION_DELTA_PX,
} from "../config/defaults.js";
import type { ComparisonRegion } from "../types/internal.js";
import type {
  CompareMode,
  DimensionMismatch,
  MetricsReport,
  RegionKind,
  Severity,
} from "../types/report.js";
import { compareSeverityDescending } from "../utils/severity.js";
import { extractRegions } from "./regions.js";
import { analyzeStructure } from "./structure.js";

export interface EngineResult {
  metrics: MetricsReport;
  rawRegions: ComparisonRegion[];
  mismatchMask: Uint8Array;
  buffers: {
    overlay: Uint8ClampedArray;
    diff: Uint8ClampedArray;
  };
}

export function runComparisonEngine(params: {
  reference: Uint8ClampedArray;
  preview: Uint8ClampedArray;
  width: number;
  height: number;
  referenceOriginal: { width: number; height: number };
  previewOriginal: { width: number; height: number };
  mode: CompareMode;
}): EngineResult {
  const totalPixels = params.width * params.height;
  const diffBuffer = new Uint8ClampedArray(totalPixels * 4);
  const maskBuffer = new Uint8ClampedArray(totalPixels * 4);
  const colorDeltaMap = new Float32Array(totalPixels);
  const mismatchPixels = pixelmatch(
    params.reference,
    params.preview,
    diffBuffer,
    params.width,
    params.height,
    {
      threshold: DEFAULT_PIXELMATCH_THRESHOLD,
      alpha: 0.2,
      diffColor: [255, 0, 0],
      diffColorAlt: [0, 180, 255],
      includeAA: true,
    },
  );

  pixelmatch(params.reference, params.preview, maskBuffer, params.width, params.height, {
    threshold: DEFAULT_PIXELMATCH_THRESHOLD,
    alpha: 1,
    diffColor: [255, 255, 255],
    diffColorAlt: [255, 255, 255],
    includeAA: true,
    diffMask: true,
  });

  const mismatchMask = new Uint8Array(totalPixels);
  let colorDeltaSum = 0;
  let maxColorDelta = 0;
  let mismatchedColorSamples = 0;

  for (let index = 0; index < totalPixels; index += 1) {
    const offset = index * 4;
    const hasMismatch =
      maskBuffer[offset] > 0 ||
      maskBuffer[offset + 1] > 0 ||
      maskBuffer[offset + 2] > 0 ||
      maskBuffer[offset + 3] > 0;

    if (!hasMismatch) {
      continue;
    }

    mismatchMask[index] = 1;
    const redDelta = params.reference[offset] - params.preview[offset];
    const greenDelta = params.reference[offset + 1] - params.preview[offset + 1];
    const blueDelta = params.reference[offset + 2] - params.preview[offset + 2];
    const delta =
      (Math.sqrt(redDelta ** 2 + greenDelta ** 2 + blueDelta ** 2) / MAX_RGB_DISTANCE) * 100;
    colorDeltaMap[index] = delta;
    colorDeltaSum += delta;
    maxColorDelta = Math.max(maxColorDelta, delta);
    mismatchedColorSamples += 1;
  }

  const dimensionMismatch = buildDimensionMismatch(
    params.referenceOriginal,
    params.previewOriginal,
  );
  const structural =
    params.mode === "all" || params.mode === "layout"
      ? analyzeStructure(params.reference, params.preview, params.width, params.height)
      : null;

  const rawRegions = buildRegions({
    mismatchMask,
    edgeDiffMask: structural?.edgeDiffMask ?? null,
    width: params.width,
    height: params.height,
    totalPixels,
    dimensionMismatch,
    overlapWidth: Math.min(params.referenceOriginal.width, params.previewOriginal.width),
    overlapHeight: Math.min(params.referenceOriginal.height, params.previewOriginal.height),
    colorDeltaMap,
    mode: params.mode,
  });

  const overlay = createOverlay(params.reference, params.preview, mismatchMask);

  return {
    metrics: {
      mismatchPixels,
      mismatchPercent:
        totalPixels === 0 ? 0 : Number(((mismatchPixels / totalPixels) * 100).toFixed(4)),
      meanColorDelta:
        params.mode === "all" || params.mode === "color"
          ? mismatchedColorSamples > 0
            ? Number((colorDeltaSum / mismatchedColorSamples).toFixed(4))
            : 0
          : null,
      maxColorDelta:
        params.mode === "all" || params.mode === "color" ? Number(maxColorDelta.toFixed(4)) : null,
      structuralMismatchPercent:
        structural === null ? null : Number(structural.structuralMismatchPercent.toFixed(4)),
      dimensionMismatch,
      findingsCount: 0,
      affectedElementCount: 0,
    },
    rawRegions,
    mismatchMask,
    buffers: {
      overlay,
      diff: diffBuffer,
    },
  };
}

function buildDimensionMismatch(
  reference: { width: number; height: number },
  preview: { width: number; height: number },
): DimensionMismatch {
  const widthDelta = preview.width - reference.width;
  const heightDelta = preview.height - reference.height;
  const referenceAspect = reference.width / reference.height;
  const previewAspect = preview.width / preview.height;

  return {
    widthDelta,
    heightDelta,
    aspectRatioDelta: Number(Math.abs(previewAspect - referenceAspect).toFixed(6)),
    hasMismatch: widthDelta !== 0 || heightDelta !== 0,
  };
}

function buildRegions(params: {
  mismatchMask: Uint8Array;
  edgeDiffMask: Uint8Array | null;
  width: number;
  height: number;
  totalPixels: number;
  dimensionMismatch: DimensionMismatch;
  overlapWidth: number;
  overlapHeight: number;
  colorDeltaMap: Float32Array;
  mode: CompareMode;
}): ComparisonRegion[] {
  const rawRegions = extractRegions(params.mismatchMask, params.width, params.height);

  return rawRegions
    .map((region) => {
      const bboxArea = region.width * region.height;
      const mismatchPercent = bboxArea === 0 ? 0 : (region.pixelCount / bboxArea) * 100;
      const kind = classifyRegionKind({
        region,
        edgeDiffMask: params.edgeDiffMask,
        width: params.width,
        overlapWidth: params.overlapWidth,
        overlapHeight: params.overlapHeight,
        colorDeltaMap: params.colorDeltaMap,
        mode: params.mode,
      });
      const severity = classifyRegionSeverity(
        (region.pixelCount / params.totalPixels) * 100,
        kind,
        params.dimensionMismatch,
      );

      return {
        ...region,
        mismatchPercent: Number(mismatchPercent.toFixed(4)),
        kind,
        severity,
      };
    })
    .sort(compareRegions);
}

function classifyRegionKind(params: {
  region: { x: number; y: number; width: number; height: number };
  edgeDiffMask: Uint8Array | null;
  width: number;
  overlapWidth: number;
  overlapHeight: number;
  colorDeltaMap: Float32Array;
  mode: CompareMode;
}): RegionKind {
  const { region, edgeDiffMask, width, overlapWidth, overlapHeight, colorDeltaMap, mode } = params;
  const outsideOverlap =
    region.x + region.width > overlapWidth || region.y + region.height > overlapHeight;

  if (outsideOverlap) {
    return "dimension";
  }

  const regionMeanColorDelta = meanColorDeltaForRegion(region, colorDeltaMap, width);

  if (mode === "pixel") {
    return "pixel";
  }

  if (mode === "color") {
    return regionMeanColorDelta >= COLOR_REGION_DELTA_THRESHOLD ? "color" : "pixel";
  }

  if (!edgeDiffMask) {
    return regionMeanColorDelta >= COLOR_REGION_DELTA_THRESHOLD ? "color" : "pixel";
  }

  let edgePixels = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      if (edgeDiffMask[y * width + x] === 1) {
        edgePixels += 1;
      }
    }
  }

  const edgeRatio = edgePixels / Math.max(1, region.width * region.height);

  if (mode === "layout") {
    return edgeRatio >= LAYOUT_EDGE_RATIO_THRESHOLD ? "layout" : "pixel";
  }

  if (
    edgeRatio >= LAYOUT_EDGE_RATIO_THRESHOLD &&
    regionMeanColorDelta >= COLOR_REGION_DELTA_THRESHOLD
  ) {
    return "mixed";
  }

  if (edgeRatio >= LAYOUT_EDGE_RATIO_THRESHOLD) {
    return "layout";
  }

  if (regionMeanColorDelta >= COLOR_REGION_DELTA_THRESHOLD) {
    return "color";
  }

  return "pixel";
}

function meanColorDeltaForRegion(
  region: { x: number; y: number; width: number; height: number },
  colorDeltaMap: Float32Array,
  width: number,
): number {
  let totalDelta = 0;
  let sampleCount = 0;

  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const delta = colorDeltaMap[y * width + x];

      if (delta <= 0) {
        continue;
      }

      totalDelta += delta;
      sampleCount += 1;
    }
  }

  return sampleCount === 0 ? 0 : totalDelta / sampleCount;
}

function classifyRegionSeverity(
  areaPercent: number,
  kind: RegionKind,
  dimensionMismatch: DimensionMismatch,
): Severity {
  if (kind === "dimension") {
    const strongDimensionShift =
      Math.abs(dimensionMismatch.widthDelta) >= STRONG_DIMENSION_DELTA_PX ||
      Math.abs(dimensionMismatch.heightDelta) >= STRONG_DIMENSION_DELTA_PX ||
      dimensionMismatch.aspectRatioDelta >= STRONG_DIMENSION_ASPECT_DELTA;

    return strongDimensionShift ? "critical" : "high";
  }

  let severity: Severity;

  if (areaPercent >= 12) {
    severity = "critical";
  } else if (areaPercent >= 4) {
    severity = "high";
  } else if (areaPercent >= 1.5) {
    severity = "medium";
  } else {
    severity = "low";
  }

  if (kind === "layout" && severity === "low") {
    return "medium";
  }

  if (kind === "mixed" && severity === "low") {
    return "medium";
  }

  return severity;
}

function createOverlay(
  reference: Uint8ClampedArray,
  preview: Uint8ClampedArray,
  mismatchMask: Uint8Array,
): Uint8ClampedArray {
  const overlay = new Uint8ClampedArray(reference.length);

  for (let index = 0; index < mismatchMask.length; index += 1) {
    const offset = index * 4;
    overlay[offset] = Math.round((reference[offset] + preview[offset]) / 2);
    overlay[offset + 1] = Math.round((reference[offset + 1] + preview[offset + 1]) / 2);
    overlay[offset + 2] = Math.round((reference[offset + 2] + preview[offset + 2]) / 2);
    overlay[offset + 3] = 255;

    if (mismatchMask[index] === 1) {
      overlay[offset] = Math.min(255, overlay[offset] + 50);
    }
  }

  return overlay;
}

function compareRegions(left: ComparisonRegion, right: ComparisonRegion): number {
  const severityOrder = compareSeverityDescending(left.severity, right.severity);

  if (severityOrder !== 0) {
    return severityOrder;
  }

  if (left.pixelCount !== right.pixelCount) {
    return right.pixelCount - left.pixelCount;
  }

  if (left.y !== right.y) {
    return left.y - right.y;
  }

  return left.x - right.x;
}

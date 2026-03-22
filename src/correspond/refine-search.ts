import { CORRESPONDENCE_MAX_CANDIDATES_PER_GROUP } from "../config/defaults.js";
import type { BoundingBox } from "../types/report.js";
import type { CoarseCandidate, ImageLike, RefinedCandidate } from "./types.js";
import { resizeToDimensions } from "./reference-cache.js";

export type RefinementMode = "text" | "graphics" | "generic";

const THUMB_SIZE = 12;
const COARSE_REFINEMENT_PADDING_PX = 12;
const FINE_REFINEMENT_PADDING_PX = 3;
const DARKNESS_FILL_THRESHOLD = 0.08;

export function refineCandidates(params: {
  coarseCandidates: CoarseCandidate[];
  previewGrayPatch: ImageLike;
  previewEdgePatch: ImageLike;
  referenceGray: ImageLike;
  referenceEdge: ImageLike;
  mode?: RefinementMode;
  maxCandidates?: number;
}): RefinedCandidate[] {
  const maxCandidates = params.maxCandidates ?? CORRESPONDENCE_MAX_CANDIDATES_PER_GROUP;
  const refined: RefinedCandidate[] = [];
  const previewGrayThumb = resizeToDimensions(params.previewGrayPatch, THUMB_SIZE, THUMB_SIZE);
  const previewEdgeThumb = resizeToDimensions(params.previewEdgePatch, THUMB_SIZE, THUMB_SIZE);
  const previewFeatures = buildThumbFeatures(
    previewGrayThumb.data,
    previewEdgeThumb.data,
    THUMB_SIZE,
    THUMB_SIZE,
  );

  for (const coarseCandidate of params.coarseCandidates.slice(0, maxCandidates)) {
    const coarseWindow = expandBox(
      coarseCandidate.bbox,
      COARSE_REFINEMENT_PADDING_PX,
      params.referenceGray.width,
      params.referenceGray.height,
    );
    const stepTwo = searchLocalNeighborhood({
      referenceGray: params.referenceGray,
      referenceEdge: params.referenceEdge,
      previewFeatures,
      patchWidth: params.previewGrayPatch.width,
      patchHeight: params.previewGrayPatch.height,
      searchWindow: coarseWindow,
      step: 2,
      mode: params.mode ?? "generic",
    });
    const stepOneWindow = expandBox(
      stepTwo.bbox,
      FINE_REFINEMENT_PADDING_PX,
      params.referenceGray.width,
      params.referenceGray.height,
    );
    const stepOne = searchLocalNeighborhood({
      referenceGray: params.referenceGray,
      referenceEdge: params.referenceEdge,
      previewFeatures,
      patchWidth: params.previewGrayPatch.width,
      patchHeight: params.previewGrayPatch.height,
      searchWindow: stepOneWindow,
      step: 1,
      mode: params.mode ?? "generic",
    });

    refined.push({
      bbox: stepOne.bbox,
      score: stepOne.score,
      modality: stepOne.modality,
      coarseScore: coarseCandidate.score,
    });
  }

  return refined.sort((left, right) => right.score - left.score).slice(0, maxCandidates);
}

function searchLocalNeighborhood(params: {
  referenceGray: ImageLike;
  referenceEdge: ImageLike;
  previewFeatures: ThumbFeatures;
  patchWidth: number;
  patchHeight: number;
  searchWindow: BoundingBox;
  step: number;
  mode: RefinementMode;
}): { bbox: BoundingBox; score: number; modality: "gray" | "edge" } {
  const grayThumbData = new Float32Array(THUMB_SIZE * THUMB_SIZE);
  const edgeThumbData = new Float32Array(THUMB_SIZE * THUMB_SIZE);
  const candidateFeatures = createThumbFeaturesScratch(THUMB_SIZE, THUMB_SIZE);
  let best = {
    bbox: {
      x: params.searchWindow.x,
      y: params.searchWindow.y,
      width: params.patchWidth,
      height: params.patchHeight,
    },
    score: Number.NEGATIVE_INFINITY,
    modality: "gray" as "gray" | "edge",
  };
  const maxX = params.searchWindow.width - params.patchWidth;
  const maxY = params.searchWindow.height - params.patchHeight;

  for (let y = 0; y <= maxY; y += params.step) {
    for (let x = 0; x <= maxX; x += params.step) {
      const bbox = {
        x: params.searchWindow.x + x,
        y: params.searchWindow.y + y,
        width: params.patchWidth,
        height: params.patchHeight,
      };
      sampleThumbInto(params.referenceGray, bbox, THUMB_SIZE, THUMB_SIZE, grayThumbData);
      sampleThumbInto(params.referenceEdge, bbox, THUMB_SIZE, THUMB_SIZE, edgeThumbData);
      buildThumbFeatures(grayThumbData, edgeThumbData, THUMB_SIZE, THUMB_SIZE, candidateFeatures);
      const grayScore = thumbnailSimilarity(
        params.previewFeatures.grayData,
        candidateFeatures.grayData,
      );
      const edgeScore = edgeOverlap(params.previewFeatures.edgeData, candidateFeatures.edgeData);
      const projectionScore = projectionSimilarity(
        params.previewFeatures,
        candidateFeatures,
        params.mode,
      );
      const densityScore = densitySimilarity(params.previewFeatures, candidateFeatures);
      const { score, modality } = scoreByMode({
        mode: params.mode,
        grayScore,
        edgeScore,
        projectionScore,
        densityScore,
      });

      if (score > best.score) {
        best = { bbox, score, modality };
      }
    }
  }

  return {
    bbox: best.bbox,
    score: roundMetric(best.score),
    modality: best.modality,
  };
}

interface ThumbFeatures {
  grayData: Float32Array;
  edgeData: Float32Array;
  grayRowProjection: Float32Array;
  grayColumnProjection: Float32Array;
  edgeRowProjection: Float32Array;
  edgeColumnProjection: Float32Array;
  edgeDensity: number;
  fillRatio: number;
}

function createThumbFeaturesScratch(width: number, height: number): ThumbFeatures {
  return {
    grayData: new Float32Array(width * height),
    edgeData: new Float32Array(width * height),
    grayRowProjection: new Float32Array(height),
    grayColumnProjection: new Float32Array(width),
    edgeRowProjection: new Float32Array(height),
    edgeColumnProjection: new Float32Array(width),
    edgeDensity: 0,
    fillRatio: 0,
  };
}

function buildThumbFeatures(
  grayData: Float32Array,
  edgeData: Float32Array,
  width: number,
  height: number,
  target: ThumbFeatures = createThumbFeaturesScratch(width, height),
): ThumbFeatures {
  target.grayData = grayData;
  target.edgeData = edgeData;
  target.grayRowProjection.fill(0);
  target.grayColumnProjection.fill(0);
  target.edgeRowProjection.fill(0);
  target.edgeColumnProjection.fill(0);
  let edgePixels = 0;
  let fillPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const darkness = 1 - grayData[index] / 255;
      target.grayRowProjection[y] += darkness;
      target.grayColumnProjection[x] += darkness;
      const edgeValue = edgeData[index] > 0 ? 1 : 0;
      target.edgeRowProjection[y] += edgeValue;
      target.edgeColumnProjection[x] += edgeValue;
      edgePixels += edgeValue;
      if (darkness > DARKNESS_FILL_THRESHOLD) {
        fillPixels += 1;
      }
    }
  }

  normalizeProjection(target.grayRowProjection);
  normalizeProjection(target.grayColumnProjection);
  normalizeProjection(target.edgeRowProjection);
  normalizeProjection(target.edgeColumnProjection);

  target.edgeDensity = edgePixels / grayData.length;
  target.fillRatio = fillPixels / grayData.length;

  return target;
}

function thumbnailSimilarity(leftThumb: Float32Array, rightThumb: Float32Array): number {
  let diff = 0;

  for (let index = 0; index < leftThumb.length; index += 1) {
    diff += Math.abs(leftThumb[index] - rightThumb[index]);
  }

  return 1 - diff / (leftThumb.length * 255);
}

function edgeOverlap(leftThumb: Float32Array, rightThumb: Float32Array): number {
  let overlap = 0;
  let union = 0;

  for (let index = 0; index < leftThumb.length; index += 1) {
    const leftEdge = leftThumb[index] > 0 ? 1 : 0;
    const rightEdge = rightThumb[index] > 0 ? 1 : 0;

    if (leftEdge === 1 || rightEdge === 1) {
      union += 1;
    }

    if (leftEdge === 1 && rightEdge === 1) {
      overlap += 1;
    }
  }

  return union === 0 ? 1 : overlap / union;
}

function projectionSimilarity(
  left: ThumbFeatures,
  right: ThumbFeatures,
  mode: RefinementMode,
): number {
  if (mode === "text") {
    return (
      (1 - meanAbsoluteDiff(left.grayRowProjection, right.grayRowProjection)) * 0.55 +
      (1 - meanAbsoluteDiff(left.grayColumnProjection, right.grayColumnProjection)) * 0.3 +
      (1 - meanAbsoluteDiff(left.edgeRowProjection, right.edgeRowProjection)) * 0.15
    );
  }

  return (
    (1 - meanAbsoluteDiff(left.edgeRowProjection, right.edgeRowProjection)) * 0.5 +
    (1 - meanAbsoluteDiff(left.edgeColumnProjection, right.edgeColumnProjection)) * 0.5
  );
}

function densitySimilarity(left: ThumbFeatures, right: ThumbFeatures): number {
  return (
    1 -
    Math.min(
      1,
      Math.abs(left.edgeDensity - right.edgeDensity) + Math.abs(left.fillRatio - right.fillRatio),
    ) /
      2
  );
}

function scoreByMode(params: {
  mode: RefinementMode;
  grayScore: number;
  edgeScore: number;
  projectionScore: number;
  densityScore: number;
}): { score: number; modality: "gray" | "edge" } {
  switch (params.mode) {
    case "text": {
      const score =
        params.grayScore * 0.3 +
        params.edgeScore * 0.15 +
        params.projectionScore * 0.45 +
        params.densityScore * 0.1;
      return {
        score,
        modality: params.projectionScore > params.grayScore ? "edge" : "gray",
      };
    }
    case "graphics": {
      const score =
        params.grayScore * 0.15 +
        params.edgeScore * 0.5 +
        params.projectionScore * 0.2 +
        params.densityScore * 0.15;
      return {
        score,
        modality: "edge",
      };
    }
    case "generic":
    default: {
      const score =
        params.grayScore * 0.55 +
        params.edgeScore * 0.2 +
        params.projectionScore * 0.15 +
        params.densityScore * 0.1;
      return {
        score,
        modality: params.edgeScore > params.grayScore ? "edge" : "gray",
      };
    }
  }
}

function meanAbsoluteDiff(left: Float32Array, right: Float32Array): number {
  let diff = 0;

  for (let index = 0; index < left.length; index += 1) {
    diff += Math.abs(left[index] - right[index]);
  }

  return diff / left.length;
}

function normalizeProjection(projection: Float32Array): void {
  let sum = 0;

  for (let index = 0; index < projection.length; index += 1) {
    sum += projection[index];
  }

  if (sum <= 0) {
    return;
  }

  for (let index = 0; index < projection.length; index += 1) {
    projection[index] /= sum;
  }
}

function sampleThumbInto(
  reference: ImageLike,
  bbox: BoundingBox,
  width: number,
  height: number,
  target: Float32Array,
): void {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = bbox.x + (x / Math.max(1, width - 1)) * Math.max(0, bbox.width - 1);
      const sourceY = bbox.y + (y / Math.max(1, height - 1)) * Math.max(0, bbox.height - 1);
      target[y * width + x] = sampleAt(reference, sourceX, sourceY);
    }
  }
}

function expandBox(bbox: BoundingBox, padding: number, width: number, height: number): BoundingBox {
  const x = Math.max(0, bbox.x - padding);
  const y = Math.max(0, bbox.y - padding);
  const right = Math.min(width, bbox.x + bbox.width + padding);
  const bottom = Math.min(height, bbox.y + bbox.height + padding);

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function sampleAt(image: ImageLike, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const dx = x - x0;
  const dy = y - y0;
  const topLeft = image.data[y0 * image.width + x0];
  const topRight = image.data[y0 * image.width + x1];
  const bottomLeft = image.data[y1 * image.width + x0];
  const bottomRight = image.data[y1 * image.width + x1];

  return (
    topLeft * (1 - dx) * (1 - dy) +
    topRight * dx * (1 - dy) +
    bottomLeft * (1 - dx) * dy +
    bottomRight * dx * dy
  );
}

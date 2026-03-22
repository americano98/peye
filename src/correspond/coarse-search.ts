import { CORRESPONDENCE_MAX_CANDIDATES_PER_GROUP } from "../config/defaults.js";
import type { BoundingBox } from "../types/report.js";
import type {
  CoarseCandidate,
  ImageLike,
  ReferenceCacheLevel,
  ReferenceSearchCache,
  WindowSignature,
} from "./types.js";
import { cropImage, resizeToDimensions } from "./reference-cache.js";

export function runCoarseSearch(params: {
  previewGrayPatch: ImageLike;
  previewEdgePatch: ImageLike;
  searchWindow: BoundingBox;
  referenceCache: ReferenceSearchCache;
  maxCandidates?: number;
}): { candidates: CoarseCandidate[]; denseFallbackUsed: boolean } {
  const maxCandidates = params.maxCandidates ?? CORRESPONDENCE_MAX_CANDIDATES_PER_GROUP;
  const level = selectCacheLevel(params.referenceCache, params.searchWindow);
  const scaledWindow = scaleBox(params.searchWindow, level.scale);
  const previewGrayScaled = resizeToDimensions(
    params.previewGrayPatch,
    Math.max(8, Math.round(params.previewGrayPatch.width * level.scale)),
    Math.max(8, Math.round(params.previewGrayPatch.height * level.scale)),
  );
  const previewEdgeScaled = resizeToDimensions(
    params.previewEdgePatch,
    previewGrayScaled.width,
    previewGrayScaled.height,
  );
  const referenceGrayWindow = cropImage(level.gray, scaledWindow);
  const referenceEdgeWindow = cropImage(level.edge, scaledWindow);
  const previewSignature = buildWindowSignature(previewGrayScaled, previewEdgeScaled);
  const stride = coarseStride(previewGrayScaled);
  const maxX = referenceGrayWindow.width - previewGrayScaled.width;
  const maxY = referenceGrayWindow.height - previewGrayScaled.height;

  if (maxX < 0 || maxY < 0) {
    return {
      candidates: [],
      denseFallbackUsed: false,
    };
  }

  const denseFallbackUsed = (maxX + 1) * (maxY + 1) <= 900;
  const step = denseFallbackUsed ? 1 : stride;
  const candidates: CoarseCandidate[] = [];

  for (let y = 0; y <= maxY; y += step) {
    for (let x = 0; x <= maxX; x += step) {
      const grayWindow = cropImage(referenceGrayWindow, {
        x,
        y,
        width: previewGrayScaled.width,
        height: previewGrayScaled.height,
      });
      const edgeWindow = cropImage(referenceEdgeWindow, {
        x,
        y,
        width: previewGrayScaled.width,
        height: previewGrayScaled.height,
      });
      const signature = buildWindowSignature(grayWindow, edgeWindow);
      const score = signatureSimilarity(previewSignature, signature);
      insertCandidate(
        candidates,
        {
          bbox: rescaleBox(
            {
              x: scaledWindow.x + x,
              y: scaledWindow.y + y,
              width: previewGrayScaled.width,
              height: previewGrayScaled.height,
            },
            level.scale,
          ),
          score,
          modality: previewSignature.edgeDensity > 0.08 ? "edge" : "gray",
          levelScale: level.scale,
        },
        maxCandidates,
      );
    }
  }

  return {
    candidates,
    denseFallbackUsed,
  };
}

export function buildWindowSignature(gray: ImageLike, edge: ImageLike): WindowSignature {
  const thumbGray = resizeToDimensions(gray, 8, 8);
  const thumbEdge = resizeToDimensions(edge, 8, 8);
  const thumbnail = new Float32Array(64);
  const horizontal = new Float32Array(8);
  const vertical = new Float32Array(8);
  let fillPixels = 0;
  let edgePixels = 0;

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const index = y * 8 + x;
      const grayValue = thumbGray.data[index] / 255;
      const edgeValue = thumbEdge.data[index] > 0 ? 1 : 0;
      thumbnail[index] = grayValue;
      horizontal[y] += edgeValue;
      vertical[x] += edgeValue;
      if (grayValue < 0.92) {
        fillPixels += 1;
      }
      edgePixels += edgeValue;
    }
  }

  normalizeVector(horizontal);
  normalizeVector(vertical);

  return {
    thumbnail,
    horizontalEdgeProjection: horizontal,
    verticalEdgeProjection: vertical,
    edgeDensity: edgePixels / 64,
    fillRatio: fillPixels / 64,
    aspectRatio: gray.width / Math.max(1, gray.height),
  };
}

function signatureSimilarity(left: WindowSignature, right: WindowSignature): number {
  const thumbnail = 1 - meanAbsoluteDiff(left.thumbnail, right.thumbnail);
  const horizontal =
    1 - meanAbsoluteDiff(left.horizontalEdgeProjection, right.horizontalEdgeProjection);
  const vertical = 1 - meanAbsoluteDiff(left.verticalEdgeProjection, right.verticalEdgeProjection);
  const density = 1 - Math.min(1, Math.abs(left.edgeDensity - right.edgeDensity));
  const fill = 1 - Math.min(1, Math.abs(left.fillRatio - right.fillRatio));
  const aspect =
    1 -
    Math.min(
      1,
      Math.abs(Math.log(left.aspectRatio / Math.max(0.01, right.aspectRatio))) / Math.log(2),
    );

  return roundMetric(
    thumbnail * 0.4 +
      horizontal * 0.18 +
      vertical * 0.18 +
      density * 0.12 +
      fill * 0.07 +
      aspect * 0.05,
  );
}

function selectCacheLevel(
  cache: ReferenceSearchCache,
  searchWindow: BoundingBox,
): ReferenceCacheLevel {
  const area = searchWindow.width * searchWindow.height;

  if (area > 220_000) {
    return cache.levels.find((level) => level.scale === 0.25) ?? cache.levels.at(-1)!;
  }

  if (area > 60_000) {
    return cache.levels.find((level) => level.scale === 0.5) ?? cache.levels[1] ?? cache.levels[0];
  }

  return cache.levels[0];
}

function insertCandidate(
  candidates: CoarseCandidate[],
  candidate: CoarseCandidate,
  limit: number,
): void {
  let insertIndex = candidates.findIndex((existing) => candidate.score > existing.score);

  if (insertIndex === -1) {
    insertIndex = candidates.length;
  }

  candidates.splice(insertIndex, 0, candidate);

  if (candidates.length > limit) {
    candidates.pop();
  }
}

function meanAbsoluteDiff(left: Float32Array, right: Float32Array): number {
  let diff = 0;

  for (let index = 0; index < left.length; index += 1) {
    diff += Math.abs(left[index] - right[index]);
  }

  return diff / left.length;
}

function normalizeVector(vector: Float32Array): void {
  const sum = vector.reduce((acc, value) => acc + value, 0);

  if (sum <= 0) {
    return;
  }

  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= sum;
  }
}

function coarseStride(image: ImageLike): number {
  return Math.max(4, Math.min(8, Math.floor(Math.min(image.width, image.height) / 3) || 4));
}

function scaleBox(box: BoundingBox, scale: number): BoundingBox {
  return {
    x: Math.floor(box.x * scale),
    y: Math.floor(box.y * scale),
    width: Math.max(1, Math.ceil(box.width * scale)),
    height: Math.max(1, Math.ceil(box.height * scale)),
  };
}

function rescaleBox(box: BoundingBox, scale: number): BoundingBox {
  if (scale === 1) {
    return box;
  }

  return {
    x: Math.round(box.x / scale),
    y: Math.round(box.y / scale),
    width: Math.max(1, Math.round(box.width / scale)),
    height: Math.max(1, Math.round(box.height / scale)),
  };
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

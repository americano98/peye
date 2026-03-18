import { DEFAULT_EDGE_THRESHOLD } from "../config/defaults.js";

export interface StructuralAnalysis {
  edgeMaskReference: Uint8Array;
  edgeMaskPreview: Uint8Array;
  edgeDiffMask: Uint8Array;
  structuralMismatchPercent: number;
}

export function analyzeStructure(
  reference: Uint8ClampedArray,
  preview: Uint8ClampedArray,
  width: number,
  height: number,
  ignoreMask?: Uint8Array,
): StructuralAnalysis {
  const lumaReference = rgbaToLuma(reference, width, height);
  const lumaPreview = rgbaToLuma(preview, width, height);
  const edgeMaskReference = sobelEdgeMask(lumaReference, width, height, DEFAULT_EDGE_THRESHOLD);
  const edgeMaskPreview = sobelEdgeMask(lumaPreview, width, height, DEFAULT_EDGE_THRESHOLD);
  const edgeDiffMask = new Uint8Array(width * height);

  let unionCount = 0;
  let diffCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;

      if (touchesIgnoredNeighborhood(ignoreMask, x, y, width, height)) {
        continue;
      }

      const ref = edgeMaskReference[index];
      const prev = edgeMaskPreview[index];
      const union = ref === 1 || prev === 1;

      if (union) {
        unionCount += 1;
      }

      if (ref !== prev) {
        edgeDiffMask[index] = 1;
        diffCount += 1;
      }
    }
  }

  return {
    edgeMaskReference,
    edgeMaskPreview,
    edgeDiffMask,
    structuralMismatchPercent: unionCount === 0 ? 0 : (diffCount / unionCount) * 100,
  };
}

function touchesIgnoredNeighborhood(
  ignoreMask: Uint8Array | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  if (!ignoreMask) {
    return false;
  }

  const xStart = Math.max(0, x - 1);
  const yStart = Math.max(0, y - 1);
  const xEnd = Math.min(width - 1, x + 1);
  const yEnd = Math.min(height - 1, y + 1);

  for (let candidateY = yStart; candidateY <= yEnd; candidateY += 1) {
    for (let candidateX = xStart; candidateX <= xEnd; candidateX += 1) {
      if (ignoreMask[candidateY * width + candidateX] === 1) {
        return true;
      }
    }
  }

  return false;
}

function rgbaToLuma(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const luma = new Float32Array(width * height);

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    luma[index] = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
  }

  return luma;
}

function sobelEdgeMask(
  luma: Float32Array,
  width: number,
  height: number,
  threshold: number,
): Uint8Array {
  const edgeMask = new Uint8Array(width * height);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = luma[(y - 1) * width + (x - 1)];
      const top = luma[(y - 1) * width + x];
      const topRight = luma[(y - 1) * width + (x + 1)];
      const left = luma[y * width + (x - 1)];
      const right = luma[y * width + (x + 1)];
      const bottomLeft = luma[(y + 1) * width + (x - 1)];
      const bottom = luma[(y + 1) * width + x];
      const bottomRight = luma[(y + 1) * width + (x + 1)];

      const gx = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gy = topLeft + 2 * top + topRight - bottomLeft - 2 * bottom - bottomRight;
      const magnitude = Math.sqrt(gx * gx + gy * gy);

      if (magnitude >= threshold) {
        edgeMask[y * width + x] = 1;
      }
    }
  }

  return edgeMask;
}

import { DEFAULT_EDGE_THRESHOLD } from "../config/defaults.js";
import type { ImageLike, ReferenceCacheLevel, ReferenceSearchCache } from "./types.js";

export function buildReferenceSearchCache(reference: ImageLike): ReferenceSearchCache {
  const grayLevels: ReferenceCacheLevel[] = [];
  let currentGray = reference;

  for (const scale of [1, 0.5, 0.25] as const) {
    if (scale === 1) {
      currentGray = reference;
    } else {
      currentGray = resizeImage(reference, scale);
    }

    grayLevels.push({
      scale,
      gray: currentGray,
      edge: buildEdgeMask(currentGray),
    });
  }

  return {
    levels: grayLevels,
  };
}

export function rgbaToLumaImage(data: Uint8ClampedArray, width: number, height: number): ImageLike {
  const luma = new Float32Array(width * height);

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    luma[index] = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
  }

  return {
    width,
    height,
    data: luma,
  };
}

export function cropImage(
  image: ImageLike,
  bbox: { x: number; y: number; width: number; height: number },
): ImageLike {
  const x = Math.max(0, Math.floor(bbox.x));
  const y = Math.max(0, Math.floor(bbox.y));
  const width = Math.max(1, Math.min(image.width - x, Math.round(bbox.width)));
  const height = Math.max(1, Math.min(image.height - y, Math.round(bbox.height)));
  const data = new Float32Array(width * height);

  for (let row = 0; row < height; row += 1) {
    const sourceOffset = (y + row) * image.width + x;
    const targetOffset = row * width;
    for (let column = 0; column < width; column += 1) {
      data[targetOffset + column] = image.data[sourceOffset + column];
    }
  }

  return {
    width,
    height,
    data,
  };
}

export function resizeToDimensions(image: ImageLike, width: number, height: number): ImageLike {
  if (image.width === width && image.height === height) {
    return image;
  }

  const data = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = sampleAt(
        image,
        (x / Math.max(1, width - 1)) * (image.width - 1),
        (y / Math.max(1, height - 1)) * (image.height - 1),
      );
    }
  }

  return {
    width,
    height,
    data,
  };
}

export function buildEdgeMask(image: ImageLike): ImageLike {
  const edge = new Float32Array(image.width * image.height);

  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const topLeft = image.data[(y - 1) * image.width + (x - 1)];
      const top = image.data[(y - 1) * image.width + x];
      const topRight = image.data[(y - 1) * image.width + (x + 1)];
      const left = image.data[y * image.width + (x - 1)];
      const right = image.data[y * image.width + (x + 1)];
      const bottomLeft = image.data[(y + 1) * image.width + (x - 1)];
      const bottom = image.data[(y + 1) * image.width + x];
      const bottomRight = image.data[(y + 1) * image.width + (x + 1)];
      const gx = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gy = topLeft + 2 * top + topRight - bottomLeft - 2 * bottom - bottomRight;
      edge[y * image.width + x] = Math.sqrt(gx * gx + gy * gy) >= DEFAULT_EDGE_THRESHOLD ? 255 : 0;
    }
  }

  return {
    width: image.width,
    height: image.height,
    data: edge,
  };
}

function resizeImage(image: ImageLike, scale: number): ImageLike {
  return resizeToDimensions(
    image,
    Math.max(8, Math.round(image.width * scale)),
    Math.max(8, Math.round(image.height * scale)),
  );
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

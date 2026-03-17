import { DEFAULT_MIN_REGION_PIXELS } from "../config/defaults.js";

export interface RawRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelCount: number;
}

export function extractRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  minPixels = DEFAULT_MIN_REGION_PIXELS,
): RawRegion[] {
  const visited = new Uint8Array(mask.length);
  const regions: RawRegion[] = [];
  const queue = new Uint32Array(mask.length);

  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0 || visited[index] === 1) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail] = index;
    tail += 1;
    visited[index] = 1;

    let minX = index % width;
    let maxX = minX;
    let minY = Math.floor(index / width);
    let maxY = minY;
    let pixelCount = 0;

    while (head < tail) {
      const current = queue[head];
      head += 1;

      const x = current % width;
      const y = Math.floor(current / width);
      pixelCount += 1;

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      if (x > 0) {
        const neighbor = current - 1;
        if (mask[neighbor] === 1 && visited[neighbor] === 0) {
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }

      if (x < width - 1) {
        const neighbor = current + 1;
        if (mask[neighbor] === 1 && visited[neighbor] === 0) {
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }

      if (y > 0) {
        const neighbor = current - width;
        if (mask[neighbor] === 1 && visited[neighbor] === 0) {
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }

      if (y < height - 1) {
        const neighbor = current + width;
        if (mask[neighbor] === 1 && visited[neighbor] === 0) {
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }

    if (pixelCount < minPixels) {
      continue;
    }

    regions.push({
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      pixelCount,
    });
  }

  return regions;
}

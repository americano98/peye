import type { FindingVisualization } from "../analysis/findings.js";
import type { Severity } from "../types/report.js";

export function createHeatmapArtifact(params: {
  reference: Uint8ClampedArray;
  preview: Uint8ClampedArray;
  mismatchMask: Uint8Array;
  visuals: FindingVisualization[];
  width: number;
  height: number;
}): Uint8ClampedArray {
  const heatmap = new Uint8ClampedArray(params.reference.length);

  for (let index = 0; index < params.mismatchMask.length; index += 1) {
    const offset = index * 4;
    const base = Math.round(((params.reference[offset] + params.preview[offset]) / 2) * 0.25);
    heatmap[offset] = base;
    heatmap[offset + 1] = base;
    heatmap[offset + 2] = base;
    heatmap[offset + 3] = 255;

    if (params.mismatchMask[index] === 1) {
      heatmap[offset] = 255;
      heatmap[offset + 1] = 120;
      heatmap[offset + 2] = 0;
    }
  }

  for (const visual of params.visuals) {
    drawBoundingBox(
      heatmap,
      params.width,
      params.height,
      visual.primaryBox,
      boundingBoxColor(visual.severity),
      2,
    );

    for (const hotspotBox of visual.hotspotBoxes) {
      drawBoundingBox(
        heatmap,
        params.width,
        params.height,
        hotspotBox,
        hotspotColor(visual.severity),
        1,
      );
    }
  }

  return heatmap;
}

function drawBoundingBox(
  image: Uint8ClampedArray,
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
  color: [number, number, number, number],
  thickness: number,
): void {
  for (let inset = 0; inset < thickness; inset += 1) {
    const xStart = Math.max(0, box.x + inset);
    const yStart = Math.max(0, box.y + inset);
    const xEnd = Math.min(width - 1, box.x + box.width - 1 - inset);
    const yEnd = Math.min(height - 1, box.y + box.height - 1 - inset);

    if (xEnd < xStart || yEnd < yStart) {
      continue;
    }

    for (let x = xStart; x <= xEnd; x += 1) {
      paintPixel(image, width, x, yStart, color);
      paintPixel(image, width, x, yEnd, color);
    }

    for (let y = yStart; y <= yEnd; y += 1) {
      paintPixel(image, width, xStart, y, color);
      paintPixel(image, width, xEnd, y, color);
    }
  }
}

function paintPixel(
  image: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  color: [number, number, number, number],
): void {
  const offset = (y * width + x) * 4;
  image[offset] = color[0];
  image[offset + 1] = color[1];
  image[offset + 2] = color[2];
  image[offset + 3] = color[3];
}

function boundingBoxColor(severity: Severity): [number, number, number, number] {
  switch (severity) {
    case "critical":
      return [255, 255, 255, 255];
    case "high":
      return [255, 0, 255, 255];
    case "medium":
      return [0, 255, 255, 255];
    case "low":
    default:
      return [0, 255, 0, 255];
  }
}

function hotspotColor(severity: Severity): [number, number, number, number] {
  switch (severity) {
    case "critical":
      return [255, 220, 120, 255];
    case "high":
      return [255, 140, 120, 255];
    case "medium":
      return [120, 220, 255, 255];
    case "low":
    default:
      return [120, 255, 180, 255];
  }
}

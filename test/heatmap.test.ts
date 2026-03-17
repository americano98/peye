import { describe, expect, test } from "vitest";
import { createHeatmapArtifact } from "../src/compare/heatmap.js";
import type { FindingVisualization } from "../src/analysis/findings.js";

function readPixel(
  image: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const offset = (y * width + x) * 4;
  return [
    image[offset] ?? 0,
    image[offset + 1] ?? 0,
    image[offset + 2] ?? 0,
    image[offset + 3] ?? 0,
  ];
}

function createVisual(overrides: Partial<FindingVisualization>): FindingVisualization {
  return {
    severity: overrides.severity ?? "medium",
    primaryBox: overrides.primaryBox ?? {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    },
    hotspotBoxes: overrides.hotspotBoxes ?? [],
  };
}

describe("createHeatmapArtifact", () => {
  test("draws primary boxes with thicker outline and hotspot boxes inside them", () => {
    const width = 16;
    const height = 16;
    const reference = new Uint8ClampedArray(width * height * 4);
    const preview = new Uint8ClampedArray(width * height * 4);
    const mismatchMask = new Uint8Array(width * height);
    mismatchMask[8 * width + 8] = 1;

    const heatmap = createHeatmapArtifact({
      reference,
      preview,
      mismatchMask,
      visuals: [
        createVisual({
          severity: "medium",
          primaryBox: {
            x: 2,
            y: 2,
            width: 8,
            height: 6,
          },
          hotspotBoxes: [
            {
              x: 6,
              y: 6,
              width: 3,
              height: 3,
            },
          ],
        }),
      ],
      width,
      height,
    });

    expect(readPixel(heatmap, width, 2, 2)).toEqual([0, 255, 255, 255]);
    expect(readPixel(heatmap, width, 3, 3)).toEqual([0, 255, 255, 255]);
    expect(readPixel(heatmap, width, 6, 6)).toEqual([120, 220, 255, 255]);
    expect(readPixel(heatmap, width, 8, 8)).toEqual([120, 220, 255, 255]);
    expect(readPixel(heatmap, width, 7, 5)).toEqual([0, 0, 0, 255]);
  });

  test("draws visual-cluster primary box and hotspot box", () => {
    const width = 16;
    const height = 16;
    const reference = new Uint8ClampedArray(width * height * 4);
    const preview = new Uint8ClampedArray(width * height * 4);
    const mismatchMask = new Uint8Array(width * height);

    const heatmap = createHeatmapArtifact({
      reference,
      preview,
      mismatchMask,
      visuals: [
        createVisual({
          severity: "high",
          primaryBox: {
            x: 4,
            y: 4,
            width: 5,
            height: 5,
          },
          hotspotBoxes: [
            {
              x: 5,
              y: 5,
              width: 2,
              height: 2,
            },
          ],
        }),
      ],
      width,
      height,
    });

    expect(readPixel(heatmap, width, 4, 4)).toEqual([255, 0, 255, 255]);
    expect(readPixel(heatmap, width, 5, 5)).toEqual([255, 140, 120, 255]);
    expect(readPixel(heatmap, width, 7, 7)).toEqual([255, 0, 255, 255]);
  });
});

import { describe, expect, test } from "vitest";
import { buildGroups } from "../src/correspond/build-groups.js";
import { runCoarseSearch } from "../src/correspond/coarse-search.js";
import { localizeElementGroups } from "../src/correspond/locate-elements.js";
import type { DomSnapshot, DomSnapshotElement } from "../src/types/internal.js";
import type { ImageLike } from "../src/correspond/types.js";

function createImage(width: number, height: number, fill = 255): ImageLike {
  return {
    width,
    height,
    data: new Float32Array(width * height).fill(fill),
  };
}

function fillRect(
  image: ImageLike,
  x: number,
  y: number,
  width: number,
  height: number,
  value: number,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      image.data[row * image.width + column] = value;
    }
  }
}

function toRgba(image: ImageLike): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);

  for (let index = 0; index < image.data.length; index += 1) {
    const offset = index * 4;
    const value = Math.max(0, Math.min(255, Math.round(image.data[index])));
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }

  return rgba;
}

function createSnapshotElement(
  overrides: Partial<DomSnapshotElement> & Pick<DomSnapshotElement, "id" | "selector" | "bbox">,
): DomSnapshotElement {
  return {
    id: overrides.id,
    tag: overrides.tag ?? "div",
    selector: overrides.selector,
    role: overrides.role ?? null,
    testId: overrides.testId ?? null,
    domId: overrides.domId ?? null,
    classSummary: overrides.classSummary ?? [],
    textSnippet: overrides.textSnippet ?? null,
    bbox: overrides.bbox,
    depth: overrides.depth ?? 1,
    captureClippedEdges: overrides.captureClippedEdges ?? [],
    textMetrics: overrides.textMetrics ?? null,
    ancestry: overrides.ancestry ?? [],
    locator: overrides.locator ?? {
      tag: overrides.tag ?? "div",
      selector: overrides.selector,
      role: overrides.role ?? null,
      testId: overrides.testId ?? null,
      domId: overrides.domId ?? null,
      classSummary: overrides.classSummary ?? [],
    },
    identity: overrides.identity ?? {
      domId: overrides.domId ?? null,
      classSummary: overrides.classSummary ?? [],
      testId: overrides.testId ?? null,
      semanticTag: overrides.tag ?? "div",
      candidateKind: overrides.candidateKind ?? "anchor",
    },
    computedStyle: overrides.computedStyle ?? {
      fontSize: "16px",
      lineHeight: "24px",
      fontWeight: "400",
      color: "rgb(0, 0, 0)",
      backgroundColor: "transparent",
      borderRadius: "0px",
      gap: "0px",
      padding: "0px",
      width: `${overrides.bbox.width}px`,
      height: `${overrides.bbox.height}px`,
      margin: "0px",
    },
    textLayout: overrides.textLayout ?? null,
    visibility: overrides.visibility ?? {
      isVisible: true,
      display: "block",
      visibility: "visible",
      opacity: 1,
      pointerEvents: "auto",
      ariaHidden: null,
    },
    interactivity: overrides.interactivity ?? {
      isInteractive: false,
      disabled: null,
      tabIndex: null,
      cursor: "default",
    },
    overlapHints: overrides.overlapHints ?? {
      topMostAtCenter: overrides.selector,
      stackDepthAtCenter: 1,
      occludingSelector: null,
      captureClippedEdges: [],
    },
    candidateKind: overrides.candidateKind ?? "anchor",
    anchorElementId: overrides.anchorElementId ?? overrides.id,
  };
}

describe("buildGroups", () => {
  test("collapses empty wrapper chains toward the nearest meaningful parent", () => {
    const root = createSnapshotElement({
      id: "#root",
      selector: "#root",
      bbox: { x: 0, y: 0, width: 300, height: 200 },
      tag: "section",
      depth: 0,
    });
    const row = createSnapshotElement({
      id: "#row",
      selector: "#row",
      bbox: { x: 12, y: 24, width: 180, height: 40 },
      ancestry: [root.locator],
    });
    const wrapA = createSnapshotElement({
      id: "#wrap-a",
      selector: "#wrap-a",
      bbox: { x: 16, y: 28, width: 28, height: 24 },
      ancestry: [row.locator, root.locator],
    });
    const wrapB = createSnapshotElement({
      id: "#wrap-b",
      selector: "#wrap-b",
      bbox: { x: 18, y: 30, width: 20, height: 20 },
      ancestry: [wrapA.locator, row.locator, root.locator],
    });
    const icon = createSnapshotElement({
      id: "#icon",
      selector: "#icon",
      tag: "svg",
      bbox: { x: 20, y: 32, width: 14, height: 14 },
      ancestry: [wrapB.locator, wrapA.locator, row.locator, root.locator],
    });
    const label = createSnapshotElement({
      id: "#label",
      selector: "#label",
      tag: "span",
      textSnippet: "Revenue",
      bbox: { x: 52, y: 30, width: 80, height: 18 },
      ancestry: [row.locator, root.locator],
    });
    const snapshot: DomSnapshot = {
      root,
      elements: [row, wrapA, wrapB, icon, label],
      bindingCandidates: [row, wrapA, wrapB, icon, label],
    };

    const groups = buildGroups({
      domSnapshot: snapshot,
      rawRegions: [],
    });

    expect(groups.groupsById.has("#row")).toBe(true);
    expect(groups.elementToGroupId.get("#icon")).toBe("#row");
    expect(groups.elementToGroupId.get("#wrap-b")).toBe("#row");
    expect(groups.elementToGroupId.get("#label")).toBe("#label");
  });

  test("groups sibling text leaves into their immediate text container", () => {
    const root = createSnapshotElement({
      id: "#root",
      selector: "#root",
      bbox: { x: 0, y: 0, width: 320, height: 200 },
      tag: "section",
      depth: 0,
    });
    const textBlock = createSnapshotElement({
      id: "#text-block",
      selector: "#text-block",
      bbox: { x: 20, y: 24, width: 200, height: 60 },
      ancestry: [root.locator],
    });
    const heading = createSnapshotElement({
      id: "#heading",
      selector: "#heading",
      tag: "h3",
      textSnippet: "Fast training",
      bbox: { x: 20, y: 24, width: 180, height: 24 },
      ancestry: [textBlock.locator, root.locator],
    });
    const body = createSnapshotElement({
      id: "#body",
      selector: "#body",
      tag: "p",
      textSnippet: "Less GPU time",
      bbox: { x: 20, y: 54, width: 180, height: 20 },
      ancestry: [textBlock.locator, root.locator],
    });
    const snapshot: DomSnapshot = {
      root,
      elements: [textBlock, heading, body],
      bindingCandidates: [textBlock, heading, body],
    };

    const groups = buildGroups({
      domSnapshot: snapshot,
      rawRegions: [],
    });

    expect(groups.elementToGroupId.get("#heading")).toBe("#text-block");
    expect(groups.elementToGroupId.get("#body")).toBe("#text-block");
  });

  test("keeps significant text siblings separate when typography differs strongly", () => {
    const root = createSnapshotElement({
      id: "#root",
      selector: "#root",
      bbox: { x: 0, y: 0, width: 640, height: 320 },
      tag: "section",
      depth: 0,
    });
    const header = createSnapshotElement({
      id: "#header",
      selector: "#header",
      tag: "header",
      bbox: { x: 40, y: 32, width: 520, height: 180 },
      ancestry: [root.locator],
    });
    const eyebrow = createSnapshotElement({
      id: "#eyebrow",
      selector: "#eyebrow",
      tag: "p",
      textSnippet: "Mindbeam Benefits",
      bbox: { x: 40, y: 40, width: 320, height: 20 },
      ancestry: [header.locator, root.locator],
      computedStyle: {
        fontSize: "16px",
        lineHeight: "20px",
        fontWeight: "500",
        color: "rgb(99, 126, 207)",
        backgroundColor: "transparent",
        borderRadius: "0px",
        gap: "0px",
        padding: "0px",
        width: "320px",
        height: "20px",
        margin: "0px",
      },
    });
    const title = createSnapshotElement({
      id: "#title",
      selector: "#title",
      tag: "h2",
      textSnippet: "Built for practical LLM training",
      bbox: { x: 40, y: 76, width: 429, height: 112 },
      ancestry: [header.locator, root.locator],
      computedStyle: {
        fontSize: "56px",
        lineHeight: "56px",
        fontWeight: "500",
        color: "rgb(13, 13, 12)",
        backgroundColor: "transparent",
        borderRadius: "0px",
        gap: "0px",
        padding: "0px",
        width: "429px",
        height: "112px",
        margin: "0px",
      },
    });
    const body = createSnapshotElement({
      id: "#body",
      selector: "#body",
      tag: "p",
      textSnippet: "Accelerate LLM training while maximizing GPU efficiency.",
      bbox: { x: 40, y: 210, width: 416, height: 81 },
      ancestry: [header.locator, root.locator],
      computedStyle: {
        fontSize: "18px",
        lineHeight: "27px",
        fontWeight: "400",
        color: "rgb(13, 13, 12)",
        backgroundColor: "transparent",
        borderRadius: "0px",
        gap: "0px",
        padding: "0px",
        width: "416px",
        height: "81px",
        margin: "0px",
      },
    });
    const snapshot: DomSnapshot = {
      root,
      elements: [header, eyebrow, title, body],
      bindingCandidates: [header, eyebrow, title, body],
    };

    const groups = buildGroups({
      domSnapshot: snapshot,
      rawRegions: [],
    });

    expect(groups.elementToGroupId.get("#eyebrow")).toBe("#eyebrow");
    expect(groups.elementToGroupId.get("#title")).toBe("#title");
    expect(groups.elementToGroupId.get("#body")).toBe("#body");
  });

  test("groups tiny graphics into a nearby interactive ancestor", () => {
    const root = createSnapshotElement({
      id: "#root",
      selector: "#root",
      bbox: { x: 0, y: 0, width: 320, height: 200 },
      tag: "section",
      depth: 0,
    });
    const button = createSnapshotElement({
      id: "#cta",
      selector: "#cta",
      tag: "button",
      bbox: { x: 20, y: 24, width: 120, height: 36 },
      ancestry: [root.locator],
      interactivity: {
        isInteractive: true,
        disabled: null,
        tabIndex: 0,
        cursor: "pointer",
      },
    });
    const iconWrap = createSnapshotElement({
      id: "#icon-wrap",
      selector: "#icon-wrap",
      bbox: { x: 100, y: 32, width: 16, height: 16 },
      ancestry: [button.locator, root.locator],
    });
    const icon = createSnapshotElement({
      id: "#icon",
      selector: "#icon",
      tag: "svg",
      bbox: { x: 100, y: 32, width: 16, height: 16 },
      ancestry: [iconWrap.locator, button.locator, root.locator],
    });
    const snapshot: DomSnapshot = {
      root,
      elements: [button, iconWrap, icon],
      bindingCandidates: [button, iconWrap, icon],
    };

    const groups = buildGroups({
      domSnapshot: snapshot,
      rawRegions: [],
    });

    expect(groups.elementToGroupId.get("#icon")).toBe("#cta");
  });
});

describe("runCoarseSearch", () => {
  test("uses coarse search rather than dense fallback on large windows", () => {
    const previewGrayPatch = createImage(48, 24, 255);
    const previewEdgePatch = createImage(48, 24, 0);
    fillRect(previewGrayPatch, 8, 4, 28, 12, 20);
    fillRect(previewEdgePatch, 8, 4, 28, 12, 255);
    const reference = createImage(280, 160, 255);
    fillRect(reference, 116, 48, 28, 12, 20);
    const cache = {
      levels: [
        {
          scale: 1,
          gray: reference,
          edge: reference,
        },
      ],
    };

    const result = runCoarseSearch({
      previewGrayPatch,
      previewEdgePatch,
      searchWindow: { x: 0, y: 0, width: 280, height: 160 },
      referenceCache: cache,
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.denseFallbackUsed).toBe(false);
  });
});

describe("localizeElementGroups", () => {
  test("skips work entirely when there are no mismatch regions", () => {
    const root = createSnapshotElement({
      id: "#root",
      selector: "#root",
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      tag: "section",
      depth: 0,
    });
    const snapshot: DomSnapshot = {
      root,
      elements: [],
      bindingCandidates: [],
    };

    const result = localizeElementGroups({
      preview: toRgba(createImage(100, 100)),
      reference: toRgba(createImage(100, 100)),
      width: 100,
      height: 100,
      rawRegions: [],
      domSnapshot: snapshot,
    });

    expect(result.summary.processedGroups).toBe(0);
    expect(result.profile.counts.groupsSearched).toBe(0);
    expect(result.localizationsByGroupId.size).toBe(0);
  });

  test("counts budget-skipped mismatch groups in correspondence coverage", () => {
    const root = createSnapshotElement({
      id: "#root",
      selector: "#root",
      bbox: { x: 0, y: 0, width: 600, height: 400 },
      tag: "section",
      depth: 0,
    });
    const elements: DomSnapshotElement[] = [];
    const rawRegions = [];

    for (let index = 0; index < 14; index += 1) {
      const x = 20 + index * 50;
      const id = `#item-${index}`;
      const element = createSnapshotElement({
        id,
        selector: id,
        tag: "div",
        textSnippet: `Item ${index}`,
        bbox: { x, y: 40, width: 32, height: 24 },
        ancestry: [root.locator],
      });
      elements.push(element);
      rawRegions.push({
        x,
        y: 40,
        width: 32,
        height: 24,
        pixelCount: 32 * 24,
        mismatchPercent: 1,
        kind: "layout" as const,
        severity: "medium" as const,
      });
    }

    const snapshot: DomSnapshot = {
      root,
      elements,
      bindingCandidates: elements,
    };
    const image = createImage(600, 400, 255);

    for (const element of elements) {
      fillRect(image, element.bbox.x, element.bbox.y, element.bbox.width, element.bbox.height, 20);
    }

    const result = localizeElementGroups({
      preview: toRgba(image),
      reference: toRgba(image),
      width: image.width,
      height: image.height,
      rawRegions,
      domSnapshot: snapshot,
    });

    expect(result.profile.counts.groupsSkippedDueToBudget).toBeGreaterThan(0);
    expect(result.summary.processedGroups).toBe(14);
    expect(result.summary.correspondenceCoverage).toBeLessThan(1);
  });
});

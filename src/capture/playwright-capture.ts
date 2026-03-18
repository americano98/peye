import { unlink } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import {
  DEFAULT_CAPTURE_DELAY_MS,
  DEFAULT_FONT_READY_TIMEOUT_MS,
  DEFAULT_MAX_SELECTOR_LENGTH,
  DEFAULT_MAX_TEXT_SNIPPET_LENGTH,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
} from "../config/defaults.js";
import type { DomSnapshot, ParsedPreviewInput, PreparedPreviewImage } from "../types/internal.js";
import type { BoundingBox, IgnoreSelectorReport } from "../types/report.js";
import { AppError, ensureError } from "../utils/errors.js";
import { normalizeImageToPng } from "../io/image.js";
import { launchPlaywrightChromium } from "./playwright-runtime.js";

export async function materializePreviewImage(
  preview: ParsedPreviewInput,
  outputPath: string,
  fullPage: boolean,
): Promise<PreparedPreviewImage> {
  if (preview.kind === "path") {
    try {
      const normalized = await normalizeImageToPng(preview.resolved, outputPath);
      return {
        ...normalized,
        analysisMode: "visual-clusters",
        domSnapshot: null,
        ignoreRegions: [],
        ignoreSelectorMatches: [],
      };
    } catch (error) {
      throw new AppError(
        `Failed to normalize preview image: ${preview.resolved}. ${ensureError(error).message}`,
        {
          code: "preview_image_normalization_failed",
          cause: error,
        },
      );
    }
  }

  const temporaryCapturePath = buildTemporaryCapturePath(outputPath);
  const browser = await launchPlaywrightChromium();
  let domSnapshot: DomSnapshot | null;
  let ignoreSelection!: IgnoreSelectionResult;

  try {
    const page = await browser.newPage({
      viewport: preview.viewport,
      deviceScaleFactor: 1,
    });

    await navigateForCapture(page, preview.resolved);
    await waitForCaptureStability(page);

    if (preview.selector !== null) {
      const locator = page.locator(preview.selector).first();
      await locator.waitFor({ state: "visible", timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
      await locator.scrollIntoViewIfNeeded();
      ignoreSelection = await collectSelectorIgnoreSelections(locator, preview.ignoreSelectors);
      domSnapshot = await collectSelectorDomSnapshot(locator);
      await locator.screenshot({
        path: temporaryCapturePath,
        animations: "disabled",
        caret: "hide",
        scale: "css",
        type: "png",
      });
    } else {
      ignoreSelection = await collectPageIgnoreSelections(page, preview.ignoreSelectors, fullPage);
      domSnapshot = await collectPageDomSnapshot(page, fullPage);
      await page.screenshot({
        path: temporaryCapturePath,
        animations: "disabled",
        caret: "hide",
        fullPage,
        scale: "css",
        type: "png",
      });
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (preview.selector !== null) {
      throw new AppError(
        `Preview selector could not be captured: ${preview.selector}. ${ensureError(error).message}`,
        {
          exitCode: 3,
          recommendation: "needs_human_review",
          severity: "high",
          code: "preview_selector_capture_failed",
          cause: error,
        },
      );
    }

    throw new AppError(`Preview page could not be captured. ${ensureError(error).message}`, {
      exitCode: 3,
      recommendation: "needs_human_review",
      severity: "high",
      code: "preview_capture_failed",
      cause: error,
    });
  } finally {
    await browser.close();
  }

  try {
    const normalized = await normalizeImageToPng(temporaryCapturePath, outputPath);
    return {
      ...normalized,
      analysisMode: "dom-elements",
      domSnapshot,
      ignoreRegions: ignoreSelection.ignoreRegions,
      ignoreSelectorMatches: ignoreSelection.ignoreSelectorMatches,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      `Failed to normalize captured preview image: ${temporaryCapturePath}. ${ensureError(error).message}`,
      {
        code: "preview_capture_normalization_failed",
        cause: error,
      },
    );
  } finally {
    await unlink(temporaryCapturePath).catch(() => undefined);
  }
}

async function navigateForCapture(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: DEFAULT_NAVIGATION_TIMEOUT_MS,
    });
  } catch {
    await page.goto(url, {
      waitUntil: "load",
      timeout: DEFAULT_NAVIGATION_TIMEOUT_MS,
    });
  }
}

async function waitForCaptureStability(page: Page): Promise<void> {
  await page
    .evaluate(
      async ({ fontTimeoutMs }) => {
        const fonts = document.fonts;

        if (!fonts) {
          return;
        }

        await Promise.race([
          fonts.ready,
          new Promise((resolve) => {
            window.setTimeout(resolve, fontTimeoutMs);
          }),
        ]);
      },
      { fontTimeoutMs: DEFAULT_FONT_READY_TIMEOUT_MS },
    )
    .catch(() => undefined);

  await page.waitForTimeout(DEFAULT_CAPTURE_DELAY_MS);
}

function buildTemporaryCapturePath(outputPath: string): string {
  const parsedPath = path.parse(outputPath);
  return path.join(
    parsedPath.dir,
    `${parsedPath.name}.capture-${process.pid}-${Date.now()}${parsedPath.ext || ".png"}`,
  );
}

interface IgnoreSelectionResult {
  ignoreRegions: BoundingBox[];
  ignoreSelectorMatches: IgnoreSelectorReport[];
}

async function collectSelectorIgnoreSelections(
  locator: Locator,
  ignoreSelectors: readonly string[],
): Promise<IgnoreSelectionResult> {
  if (ignoreSelectors.length === 0) {
    return {
      ignoreRegions: [],
      ignoreSelectorMatches: [],
    };
  }

  try {
    return await locator.evaluate(
      (root, selectors) => {
        const captureBounds = (() => {
          const rootRect = root.getBoundingClientRect();
          return {
            x: 0,
            y: 0,
            width: Math.max(1, Math.round(rootRect.width)),
            height: Math.max(1, Math.round(rootRect.height)),
            rootLeft: rootRect.left,
            rootTop: rootRect.top,
          };
        })();
        const isVisible = (element: Element): boolean => {
          const rect = element.getBoundingClientRect();

          if (rect.width <= 0 || rect.height <= 0) {
            return false;
          }

          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };
        const clipBoxToBounds = (
          box: { x: number; y: number; width: number; height: number },
          bounds: { x: number; y: number; width: number; height: number },
        ) => {
          const left = Math.max(bounds.x, box.x);
          const top = Math.max(bounds.y, box.y);
          const right = Math.min(bounds.x + bounds.width, box.x + box.width);
          const bottom = Math.min(bounds.y + bounds.height, box.y + box.height);

          if (right <= left || bottom <= top) {
            return null;
          }

          const clippedLeft = Math.floor(left);
          const clippedTop = Math.floor(top);
          const clippedRight = Math.ceil(right);
          const clippedBottom = Math.ceil(bottom);

          return {
            x: clippedLeft,
            y: clippedTop,
            width: clippedRight - clippedLeft,
            height: clippedBottom - clippedTop,
          };
        };
        const ignoreRegions: BoundingBox[] = [];
        const ignoreSelectorMatches = selectors.map((selector) => {
          let matchedElementCount = 0;

          for (const element of Array.from(document.querySelectorAll(selector))) {
            if (!isVisible(element)) {
              continue;
            }

            const rect = element.getBoundingClientRect();
            const region = clipBoxToBounds(
              {
                x: rect.left - captureBounds.rootLeft,
                y: rect.top - captureBounds.rootTop,
                width: rect.width,
                height: rect.height,
              },
              captureBounds,
            );

            if (!region) {
              continue;
            }

            ignoreRegions.push(region);
            matchedElementCount += 1;
          }

          return {
            selector,
            matchedElementCount,
          };
        });

        return {
          ignoreRegions,
          ignoreSelectorMatches,
        };
      },
      [...ignoreSelectors],
    );
  } catch (error) {
    throw new AppError(
      `Failed to resolve --ignore-selector within selector capture. ${ensureError(error).message}`,
      {
        code: "preview_ignore_selector_resolution_failed",
        cause: error,
      },
    );
  }
}

async function collectPageIgnoreSelections(
  page: Page,
  ignoreSelectors: readonly string[],
  fullPage: boolean,
): Promise<IgnoreSelectionResult> {
  if (ignoreSelectors.length === 0) {
    return {
      ignoreRegions: [],
      ignoreSelectorMatches: [],
    };
  }

  try {
    return await page.evaluate(
      ({ selectors, fullPageCapture }) => {
        const captureBounds = fullPageCapture
          ? {
              x: 0,
              y: 0,
              width: Math.max(
                document.documentElement.scrollWidth,
                document.body?.scrollWidth ?? 0,
                window.innerWidth,
              ),
              height: Math.max(
                document.documentElement.scrollHeight,
                document.body?.scrollHeight ?? 0,
                window.innerHeight,
              ),
            }
          : {
              x: 0,
              y: 0,
              width: window.innerWidth,
              height: window.innerHeight,
            };
        const isVisible = (element: Element): boolean => {
          const rect = element.getBoundingClientRect();

          if (rect.width <= 0 || rect.height <= 0) {
            return false;
          }

          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };
        const clipBoxToBounds = (
          box: { x: number; y: number; width: number; height: number },
          bounds: { x: number; y: number; width: number; height: number },
        ) => {
          const left = Math.max(bounds.x, box.x);
          const top = Math.max(bounds.y, box.y);
          const right = Math.min(bounds.x + bounds.width, box.x + box.width);
          const bottom = Math.min(bounds.y + bounds.height, box.y + box.height);

          if (right <= left || bottom <= top) {
            return null;
          }

          const clippedLeft = Math.floor(left);
          const clippedTop = Math.floor(top);
          const clippedRight = Math.ceil(right);
          const clippedBottom = Math.ceil(bottom);

          return {
            x: clippedLeft,
            y: clippedTop,
            width: clippedRight - clippedLeft,
            height: clippedBottom - clippedTop,
          };
        };
        const ignoreRegions: BoundingBox[] = [];
        const ignoreSelectorMatches = selectors.map((selector) => {
          let matchedElementCount = 0;

          for (const element of Array.from(document.querySelectorAll(selector))) {
            if (!isVisible(element)) {
              continue;
            }

            const rect = element.getBoundingClientRect();
            const region = clipBoxToBounds(
              {
                x: fullPageCapture ? rect.left + window.scrollX : rect.left,
                y: fullPageCapture ? rect.top + window.scrollY : rect.top,
                width: rect.width,
                height: rect.height,
              },
              captureBounds,
            );

            if (!region) {
              continue;
            }

            ignoreRegions.push(region);
            matchedElementCount += 1;
          }

          return {
            selector,
            matchedElementCount,
          };
        });

        return {
          ignoreRegions,
          ignoreSelectorMatches,
        };
      },
      {
        selectors: [...ignoreSelectors],
        fullPageCapture: fullPage,
      },
    );
  } catch (error) {
    throw new AppError(
      `Failed to resolve --ignore-selector on the preview page. ${ensureError(error).message}`,
      {
        code: "preview_ignore_selector_resolution_failed",
        cause: error,
      },
    );
  }
}

async function collectSelectorDomSnapshot(locator: Locator): Promise<DomSnapshot> {
  return collectDomSnapshotForLocator(locator, {
    captureMode: "selector",
    fullPageCapture: false,
  });
}

async function collectPageDomSnapshot(page: Page, fullPage: boolean): Promise<DomSnapshot> {
  return collectDomSnapshotForLocator(page.locator("body").first(), {
    captureMode: "page",
    fullPageCapture: fullPage,
  });
}

async function collectDomSnapshotForLocator(
  locator: Locator,
  params: {
    captureMode: "selector" | "page";
    fullPageCapture: boolean;
  },
): Promise<DomSnapshot> {
  return locator.evaluate(
    (root, { captureMode, fullPageCapture, maxSelectorLength, maxTextLength }): DomSnapshot => {
      const excludedTags = new Set(["script", "style", "noscript", "meta", "link", "head"]);
      const inlineNoiseTags = new Set(["span", "strong", "em", "b", "i", "u", "small"]);
      const semanticTags = new Set([
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "button",
        "a",
        "img",
        "svg",
        "video",
        "canvas",
        "input",
        "textarea",
        "select",
        "label",
        "li",
        "section",
        "article",
        "nav",
        "main",
        "aside",
        "header",
        "footer",
      ]);
      const interactiveTags = new Set([
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "option",
        "summary",
      ]);
      const interactiveRoles = new Set([
        "button",
        "link",
        "tab",
        "checkbox",
        "radio",
        "switch",
        "menuitem",
        "option",
        "textbox",
      ]);
      const rootRect = root.getBoundingClientRect();
      const captureBounds =
        captureMode === "page"
          ? fullPageCapture
            ? {
                x: 0,
                y: 0,
                width: Math.max(
                  document.documentElement.scrollWidth,
                  document.body?.scrollWidth ?? 0,
                  window.innerWidth,
                ),
                height: Math.max(
                  document.documentElement.scrollHeight,
                  document.body?.scrollHeight ?? 0,
                  window.innerHeight,
                ),
              }
            : {
                x: 0,
                y: 0,
                width: window.innerWidth,
                height: window.innerHeight,
              }
          : {
              x: 0,
              y: 0,
              width: Math.max(1, Math.round(rootRect.width)),
              height: Math.max(1, Math.round(rootRect.height)),
            };

      const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
      const clipValue = (value: string, limit: number): string =>
        value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}\u2026`;
      const toTag = (element: Element): string => element.tagName.toLowerCase();
      const escapeIdentifier = (value: string): string =>
        typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value;
      const isTransparent = (value: string): boolean =>
        value === "transparent" || value === "rgba(0, 0, 0, 0)" || value === "rgba(0,0,0,0)";
      const extractTestId = (element: Element): string | null =>
        element.getAttribute("data-testid") ||
        element.getAttribute("data-test") ||
        element.getAttribute("data-qa") ||
        null;
      const classSummaryFor = (element: Element): string[] =>
        Array.from(element.classList)
          .filter((className) => /^[A-Za-z_][\w-]*$/u.test(className))
          .slice(0, 3);
      const directTextSnippet = (element: Element): string => {
        const text =
          element instanceof HTMLElement
            ? element.innerText || element.textContent || ""
            : element.textContent || "";
        return clipValue(normalizeWhitespace(text), maxTextLength);
      };
      const hasVisibleBorder = (style: CSSStyleDeclaration): boolean =>
        Number.parseFloat(style.borderTopWidth) > 0 ||
        Number.parseFloat(style.borderRightWidth) > 0 ||
        Number.parseFloat(style.borderBottomWidth) > 0 ||
        Number.parseFloat(style.borderLeftWidth) > 0;
      const hasPaintedBox = (style: CSSStyleDeclaration): boolean =>
        style.backgroundImage !== "none" ||
        !isTransparent(style.backgroundColor) ||
        hasVisibleBorder(style) ||
        style.boxShadow !== "none";
      const nthOfType = (element: Element): number => {
        let index = 1;
        let sibling = element.previousElementSibling;

        while (sibling) {
          if (sibling.tagName === element.tagName) {
            index += 1;
          }

          sibling = sibling.previousElementSibling;
        }

        return index;
      };
      const segmentFor = (element: Element): string => {
        const tag = toTag(element);

        if (element.id) {
          return `${tag}#${escapeIdentifier(element.id)}`;
        }

        const classSummary = classSummaryFor(element);

        if (classSummary.length > 0) {
          return `${tag}.${classSummary.map((className) => escapeIdentifier(className)).join(".")}`;
        }

        return `${tag}:nth-of-type(${nthOfType(element)})`;
      };
      const buildSelector = (element: Element): string => {
        if (element === root) {
          return clipValue(segmentFor(element), maxSelectorLength);
        }

        const parts: string[] = [];
        let current: Element | null = element;

        while (current && parts.length < 3) {
          parts.unshift(segmentFor(current));

          if (current === root) {
            break;
          }

          current = current.parentElement;
        }

        return clipValue(parts.join(" > "), maxSelectorLength);
      };
      const clipBoxToBounds = (
        box: { x: number; y: number; width: number; height: number },
        bounds: { x: number; y: number; width: number; height: number },
      ) => {
        const left = Math.max(bounds.x, box.x);
        const top = Math.max(bounds.y, box.y);
        const right = Math.min(bounds.x + bounds.width, box.x + box.width);
        const bottom = Math.min(bounds.y + bounds.height, box.y + box.height);

        if (right <= left || bottom <= top) {
          return null;
        }

        return {
          x: Math.round(left),
          y: Math.round(top),
          width: Math.round(right - left),
          height: Math.round(bottom - top),
        };
      };
      const clippedEdgesForBox = (
        box: { x: number; y: number; width: number; height: number },
        bounds: { x: number; y: number; width: number; height: number },
      ): Array<"top" | "right" | "bottom" | "left"> => {
        const edges: Array<"top" | "right" | "bottom" | "left"> = [];

        if (box.y < bounds.y) {
          edges.push("top");
        }

        if (box.x + box.width > bounds.x + bounds.width) {
          edges.push("right");
        }

        if (box.y + box.height > bounds.y + bounds.height) {
          edges.push("bottom");
        }

        if (box.x < bounds.x) {
          edges.push("left");
        }

        return edges;
      };
      const buildRawBox = (element: Element) => {
        const rect = element.getBoundingClientRect();

        if (captureMode === "selector") {
          return {
            x: rect.left - rootRect.left,
            y: rect.top - rootRect.top,
            width: rect.width,
            height: rect.height,
          };
        }

        return {
          x: fullPageCapture ? rect.left + window.scrollX : rect.left,
          y: fullPageCapture ? rect.top + window.scrollY : rect.top,
          width: rect.width,
          height: rect.height,
        };
      };
      const toRelativeBox = (element: Element) => {
        const rawBox = buildRawBox(element);
        const bbox = clipBoxToBounds(rawBox, captureBounds);

        if (!bbox) {
          return null;
        }

        return {
          bbox,
          captureClippedEdges: clippedEdgesForBox(rawBox, captureBounds),
        };
      };
      const depthFromRoot = (element: Element): number => {
        let depth = 0;
        let current: Element | null = element;

        while (current && current !== root) {
          depth += 1;
          current = current.parentElement;
        }

        return depth;
      };
      const buildLocator = (element: Element) => ({
        tag: toTag(element),
        selector: buildSelector(element),
        role: element.getAttribute("role"),
        testId: extractTestId(element),
        domId: element.id || null,
        classSummary: classSummaryFor(element),
      });
      const buildAncestry = (element: Element) => {
        const ancestry: Array<ReturnType<typeof buildLocator>> = [];
        let current = element.parentElement;

        while (current && current !== root && ancestry.length < 4) {
          ancestry.push(buildLocator(current));
          current = current.parentElement;
        }

        if (current === root && ancestry.length < 4) {
          ancestry.push(buildLocator(root));
        }

        return ancestry;
      };
      const isVisibleForSnapshot = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        const style = window.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0
        );
      };
      const isMeaningfulAnchor = (element: Element): boolean => {
        if (element === root || !isVisibleForSnapshot(element)) {
          return false;
        }

        const tag = toTag(element);

        if (excludedTags.has(tag) || inlineNoiseTags.has(tag)) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const hasText = directTextSnippet(element).length > 0;
        const hasRole = Boolean(element.getAttribute("role"));

        return (
          hasText ||
          hasRole ||
          semanticTags.has(tag) ||
          hasPaintedBox(style) ||
          element.children.length === 0
        );
      };
      const hasTextLayoutEvidence = (element: Element): boolean =>
        element instanceof HTMLElement &&
        (element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1);
      const findNearestAnchor = (element: Element, anchors: Set<Element>): Element | null => {
        let current: Element | null = element;

        while (current) {
          if (anchors.has(current)) {
            return current;
          }

          if (current === root) {
            break;
          }

          current = current.parentElement;
        }

        return null;
      };
      const computeLineCount = (element: Element, hasText: boolean): number => {
        if (!hasText) {
          return 0;
        }

        try {
          const range = document.createRange();
          range.selectNodeContents(element);
          const positions: number[] = [];

          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width <= 0 || rect.height <= 0) {
              continue;
            }

            const position = Math.round((rect.top + rect.bottom) / 2);

            if (!positions.some((value) => Math.abs(value - position) <= 1)) {
              positions.push(position);
            }
          }

          return positions.length > 0 ? positions.length : 1;
        } catch {
          return 1;
        }
      };
      const semanticTagForElement = (element: Element): string | null => {
        let current: Element | null = element;

        while (current) {
          const tag = toTag(current);

          if (semanticTags.has(tag)) {
            return tag;
          }

          if (current === root) {
            break;
          }

          current = current.parentElement;
        }

        return null;
      };
      const buildOverlapHints = (
        element: Element,
        captureClippedEdges: Array<"top" | "right" | "bottom" | "left">,
      ) => {
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        if (
          centerX < 0 ||
          centerY < 0 ||
          centerX > window.innerWidth ||
          centerY > window.innerHeight
        ) {
          return {
            topMostAtCenter: null,
            stackDepthAtCenter: 0,
            occludingSelector: null,
            captureClippedEdges,
          };
        }

        const stack = Array.from(document.elementsFromPoint(centerX, centerY));
        const topMostAtCenter = stack[0] ? buildSelector(stack[0]) : null;
        const occludingElement =
          stack.find((candidate) => candidate !== element && !element.contains(candidate)) ?? null;

        return {
          topMostAtCenter,
          stackDepthAtCenter: stack.length,
          occludingSelector: occludingElement ? buildSelector(occludingElement) : null,
          captureClippedEdges,
        };
      };
      const buildSnapshotElement = (
        element: Element,
        candidateKind: "anchor" | "inline-descendant" | "leaf-proxy",
        anchorElementId: string,
      ) => {
        const boxInfo = toRelativeBox(element);

        if (!boxInfo) {
          return null;
        }

        const style = window.getComputedStyle(element);
        const textSnippet = directTextSnippet(element);
        const hasText = textSnippet.length > 0;
        const textMetrics =
          element instanceof HTMLElement
            ? {
                clientWidth: Math.round(element.clientWidth),
                clientHeight: Math.round(element.clientHeight),
                scrollWidth: Math.round(element.scrollWidth),
                scrollHeight: Math.round(element.scrollHeight),
                overflowX: style.overflowX,
                overflowY: style.overflowY,
                textOverflow: style.textOverflow,
                whiteSpace: style.whiteSpace,
                lineClamp:
                  style.getPropertyValue("-webkit-line-clamp") ||
                  style.getPropertyValue("line-clamp") ||
                  null,
              }
            : null;
        const overflowsX = Boolean(
          textMetrics && textMetrics.scrollWidth > textMetrics.clientWidth + 1,
        );
        const overflowsY = Boolean(
          textMetrics && textMetrics.scrollHeight > textMetrics.clientHeight + 1,
        );
        const lineClamp = textMetrics?.lineClamp ?? null;
        const lineClampActive =
          lineClamp !== null &&
          lineClamp !== "" &&
          lineClamp !== "none" &&
          lineClamp !== "0" &&
          lineClamp !== "normal";
        const lineCount = computeLineCount(element, hasText);
        const wrapState: "clamped" | "overflowing" | "wrapped" | "single-line" | "unknown" =
          !hasText
            ? "unknown"
            : lineClampActive
              ? "clamped"
              : overflowsX || overflowsY
                ? "overflowing"
                : lineCount > 1 && style.whiteSpace !== "nowrap" && style.whiteSpace !== "pre"
                  ? "wrapped"
                  : lineCount <= 1
                    ? "single-line"
                    : "unknown";
        const disabled =
          element instanceof HTMLButtonElement ||
          element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLOptionElement
            ? element.disabled
            : null;
        const tabIndex = element instanceof HTMLElement ? element.tabIndex : null;
        const role = element.getAttribute("role");
        const tag = toTag(element);

        return {
          id: buildSelector(element),
          tag,
          selector: buildSelector(element),
          role,
          testId: extractTestId(element),
          domId: element.id || null,
          classSummary: classSummaryFor(element),
          textSnippet: textSnippet || null,
          bbox: boxInfo.bbox,
          depth: depthFromRoot(element),
          captureClippedEdges: boxInfo.captureClippedEdges,
          textMetrics,
          ancestry: buildAncestry(element),
          locator: buildLocator(element),
          identity: {
            domId: element.id || null,
            classSummary: classSummaryFor(element),
            testId: extractTestId(element),
            semanticTag: semanticTagForElement(element),
            candidateKind,
          },
          computedStyle: {
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            fontWeight: style.fontWeight,
            color: style.color,
            backgroundColor: style.backgroundColor,
            borderRadius: style.borderRadius,
            gap: style.gap,
            padding: style.padding,
            width: style.width,
            height: style.height,
            margin: style.margin,
          },
          textLayout: !hasText
            ? null
            : {
                lineCount,
                wrapState,
                hasEllipsis: style.textOverflow === "ellipsis",
                lineClamp,
                overflowsX,
                overflowsY,
              },
          visibility: {
            isVisible: isVisibleForSnapshot(element),
            display: style.display,
            visibility: style.visibility,
            opacity: Number.parseFloat(style.opacity || "1"),
            pointerEvents: style.pointerEvents,
            ariaHidden:
              element.getAttribute("aria-hidden") === null
                ? null
                : element.getAttribute("aria-hidden") === "true",
          },
          interactivity: {
            isInteractive:
              (interactiveTags.has(tag) ||
                (role !== null && interactiveRoles.has(role)) ||
                (tabIndex !== null && tabIndex >= 0) ||
                style.cursor === "pointer" ||
                element.hasAttribute("contenteditable")) &&
              disabled !== true &&
              style.pointerEvents !== "none",
            disabled,
            tabIndex,
            cursor: style.cursor,
          },
          overlapHints: buildOverlapHints(element, boxInfo.captureClippedEdges),
          candidateKind,
          anchorElementId,
        };
      };
      const visibleElements = [root, ...Array.from(root.querySelectorAll("*"))].filter(
        (element) => {
          if (element === root) {
            return true;
          }

          const tag = toTag(element);
          return !excludedTags.has(tag) && isVisibleForSnapshot(element);
        },
      );
      const anchorElements = visibleElements.filter((element) => isMeaningfulAnchor(element));
      const anchorSet = new Set<Element>([root, ...anchorElements]);
      const bindingCandidateElements = visibleElements.filter((element) => {
        if (element === root) {
          return true;
        }

        if (anchorSet.has(element)) {
          return true;
        }

        const tag = toTag(element);
        const testId = extractTestId(element);
        const hasText = directTextSnippet(element).length > 0;
        const hasRole = Boolean(element.getAttribute("role"));

        if (inlineNoiseTags.has(tag)) {
          return (
            (hasText || hasRole || Boolean(testId)) &&
            findNearestAnchor(element, anchorSet) !== null
          );
        }

        if (testId) {
          return findNearestAnchor(element, anchorSet) !== null;
        }

        return (
          element.children.length === 0 &&
          (hasText || hasRole || hasTextLayoutEvidence(element)) &&
          findNearestAnchor(element, anchorSet) !== null
        );
      });
      const rootSnapshot = buildSnapshotElement(root, "anchor", buildSelector(root));
      const elementSnapshots = anchorElements
        .map((element) => buildSnapshotElement(element, "anchor", buildSelector(element)))
        .filter((element): element is NonNullable<typeof element> => element !== null);
      const bindingCandidates = bindingCandidateElements
        .map((element) => {
          const anchorElement = anchorSet.has(element)
            ? element
            : findNearestAnchor(element, anchorSet);

          if (!anchorElement) {
            return null;
          }

          return buildSnapshotElement(
            element,
            anchorSet.has(element)
              ? "anchor"
              : inlineNoiseTags.has(toTag(element))
                ? "inline-descendant"
                : "leaf-proxy",
            buildSelector(anchorElement),
          );
        })
        .filter((element): element is NonNullable<typeof element> => element !== null);

      if (!rootSnapshot) {
        throw new Error(
          captureMode === "selector"
            ? "No DOM context could be collected inside the selector capture."
            : "No DOM context could be collected for the page capture.",
        );
      }

      if (elementSnapshots.length === 0 && bindingCandidates.length === 0) {
        throw new Error(
          captureMode === "selector"
            ? "No meaningful DOM elements were found inside the selector capture."
            : "No meaningful DOM elements were found in the page capture.",
        );
      }

      return {
        root: rootSnapshot,
        elements: elementSnapshots,
        bindingCandidates,
      };
    },
    {
      captureMode: params.captureMode,
      fullPageCapture: params.fullPageCapture,
      maxSelectorLength: DEFAULT_MAX_SELECTOR_LENGTH,
      maxTextLength: DEFAULT_MAX_TEXT_SNIPPET_LENGTH,
    },
  );
}

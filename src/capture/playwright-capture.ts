import { unlink } from "node:fs/promises";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import {
  DEFAULT_CAPTURE_DELAY_MS,
  DEFAULT_FONT_READY_TIMEOUT_MS,
  DEFAULT_MAX_SELECTOR_LENGTH,
  DEFAULT_MAX_TEXT_SNIPPET_LENGTH,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
} from "../config/defaults.js";
import type { DomSnapshot, ParsedPreviewInput, PreparedPreviewImage } from "../types/internal.js";
import { AppError, ensureError } from "../utils/errors.js";
import { normalizeImageToPng } from "../io/image.js";

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
  const browser = await chromium.launch({ headless: true });
  let domSnapshot: DomSnapshot | null;

  try {
    const page = await browser.newPage({
      viewport: preview.viewport,
      deviceScaleFactor: 1,
    });

    await navigateForCapture(page, preview.resolved);
    await waitForCaptureStability(page);

    if (preview.selector !== null) {
      domSnapshot = await captureSelectorScreenshot(page, preview.selector, temporaryCapturePath);
    } else {
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
  } finally {
    await browser.close();
  }

  try {
    const normalized = await normalizeImageToPng(temporaryCapturePath, outputPath);
    return {
      ...normalized,
      analysisMode: "dom-elements",
      domSnapshot,
    };
  } catch (error) {
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

async function captureSelectorScreenshot(
  page: Page,
  selector: string,
  outputPath: string,
): Promise<DomSnapshot> {
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
    await locator.scrollIntoViewIfNeeded();
    const domSnapshot = await collectSelectorDomSnapshot(locator);
    await locator.screenshot({
      path: outputPath,
      animations: "disabled",
      caret: "hide",
      scale: "css",
      type: "png",
    });
    return domSnapshot;
  } catch (error) {
    throw new AppError(
      `Preview selector could not be captured: ${selector}. ${ensureError(error).message}`,
      {
        exitCode: 3,
        recommendation: "needs_human_review",
        severity: "high",
        code: "preview_selector_capture_failed",
        cause: error,
      },
    );
  }
}

function buildTemporaryCapturePath(outputPath: string): string {
  const parsedPath = path.parse(outputPath);
  return path.join(
    parsedPath.dir,
    `${parsedPath.name}.capture-${process.pid}-${Date.now()}${parsedPath.ext || ".png"}`,
  );
}

async function collectSelectorDomSnapshot(locator: Locator): Promise<DomSnapshot> {
  return locator.evaluate(
    (root, { maxSelectorLength, maxTextLength }) => {
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
      const rootRect = root.getBoundingClientRect();
      const captureBounds = {
        x: 0,
        y: 0,
        width: Math.max(1, Math.round(rootRect.width)),
        height: Math.max(1, Math.round(rootRect.height)),
      };

      const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
      const clipValue = (value: string, limit: number): string =>
        value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}\u2026`;
      const toTag = (element: Element): string => element.tagName.toLowerCase();
      const isTransparent = (value: string): boolean =>
        value === "transparent" || value === "rgba(0, 0, 0, 0)" || value === "rgba(0,0,0,0)";
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
      const escapeIdentifier = (value: string): string =>
        typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value;
      const directTextSnippet = (element: Element): string => {
        const text =
          element instanceof HTMLElement
            ? element.innerText || element.textContent || ""
            : element.textContent || "";
        return clipValue(normalizeWhitespace(text), maxTextLength);
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

        const classNames = Array.from(element.classList)
          .filter((className) => /^[A-Za-z_][\w-]*$/u.test(className))
          .slice(0, 2);

        if (classNames.length > 0) {
          return `${tag}.${classNames.map((className) => escapeIdentifier(className)).join(".")}`;
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
      const toRelativeBox = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const rawBox = {
          x: rect.left - rootRect.left,
          y: rect.top - rootRect.top,
          width: rect.width,
          height: rect.height,
        };
        const bbox = clipBoxToBounds(rawBox, captureBounds);

        if (!bbox) {
          return null;
        }

        return {
          bbox,
          captureClippedEdges: clippedEdgesForBox(rawBox, captureBounds),
        };
      };
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        const style = window.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          style.pointerEvents !== "none"
        );
      };
      const isMeaningful = (element: Element): boolean => {
        if (element === root) {
          return true;
        }

        const tag = toTag(element);

        if (excludedTags.has(tag) || inlineNoiseTags.has(tag)) {
          return false;
        }

        if (!isVisible(element)) {
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
      const buildSnapshotElement = (element: Element) => {
        const boxInfo = toRelativeBox(element);

        if (!boxInfo) {
          return null;
        }

        const style = window.getComputedStyle(element);
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

        return {
          id: buildSelector(element),
          tag: toTag(element),
          selector: buildSelector(element),
          role: element.getAttribute("role"),
          textSnippet: directTextSnippet(element) || null,
          bbox: boxInfo.bbox,
          depth: depthFromRoot(element),
          captureClippedEdges: boxInfo.captureClippedEdges,
          textMetrics,
        };
      };
      const allElements = [root, ...Array.from(root.querySelectorAll("*"))]
        .filter((element) => isMeaningful(element))
        .map((element) => buildSnapshotElement(element))
        .filter((element): element is NonNullable<typeof element> => element !== null);
      const [snapshotRoot, ...elements] = allElements;

      if (!snapshotRoot) {
        throw new Error("No meaningful DOM elements were found inside the selector capture.");
      }

      return {
        root: snapshotRoot,
        elements,
      };
    },
    {
      maxSelectorLength: DEFAULT_MAX_SELECTOR_LENGTH,
      maxTextLength: DEFAULT_MAX_TEXT_SNIPPET_LENGTH,
    },
  );
}

async function collectPageDomSnapshot(page: Page, fullPage: boolean): Promise<DomSnapshot> {
  return page.evaluate(
    ({ fullPageCapture, maxSelectorLength, maxTextLength }) => {
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
      const root = document.body ?? document.documentElement;
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

      const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
      const clipValue = (value: string, limit: number): string =>
        value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}\u2026`;
      const toTag = (element: Element): string => element.tagName.toLowerCase();
      const isTransparent = (value: string): boolean =>
        value === "transparent" || value === "rgba(0, 0, 0, 0)" || value === "rgba(0,0,0,0)";
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
      const escapeIdentifier = (value: string): string =>
        typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value;
      const directTextSnippet = (element: Element): string => {
        const text =
          element instanceof HTMLElement
            ? element.innerText || element.textContent || ""
            : element.textContent || "";
        return clipValue(normalizeWhitespace(text), maxTextLength);
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

        const classNames = Array.from(element.classList)
          .filter((className) => /^[A-Za-z_][\w-]*$/u.test(className))
          .slice(0, 2);

        if (classNames.length > 0) {
          return `${tag}.${classNames.map((className) => escapeIdentifier(className)).join(".")}`;
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
      const toRelativeBox = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const x = fullPageCapture ? rect.left + window.scrollX : rect.left;
        const y = fullPageCapture ? rect.top + window.scrollY : rect.top;
        const rawBox = {
          x,
          y,
          width: rect.width,
          height: rect.height,
        };
        const bbox = clipBoxToBounds(rawBox, captureBounds);

        if (!bbox) {
          return null;
        }

        return {
          bbox,
          captureClippedEdges: clippedEdgesForBox(rawBox, captureBounds),
        };
      };
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        const style = window.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          style.pointerEvents !== "none"
        );
      };
      const isMeaningful = (element: Element): boolean => {
        if (element === root) {
          return true;
        }

        const tag = toTag(element);

        if (excludedTags.has(tag) || inlineNoiseTags.has(tag)) {
          return false;
        }

        if (!isVisible(element)) {
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
      const buildSnapshotElement = (element: Element) => {
        const boxInfo = toRelativeBox(element);

        if (!boxInfo) {
          return null;
        }

        const style = window.getComputedStyle(element);
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

        return {
          id: buildSelector(element),
          tag: toTag(element),
          selector: buildSelector(element),
          role: element.getAttribute("role"),
          textSnippet: directTextSnippet(element) || null,
          bbox: boxInfo.bbox,
          depth: depthFromRoot(element),
          captureClippedEdges: boxInfo.captureClippedEdges,
          textMetrics,
        };
      };
      const allElements = [root, ...Array.from(root.querySelectorAll("*"))]
        .filter((element) => isMeaningful(element))
        .map((element) => buildSnapshotElement(element))
        .filter((element): element is NonNullable<typeof element> => element !== null);
      const [snapshotRoot, ...elements] = allElements;

      if (!snapshotRoot) {
        throw new Error("No meaningful DOM elements were found in the page capture.");
      }

      return {
        root: snapshotRoot,
        elements,
      };
    },
    {
      fullPageCapture: fullPage,
      maxSelectorLength: DEFAULT_MAX_SELECTOR_LENGTH,
      maxTextLength: DEFAULT_MAX_TEXT_SNIPPET_LENGTH,
    },
  );
}

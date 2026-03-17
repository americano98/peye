import path from "node:path";
import type { ParsedPreviewInput, ParsedReferenceInput } from "../types/internal.js";
import type {
  CompareCommandOptions,
  InputSourceReport,
  ReferenceInputSourceReport,
  Viewport,
} from "../types/report.js";
import { AppError } from "../utils/errors.js";
import { hashToSelector, isFigmaUrl, isHttpUrl, parseFigmaUrl } from "../utils/url.js";
import { parseViewport } from "../utils/viewport.js";
import { ensureFileExists } from "./fs.js";

export async function parsePreviewInput(
  options: CompareCommandOptions,
): Promise<ParsedPreviewInput> {
  const selector = hashToSelector(options.preview, options.selector);

  if (isHttpUrl(options.preview)) {
    if (!options.viewport) {
      throw new AppError(
        "Preview URL requires --viewport so the browser screenshot is deterministic.",
        {
          code: "preview_viewport_required",
        },
      );
    }

    const viewport = parseViewport(options.viewport);

    if (options.fullPage && selector) {
      throw new AppError(
        "--full-page cannot be used together with --selector or a preview URL hash fragment.",
        {
          code: "preview_full_page_selector_conflict",
        },
      );
    }

    return {
      kind: "url",
      input: options.preview,
      resolved: new URL(options.preview).toString(),
      selector,
      viewport,
    };
  }

  if (options.selector) {
    throw new AppError("--selector can only be used when --preview is a URL.", {
      code: "preview_selector_requires_url",
    });
  }

  if (options.fullPage) {
    throw new AppError("--full-page can only be used when --preview is a URL.", {
      code: "preview_full_page_requires_url",
    });
  }

  const resolvedPath = await ensureFileExists(options.preview);
  const viewport = options.viewport ? parseViewport(options.viewport) : null;

  return {
    kind: "path",
    input: options.preview,
    resolved: resolvedPath,
    selector: null,
    viewport,
  };
}

export async function parseReferenceInput(reference: string): Promise<ParsedReferenceInput> {
  if (isHttpUrl(reference)) {
    const parsedFigmaUrl = parseFigmaUrl(reference);

    return {
      kind: "figma-url",
      input: reference,
      resolved: parsedFigmaUrl.resolved,
      fileKey: parsedFigmaUrl.fileKey,
      nodeId: parsedFigmaUrl.nodeId,
    };
  }

  const resolvedPath = await ensureFileExists(reference);

  return {
    kind: "path",
    input: reference,
    resolved: resolvedPath,
  };
}

export function resolveViewportForReport(
  previewViewport: Viewport | null,
  imageDimensions: { width: number; height: number },
): Viewport {
  return previewViewport ?? { width: imageDimensions.width, height: imageDimensions.height };
}

export function inferPreviewInputSource(
  options: Pick<CompareCommandOptions, "preview" | "selector">,
): InputSourceReport {
  if (isHttpUrl(options.preview)) {
    return {
      input: options.preview,
      kind: "url",
      resolved: new URL(options.preview).toString(),
      selector: hashToSelector(options.preview, options.selector),
    };
  }

  return {
    input: options.preview,
    kind: "path",
    resolved: path.resolve(options.preview),
    selector: null,
  };
}

export function inferReferenceInputSource(reference: string): ReferenceInputSourceReport {
  if (isHttpUrl(reference)) {
    return {
      input: reference,
      kind: isFigmaUrl(reference) ? "figma-url" : "url",
      resolved: new URL(reference).toString(),
      selector: null,
      transport: null,
    };
  }

  return {
    input: reference,
    kind: "path",
    resolved: path.resolve(reference),
    selector: null,
    transport: "path",
  };
}

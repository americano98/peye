import { AppError } from "./errors.js";

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isHttpUrl(value: string): boolean {
  const url = parseUrl(value);
  return url?.protocol === "http:" || url?.protocol === "https:";
}

export function isFigmaUrl(value: string): boolean {
  const url = parseUrl(value);

  if (!url) {
    return false;
  }

  return url.hostname === "figma.com" || url.hostname.endsWith(".figma.com");
}

export function hashToSelector(input: string, explicitSelector?: string): string | null {
  if (explicitSelector) {
    return explicitSelector;
  }

  if (!isHttpUrl(input)) {
    return null;
  }

  const url = new URL(input);
  const hash = url.hash.replace(/^#/, "");

  if (!hash) {
    return null;
  }

  return `#${decodeURIComponent(hash)}`;
}

export interface ParsedFigmaUrl {
  fileKey: string;
  nodeId: string;
  resolved: string;
}

export function normalizeNodeId(value: string): string {
  return decodeURIComponent(value).replace(/-/g, ":");
}

export function parseFigmaUrl(input: string): ParsedFigmaUrl {
  const url = parseUrl(input);

  if (!url) {
    throw new AppError(`Invalid Figma URL: ${input}`, {
      code: "figma_url_invalid",
    });
  }

  if (!isFigmaUrl(input)) {
    throw new AppError(`Reference URL must be a Figma URL or local image path: ${input}`, {
      code: "figma_url_expected",
    });
  }

  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length < 2) {
    throw new AppError(`Could not extract file key from Figma URL: ${input}`, {
      code: "figma_file_key_missing",
    });
  }

  let fileKey: string | undefined;

  if (parts[0] === "design" && parts[2] === "branch") {
    fileKey = parts[3];
  } else if (parts[0] === "design" || parts[0] === "file") {
    fileKey = parts[1];
  } else if (parts[1] === "branch" && parts[2]) {
    fileKey = parts[2];
  }

  if (!fileKey) {
    fileKey = parts[1];
  }

  const nodeId = url.searchParams.get("node-id");

  if (!nodeId) {
    throw new AppError(
      `Figma URL must include a node-id query parameter so the CLI can export the correct frame: ${input}`,
      {
        exitCode: 3,
        recommendation: "needs_human_review",
        severity: "high",
        code: "figma_node_id_missing",
      },
    );
  }

  return {
    fileKey,
    nodeId: normalizeNodeId(nodeId),
    resolved: url.toString(),
  };
}

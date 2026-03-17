import { DEFAULT_FIGMA_API_BASE_URL, DEFAULT_RESOURCE_TIMEOUT_MS } from "../config/defaults.js";
import { bufferToNormalizedPng } from "../io/image.js";
import type { ParsedReferenceInput, PreparedReferenceImage } from "../types/internal.js";
import { AppError, ensureError } from "../utils/errors.js";
import type { ReferenceProvider } from "./provider.js";

interface FigmaImagesResponse {
  err?: string;
  images?: Record<string, string | undefined>;
}

export class FigmaRestReferenceProvider implements ReferenceProvider {
  readonly kind = "figma-url" as const;

  async prepare(
    reference: ParsedReferenceInput,
    outputPath: string,
  ): Promise<PreparedReferenceImage> {
    if (reference.kind !== "figma-url") {
      throw new AppError(`Unsupported reference input kind for Figma provider: ${reference.kind}`, {
        code: "reference_provider_kind_mismatch",
      });
    }

    const token = process.env.FIGMA_TOKEN;

    if (!token) {
      throw new AppError("FIGMA_TOKEN is required when --reference points to a Figma URL.", {
        code: "figma_token_missing",
      });
    }

    const endpoint = new URL(`/v1/images/${reference.fileKey}`, figmaApiBaseUrl());
    endpoint.searchParams.set("ids", reference.nodeId);
    endpoint.searchParams.set("format", "png");
    endpoint.searchParams.set("scale", "1");

    const payload = await fetchFigmaJson<FigmaImagesResponse>(
      endpoint,
      token,
      `Failed to export Figma node image for ${reference.nodeId}.`,
    );
    const imageUrl = payload.images?.[reference.nodeId];

    if (!imageUrl) {
      throw new AppError(`Figma did not return an image URL for node ${reference.nodeId}.`, {
        exitCode: 3,
        recommendation: "needs_human_review",
        severity: "high",
        code: "figma_image_missing",
      });
    }

    const buffer = await fetchBinary(
      imageUrl,
      `Failed to download exported Figma image for ${reference.nodeId}.`,
    );
    const prepared = await bufferToNormalizedPng(buffer, outputPath);

    return {
      ...prepared,
      transport: "figma-rest",
    };
  }
}

function figmaApiBaseUrl(): string {
  return process.env.FIGMA_API_BASE_URL ?? DEFAULT_FIGMA_API_BASE_URL;
}

async function fetchFigmaJson<TPayload>(
  url: URL,
  token: string,
  failureMessage: string,
): Promise<TPayload> {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "X-Figma-Token": token,
      },
    },
    failureMessage,
  );

  try {
    return (await response.json()) as TPayload;
  } catch (error) {
    throw new AppError(`${failureMessage} Invalid JSON response from Figma API.`, {
      code: "figma_response_invalid_json",
      cause: error,
    });
  }
}

async function fetchBinary(url: string, failureMessage: string): Promise<Buffer> {
  const response = await fetchWithTimeout(url, undefined, failureMessage);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchWithTimeout(
  input: URL | string,
  init: RequestInit | undefined,
  failureMessage: string,
): Promise<Response> {
  try {
    const response = await fetch(input, {
      ...init,
      signal: AbortSignal.timeout(DEFAULT_RESOURCE_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new AppError(`${failureMessage} Received ${response.status} ${response.statusText}.`, {
        code: "remote_request_failed",
      });
    }

    return response;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(`${failureMessage} ${ensureError(error).message}`, {
      code: "remote_request_failed",
      cause: error,
    });
  }
}

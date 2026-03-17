import {
  DEFAULT_FIGMA_MCP_DESKTOP_URL,
  DEFAULT_FIGMA_MCP_REMOTE_URL,
  DEFAULT_FIGMA_SOURCE,
} from "../config/defaults.js";
import type { ParsedReferenceInput, PreparedReferenceImage } from "../types/internal.js";
import { AppError, ensureError } from "../utils/errors.js";
import { FigmaMcpReferenceProvider } from "./figma-mcp-reference-provider.js";
import { FigmaRestReferenceProvider } from "./figma-rest-reference-provider.js";
import type { ReferenceProvider } from "./provider.js";

type FigmaSourceMode = "auto" | "mcp" | "rest";

interface AttemptFailure {
  label: string;
  error: AppError;
}

export class FigmaReferenceProvider implements ReferenceProvider {
  readonly kind = "figma-url" as const;

  async prepare(
    reference: ParsedReferenceInput,
    outputPath: string,
  ): Promise<PreparedReferenceImage> {
    const providers = buildProviders();
    const failures: AttemptFailure[] = [];

    for (const provider of providers) {
      try {
        return await provider.instance.prepare(reference, outputPath);
      } catch (error) {
        const appError =
          error instanceof AppError
            ? error
            : new AppError(ensureError(error).message, {
                cause: error,
                code: "figma_reference_attempt_failed",
              });

        failures.push({
          label: provider.label,
          error: appError,
        });
      }
    }

    throw buildFailureFromAttempts(failures);
  }
}

function buildProviders(): Array<{ instance: ReferenceProvider; label: string }> {
  const mode = resolveFigmaSourceMode();
  const desktopProvider = new FigmaMcpReferenceProvider({
    serverUrl: process.env.PEYE_FIGMA_MCP_DESKTOP_URL ?? DEFAULT_FIGMA_MCP_DESKTOP_URL,
    transport: "figma-mcp-desktop",
  });
  const remoteProvider = new FigmaMcpReferenceProvider({
    serverUrl: process.env.PEYE_FIGMA_MCP_REMOTE_URL ?? DEFAULT_FIGMA_MCP_REMOTE_URL,
    transport: "figma-mcp-remote",
  });
  const restProvider = new FigmaRestReferenceProvider();

  if (mode === "rest") {
    return [{ instance: restProvider, label: "Figma REST" }];
  }

  if (mode === "mcp") {
    return [
      { instance: desktopProvider, label: "Figma MCP desktop" },
      { instance: remoteProvider, label: "Figma MCP remote" },
    ];
  }

  return [
    { instance: desktopProvider, label: "Figma MCP desktop" },
    { instance: remoteProvider, label: "Figma MCP remote" },
    { instance: restProvider, label: "Figma REST" },
  ];
}

function resolveFigmaSourceMode(): FigmaSourceMode {
  const mode = process.env.PEYE_FIGMA_SOURCE ?? DEFAULT_FIGMA_SOURCE;

  if (mode === "auto" || mode === "mcp" || mode === "rest") {
    return mode;
  }

  throw new AppError(
    `Invalid PEYE_FIGMA_SOURCE value "${mode}". Expected one of: auto, mcp, rest.`,
    {
      code: "figma_source_invalid",
    },
  );
}

function buildFailureFromAttempts(failures: AttemptFailure[]): AppError {
  if (failures.length === 1) {
    return failures[0].error;
  }

  const preferredError =
    failures.find(
      (failure) =>
        failure.error.code === "figma_mcp_invalid_response" ||
        failure.error.code === "figma_image_missing",
    )?.error ?? failures.at(-1)?.error;

  const nextSteps = [
    "Start the Figma desktop app MCP server.",
    "Run peye in an interactive terminal to authorize remote Figma MCP.",
    "Set FIGMA_TOKEN to enable REST fallback.",
  ];
  const attemptLines = failures.map((failure) => `- ${failure.label}: ${failure.error.message}`);

  return new AppError(
    [
      preferredError?.message ?? "Failed to resolve the Figma reference.",
      "Reference lookup attempts:",
      ...attemptLines,
      "Next steps:",
      ...nextSteps.map((step) => `- ${step}`),
    ].join("\n"),
    {
      exitCode: preferredError?.exitCode ?? 3,
      recommendation: preferredError?.recommendation ?? "needs_human_review",
      severity: preferredError?.severity ?? "high",
      code: preferredError?.code ?? "figma_reference_unavailable",
      cause: preferredError,
    },
  );
}

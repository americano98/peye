import type { ParsedReferenceInput, PreparedReferenceImage } from "../types/internal.js";
import { AppError } from "../utils/errors.js";
import { FigmaReferenceProvider } from "./figma-reference-provider.js";
import { LocalReferenceProvider } from "./local-reference-provider.js";
import type { ReferenceProvider } from "./provider.js";

const providers = new Map<ParsedReferenceInput["kind"], ReferenceProvider>([
  ["figma-url", new FigmaReferenceProvider()],
  ["path", new LocalReferenceProvider()],
]);

export async function materializeReferenceImage(
  reference: ParsedReferenceInput,
  outputPath: string,
): Promise<PreparedReferenceImage> {
  const provider = providers.get(reference.kind);

  if (!provider) {
    throw new AppError(`No reference provider registered for ${reference.kind}.`, {
      code: "reference_provider_missing",
    });
  }

  return provider.prepare(reference, outputPath);
}

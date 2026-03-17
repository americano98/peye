import type { ParsedReferenceInput, PreparedReferenceImage } from "../types/internal.js";
import { normalizeImageToPng } from "../io/image.js";
import { AppError, ensureError } from "../utils/errors.js";
import type { ReferenceProvider } from "./provider.js";

export class LocalReferenceProvider implements ReferenceProvider {
  readonly kind = "path" as const;

  async prepare(
    reference: ParsedReferenceInput,
    outputPath: string,
  ): Promise<PreparedReferenceImage> {
    try {
      const prepared = await normalizeImageToPng(reference.resolved, outputPath);
      return {
        ...prepared,
        transport: "path",
      };
    } catch (error) {
      throw new AppError(
        `Failed to normalize reference image: ${reference.resolved}. ${ensureError(error).message}`,
        {
          code: "reference_image_normalization_failed",
          cause: error,
        },
      );
    }
  }
}

import type { ParsedReferenceInput, PreparedReferenceImage } from "../types/internal.js";

export interface ReferenceProvider {
  readonly kind: ParsedReferenceInput["kind"];
  prepare(reference: ParsedReferenceInput, outputPath: string): Promise<PreparedReferenceImage>;
}

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `${prefix}-`));
}

export async function createPngFromSvg(params: {
  outputPath: string;
  width: number;
  height: number;
  body: string;
}): Promise<void> {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}">
      <rect width="100%" height="100%" fill="#ffffff" />
      ${params.body}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(params.outputPath);
}

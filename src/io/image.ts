import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { NormalizedImageData, PreparedImage } from "../types/internal.js";
import { AppError, ensureError } from "../utils/errors.js";

interface NormalizeImageOptions {
  resizeTo?: {
    width: number;
    height: number;
  };
}

export async function normalizeImageToPng(
  inputPath: string,
  outputPath: string,
): Promise<PreparedImage> {
  return normalizeSourceToPng(inputPath, outputPath, `Failed to normalize image: ${inputPath}`);
}

export async function bufferToNormalizedPng(
  buffer: Buffer,
  outputPath: string,
  options?: NormalizeImageOptions,
): Promise<PreparedImage> {
  return normalizeSourceToPng(
    buffer,
    outputPath,
    "Failed to normalize in-memory image buffer.",
    options,
  );
}

export async function loadNormalizedImage(imagePath: string): Promise<NormalizedImageData> {
  try {
    const { data, info } = await sharp(imagePath)
      .rotate()
      .ensureAlpha()
      .toColorspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    };
  } catch (error) {
    throw new AppError(`Failed to load normalized image data: ${imagePath}`, {
      code: "image_load_failed",
      cause: error,
    });
  }
}

export async function getImageDimensions(
  imagePath: string,
): Promise<{ width: number; height: number }> {
  try {
    const metadata = await sharp(imagePath).metadata();

    if (!metadata.width || !metadata.height) {
      throw new AppError(`Could not read image dimensions for ${imagePath}`, {
        code: "image_dimensions_missing",
      });
    }

    return {
      width: metadata.width,
      height: metadata.height,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(`Failed to read image dimensions: ${imagePath}`, {
      code: "image_dimensions_failed",
      cause: error,
    });
  }
}

export function padImageToCanvas(
  image: NormalizedImageData,
  width: number,
  height: number,
): NormalizedImageData {
  if (image.width === width && image.height === height) {
    return image;
  }

  const target = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < image.height; y += 1) {
    const sourceOffset = y * image.width * 4;
    const targetOffset = y * width * 4;
    target.set(image.data.subarray(sourceOffset, sourceOffset + image.width * 4), targetOffset);
  }

  return {
    width,
    height,
    data: target,
  };
}

export async function writeRawRgbaPng(
  outputPath: string,
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<void> {
  try {
    await sharp(Buffer.from(data), {
      raw: {
        width,
        height,
        channels: 4,
      },
    })
      .png()
      .toFile(outputPath);
  } catch (error) {
    throw new AppError(`Failed to write PNG artifact: ${outputPath}`, {
      code: "artifact_write_failed",
      cause: error,
    });
  }
}

async function normalizeSourceToPng(
  input: string | Buffer,
  outputPath: string,
  errorMessage: string,
  options?: NormalizeImageOptions,
): Promise<PreparedImage> {
  const resolvedOutputPath = path.resolve(outputPath);

  try {
    let pipeline = sharp(input).rotate().ensureAlpha().toColorspace("srgb");

    if (options?.resizeTo) {
      pipeline = pipeline.resize(options.resizeTo.width, options.resizeTo.height, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      });
    }

    const { data, info } = await pipeline.png().toBuffer({ resolveWithObject: true });

    if (!info.width || !info.height) {
      throw new AppError(`Could not read normalized image dimensions for ${resolvedOutputPath}`, {
        code: "image_dimensions_missing",
      });
    }

    await writeFile(resolvedOutputPath, data);

    return {
      path: resolvedOutputPath,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(`${errorMessage}: ${ensureError(error).message}`, {
      code: "image_normalization_failed",
      cause: error,
    });
  }
}

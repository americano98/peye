import { DEFAULT_VIEWPORT_HEIGHT } from "../config/defaults.js";
import type { Viewport } from "../types/report.js";
import { AppError } from "./errors.js";

export function parseViewport(value: string): Viewport {
  const trimmedValue = value.trim();
  const explicitMatch = /^(?<width>\d+)x(?<height>\d+)$/i.exec(trimmedValue);

  if (explicitMatch?.groups) {
    const width = Number(explicitMatch.groups.width);
    const height = Number(explicitMatch.groups.height);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new AppError(
        `Invalid viewport "${value}". Width and height must be positive integers.`,
        {
          code: "viewport_invalid_dimensions",
        },
      );
    }

    return { width, height };
  }

  const widthOnlyMatch = /^(?<width>\d+)$/i.exec(trimmedValue);

  if (widthOnlyMatch?.groups) {
    const width = Number(widthOnlyMatch.groups.width);

    if (!Number.isFinite(width) || width <= 0) {
      throw new AppError(`Invalid viewport "${value}". Width must be a positive integer.`, {
        code: "viewport_invalid_width",
      });
    }

    return {
      width,
      height: DEFAULT_VIEWPORT_HEIGHT,
    };
  }

  throw new AppError(
    `Invalid viewport "${value}". Expected WIDTH or WIDTHxHEIGHT, for example 1920 or 1920x900.`,
    {
      code: "viewport_invalid_format",
    },
  );
}

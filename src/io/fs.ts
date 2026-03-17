import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../utils/errors.js";

interface FilesystemError {
  code?: string;
}

export async function ensureDirectory(dirPath: string): Promise<string> {
  const resolved = path.resolve(dirPath);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

export async function ensureFileExists(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);

  try {
    const fileStat = await stat(resolved);

    if (!fileStat.isFile()) {
      throw new AppError(`Expected a file but received a different path: ${resolved}`);
    }

    return resolved;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    const code = (error as FilesystemError).code;

    if (code === "ENOENT") {
      throw new AppError(`Input file does not exist: ${resolved}`, {
        code: "input_file_missing",
        cause: error,
      });
    }

    if (code === "EACCES") {
      throw new AppError(`Input file is not readable: ${resolved}`, {
        code: "input_file_unreadable",
        cause: error,
      });
    }

    throw new AppError(`Failed to access input file: ${resolved}`, {
      code: "input_file_access_failed",
      cause: error,
    });
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser } from "playwright";
import { AppError, ensureError } from "../utils/errors.js";

const require = createRequire(import.meta.url);
const SUPPORTED_PLAYWRIGHT_BROWSERS = ["chromium"] as const;

export type SupportedPlaywrightBrowser = (typeof SUPPORTED_PLAYWRIGHT_BROWSERS)[number];

export function getSupportedPlaywrightBrowsers(): readonly SupportedPlaywrightBrowser[] {
  return SUPPORTED_PLAYWRIGHT_BROWSERS;
}

export async function launchPlaywrightChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (isMissingPlaywrightBrowserError(error)) {
      throw new AppError(
        'Playwright Chromium is not installed. Run "peye install chromium" and retry.',
        {
          exitCode: 3,
          recommendation: "needs_human_review",
          severity: "high",
          code: "preview_browser_missing",
          cause: error,
        },
      );
    }

    throw error;
  }
}

export async function installPlaywrightBrowser(browser: SupportedPlaywrightBrowser): Promise<void> {
  const cliPath = resolvePlaywrightCliPath();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "install", browser], {
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new AppError(`Failed to install Playwright ${browser}.`, {
          code: "playwright_browser_install_failed",
          cause: new Error(`Playwright install exited with code ${code ?? 1}.`),
        }),
      );
    });
  }).catch((error: unknown) => {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(`Failed to install Playwright ${browser}. ${ensureError(error).message}`, {
      code: "playwright_browser_install_failed",
      cause: error,
    });
  });
}

function resolvePlaywrightCliPath(): string {
  const packageJsonPath = require.resolve("playwright/package.json");
  return path.join(path.dirname(packageJsonPath), "cli.js");
}

function isMissingPlaywrightBrowserError(error: unknown): boolean {
  const message = ensureError(error).message;
  return message.includes("Executable doesn't exist") && message.includes("playwright install");
}

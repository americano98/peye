import type { Command } from "commander";
import {
  getSupportedPlaywrightBrowsers,
  installPlaywrightBrowser,
  type SupportedPlaywrightBrowser,
} from "../capture/playwright-runtime.js";
import { AppError } from "../utils/errors.js";

const DEFAULT_BROWSER: SupportedPlaywrightBrowser = "chromium";

export function registerInstallCommand(program: Command): void {
  program
    .command("install [browser]")
    .description("Install Playwright browser binaries required for preview URL capture.")
    .action(async (browser: string | undefined) => {
      const targetBrowser = normalizeBrowser(browser);
      await installPlaywrightBrowser(targetBrowser);
      console.log(`Installed Playwright ${targetBrowser}.`);
    });
}

function normalizeBrowser(browser: string | undefined): SupportedPlaywrightBrowser {
  const normalized = (browser ?? DEFAULT_BROWSER).trim().toLowerCase();

  if (getSupportedPlaywrightBrowsers().includes(normalized as SupportedPlaywrightBrowser)) {
    return normalized as SupportedPlaywrightBrowser;
  }

  throw new AppError(
    `Unsupported browser "${browser}". Expected one of: ${getSupportedPlaywrightBrowsers().join(", ")}.`,
  );
}

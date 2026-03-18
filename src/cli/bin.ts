import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { registerCompareCommand, handleCliError } from "./compare-command.js";
import { registerInstallCommand } from "./install-command.js";

const program = new Command();

program
  .name("peye")
  .version(packageJson.version)
  .description(
    "Standalone visual diff CLI for comparing preview screenshots against Figma references.",
  )
  .configureHelp({
    sortOptions: true,
    sortSubcommands: true,
  })
  .showHelpAfterError();

registerCompareCommand(program);
registerInstallCommand(program);

program.parseAsync(process.argv).catch(handleCliError);

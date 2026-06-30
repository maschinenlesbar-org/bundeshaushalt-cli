// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { BundeshaushaltClient } from "../client/client.js";
import { parseIntArg, parseBoundedIntArg } from "./shared.js";
import { registerBudgetCommands } from "./commands/budget.js";

/**
 * Sane upper bound for `--max-retries`. A larger value would let a transient
 * 429/503 spin the retry loop (with growing backoff) for effectively forever.
 */
const MAX_RETRIES_LIMIT = 100;

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new BundeshaushaltClient(options),
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("bundeshaushalt")
    .description("CLI for the open German federal budget API (https://bundeshaushalt.de)")
    // The global options genuinely apply after a subcommand, so surface them in
    // every subcommand's --help (as a "Global Options:" section) rather than only
    // on the root, matching the docs' promise that they apply to every command.
    .configureHelp({ showGlobalOptions: true })
    .version(VERSION)
    .option("--base-url <url>", "API base URL", "https://bundeshaushalt.de")
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg, 30_000)
    .option("--user-agent <ua>", "User-Agent header value")
    .option(
      "--max-retries <n>",
      "retries for transient 429/503 responses",
      parseBoundedIntArg(MAX_RETRIES_LIMIT),
      2,
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; 100 MiB)",
      parseIntArg,
      100 * 1024 * 1024,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerBudgetCommands(program, deps);

  return program;
}

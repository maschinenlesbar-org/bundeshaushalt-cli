// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { BundeshaushaltClient } from "../client/client.js";
import { parseIntArg } from "./shared.js";
import { registerBudgetCommands } from "./commands/budget.js";

export const VERSION = "1.0.0";

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
    .version(VERSION)
    .option("--base-url <url>", "API base URL", "https://bundeshaushalt.de")
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value")
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerBudgetCommands(program, deps);

  return program;
}

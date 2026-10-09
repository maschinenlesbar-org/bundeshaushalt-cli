// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import { HaushaltError, HaushaltValidationError, quoteValue } from "../client/errors.js";
import { cleartextProblem, DEFAULT_BASE_URL, isBidiControl, type EngineOptions } from "../client/engine.js";
import { baseUrlProblem, headerValueProblem } from "../client/validate.js";

/**
 * commander value-parser: a non-negative integer in plain decimal notation.
 *
 * Deliberately strict: only `/^\d+$/` is accepted. `Number()` would otherwise
 * coerce empty strings (→0, which silently disables size/retry caps), hex/octal/
 * binary (`0x10`→16), scientific (`1e9`), a leading `+`, and surrounding
 * whitespace — none of which a user typing a "non-negative integer" intends.
 */
export function parseIntArg(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  // Reject values that lose precision: above Number.MAX_SAFE_INTEGER the parsed
  // number no longer round-trips to the digits the user typed, so accepting it
  // would silently honour something other than what was asked for.
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError(
      `Expected a non-negative integer no greater than ${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  return n;
}

/**
 * commander value-parser: a non-negative integer with an inclusive upper bound.
 * Used for options like `--max-retries` where an absurdly large value would turn
 * a transient-error retry loop into an effective hang (DoS).
 */
export function parseBoundedIntArg(max: number): (value: string) => number {
  return (value: string): number => {
    const n = parseIntArg(value);
    if (n > max) {
      throw new InvalidArgumentError(`Expected a non-negative integer <= ${max}.`);
    }
    return n;
  };
}

/**
 * Wrap a value-parser so its option may be given only once: commander keeps the last of a
 * repeated option and drops the others without a word (`--id 14 --id 06` asked for 06 only,
 * `--timeout 5000 --timeout 0` ran without a timeout). A repeat is a usage error naming the
 * flag. A fresh program is built per `run()`, so the state lives as long as one parse.
 */
export function once<T>(flag: string, parse: (value: string) => T): (value: string) => T {
  let seen = false;
  return (value: string) => {
    if (seen) throw new InvalidArgumentError(`${flag} was given more than once; give it once.`);
    seen = true;
    return parse(value);
  };
}

/**
 * commander value-parser for an option with a fixed set of values, the check
 * `Option.choices()` does (and with its message), so it can be combined with `once`.
 */
export function parseChoice(allowed: readonly string[]): (value: string) => string {
  return (value: string) => {
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`Allowed choices are ${allowed.join(", ")}.`);
    }
    return value;
  };
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`):
 * the client's own rule (`headerValueProblem`: not blank, printable Latin-1 plus
 * tab), reported as a usage error before any request.
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * Validate a positional argument against an allowed set (commander does not
 * support .choices() on positional args). Throws a HaushaltValidationError so run()
 * prints a clear message and exits 1.
 */
export function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  argName: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new HaushaltValidationError(`Invalid ${argName} "${quoteValue(value)}". Expected one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/**
 * commander value-parser for `--base-url`: the client's own rule (`baseUrlProblem`:
 * an absolute http(s) URL with a host and no query string or fragment), reported
 * as a usage error naming `--base-url` at parse time, before any request.
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them.
 * It escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is
 * the 8-bit form of CSI) or the bidi formatting characters (isBidiControl), which
 * reorder the text that follows. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a
 * HaushaltError so the CLI prints a clear message instead of "Unexpected error:
 * Maximum call stack size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new HaushaltError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

/**
 * Log one warning (a WARN record of `bundeshaushalt.http`) when the effective base URL is plain `http:` to
 * a host other than loopback (cleartextProblem): requests, and any credentials in the
 * URL, travel unencrypted. Called once per run, after the options are parsed and before
 * the first request; stdout and the exit code are untouched.
 */
export function warnOnCleartext(deps: CliDeps, global: GlobalOptions): void {
  const problem = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
  if (problem !== undefined) logOf(deps).warn("http", problem);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    warnOnCleartext(deps, global);
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

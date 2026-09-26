// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { HaushaltError } from "../client/errors.js";
import { isBidiControl, type EngineOptions } from "../client/engine.js";

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
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`).
 * A blank value is rejected (the engine would otherwise fall back to the default
 * silently), as are a CR/LF (or any other C0 control or DEL) and any character above
 * U+00FF, which Node's HTTP layer cannot send. All are usage errors before any
 * request. Tab and Latin-1 are allowed, as in HTTP. Checked by char code so the
 * source stays free of control bytes.
 */
export function parseHeaderValue(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw new InvalidArgumentError("Value contains control characters.");
    }
    if (c > 0xff) {
      throw new InvalidArgumentError("Value contains characters outside Latin-1 (above U+00FF).");
    }
  }
  return value;
}

/**
 * Validate a positional argument against an allowed set (commander does not
 * support .choices() on positional args). Throws a HaushaltError so run() prints a
 * clear message and exits 1.
 */
export function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  argName: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new HaushaltError(`Invalid ${argName} "${value}". Expected one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/**
 * commander value-parser for `--base-url`: an absolute `http:`/`https:` URL.
 * Rejecting a `file:`/`ftp:` or malformed value here makes it a usage error at
 * parse time; the engine still re-validates the full URL before any request.
 */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError(
      `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`,
    );
  }
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
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

// Input rules of the library, as pure functions. A `Problem` returns the reason a
// value is invalid, or undefined when it is valid; `assertValid` turns a reason
// into a HaushaltValidationError. The client checks its inputs with these before
// any request, and the CLI calls the same functions instead of keeping copies.

import { MIN_YEAR, UNIT_EXAMPLE, UNIT_PREFIX, maxYear, unitOfId, type Unit } from "./enums.js";
import { HaushaltValidationError } from "./errors.js";

/** The reason `value` is invalid (a sentence, e.g. "Expected a non-empty value."), or undefined. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Return `value` when `problem` finds nothing wrong with it; otherwise throw a
 * HaushaltValidationError `Invalid <name>: <reason>`. Inside an async method the
 * throw becomes a rejected promise, before any request is sent.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new HaushaltValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * A budget-number `id`: a non-blank string with no surrounding whitespace (not
 * trimmed silently, which could hide a copy-paste error), and not a bare `G-`/`F-`
 * prefix (any case), which names no element; the live API answers that with a 503
 * that would be retried and read as an outage.
 */
export const idProblem: Problem<unknown> = (id) => {
  if (typeof id !== "string") return `Expected a string (a budget number such as "14" or "G-5"), got ${typeName(id)}.`;
  if (id.trim() === "") return "Expected a non-empty budget number.";
  if (id !== id.trim()) return "Surrounding whitespace is not allowed.";
  if (/^[GF]-$/i.test(id)) {
    const prefix = id.toUpperCase();
    return `Expected a number after the "${prefix}" prefix, e.g. "${prefix}5".`;
  }
  return undefined;
};

/**
 * An `id` together with an explicit `unit`: the id's prefix (`unitOfId`) must name
 * that unit, since the API answers a mismatched pair with a bare 404.
 */
export const idUnitProblem: Problem<{ id: string; unit: Unit }> = ({ id, unit }) => {
  const idUnit = unitOfId(id);
  if (idUnit === unit) return undefined;
  return idUnit === "single"
    ? `Expected an id starting with "${UNIT_PREFIX[unit]}" (e.g. "${UNIT_EXAMPLE[unit]}").`
    : `A "${UNIT_PREFIX[idUnit]}" id belongs to unit ${idUnit}.`;
};

/** A budget `year`: an integer from `MIN_YEAR` (2012) to `maxYear()` (next year). */
export const yearProblem: Problem<unknown> = (year) => {
  const ceiling = maxYear();
  if (typeof year !== "number") return `Expected a number, got ${typeName(year)}.`;
  if (!Number.isSafeInteger(year) || year < MIN_YEAR || year > ceiling) {
    return `Expected a year between ${MIN_YEAR} and ${ceiling}.`;
  }
  return undefined;
};

/** "a string", "a number", "null", "an array" … for a message about a wrong-typed value. */
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * A base URL: an absolute `http:`/`https:` URL with a host and no query string or
 * fragment (the client appends its own path and query), without surrounding
 * whitespace or inner whitespace/control characters (the URL parser would drop or
 * encode them silently). Userinfo is allowed: it is sent as Basic auth, for a mirror
 * behind a login, and redacted in messages; a `%` in it must be an escape (`%25` for
 * a literal one), since it is percent-decoded for the header. The reasons never
 * repeat the value.
 */
export const baseUrlProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string" || value.trim() === "") return "Expected an absolute http(s) URL.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "A base URL cannot contain whitespace or control characters.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
  }
  if (!url.host) return "Expected a URL with a host.";
  if (url.search || url.hash || /[?#]/.test(value)) return "A query string or fragment is not allowed.";
  // The userinfo is percent-decoded for the Authorization header; a "%" that isn't an
  // escape would fail there ("URI malformed") at request time. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * A value for an HTTP header (the User-Agent): not blank, and only printable
 * Latin-1 plus tab. Every other C0 control (CR/LF included), DEL and anything
 * above U+00FF is rejected, wherever it sits: the whole value is scanned, not a
 * trimmed copy, so a CR/LF at either end counts like one inside. Node's HTTP layer
 * could not send these either. Checked by char code so the source stays free of
 * control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string" || value.trim() === "") return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

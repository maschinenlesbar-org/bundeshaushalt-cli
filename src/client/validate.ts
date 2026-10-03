// Input rules of the library, as pure functions. A `Problem` returns the reason a
// value is invalid, or undefined when it is valid; `assertValid` turns a reason
// into a HaushaltValidationError. The client checks its inputs with these before
// any request, and the CLI calls the same functions instead of keeping copies.

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
  if (typeof id !== "string" || id.trim() === "") return "Expected a non-empty budget number.";
  if (id !== id.trim()) return "Surrounding whitespace is not allowed.";
  if (/^[GF]-$/i.test(id)) {
    const prefix = id.toUpperCase();
    return `Expected a number after the "${prefix}" prefix, e.g. "${prefix}5".`;
  }
  return undefined;
};

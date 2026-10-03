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

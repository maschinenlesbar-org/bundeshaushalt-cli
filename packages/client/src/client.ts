// BundeshaushaltClient — a typed client over the open (no-auth) budget-data
// endpoint of the German federal budget portal (https://bundeshaushalt.de).
//
//   client.budgetData({ year: 2024, account: "expenses" })
//   client.budgetData({ year: 2024, account: "expenses", id: "G-5", unit: "group" })

import { RequestEngine, type EngineOptions } from "./engine.js";
import { AccountValues, QuotaValues, UnitValues, unitOfId } from "./enums.js";
import { HaushaltNotFoundError, HaushaltParseError, HaushaltValidationError, quoteValue } from "./errors.js";
import type { QueryParams } from "./query.js";
import type { BudgetData, BudgetParams } from "./types.js";
import { assertKnownKeys, assertValid, idProblem, idUnitProblem, normalizeToken, yearProblem } from "./validate.js";

// NOTE: This is an undocumented, internal endpoint of bundeshaushalt.de (note the
// "internalapi" path segment). It is not a published, stable public API and may
// change shape, rate-limit, or disappear without notice. It is the only route that
// serves this data today; isolate any change here if a public endpoint appears.
const PATH = "/internalapi/budgetData";

export class BundeshaushaltClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options ?? {});
  }

  /**
   * Budget data for a year + account, optionally scoped by quota/unit/id. The
   * params are checked before any request (a HaushaltValidationError, as a rejected
   * promise): `year` an integer from `MIN_YEAR` to `maxYear()`, next year
   * (`yearProblem`), `account`/`quota`/`unit` from their value sets, `id` a token
   * (`idProblem`: not blank, no invisible, control or half character, no "/", not a bare
   * `G-`/`F-` prefix), sent trimmed and in composed Unicode (`normalizeToken`).
   *
   * An id's prefix fixes its grouping (`unitOfId`): without `unit`, a `G-`/`F-` id
   * sends `unit=group`/`unit=function`; a `unit` that contradicts the id is a
   * HaushaltValidationError (`idUnitProblem`), since the API answers a mismatched
   * pair with a bare 404 for an id that exists. See `validateBudgetParams`.
   *
   * An id the API answers with an empty element (HTTP 200, `detail: {}`: an income group on the
   * expenses side, `G-1`, or a zero-padded group, `G-05`) is a HaushaltNotFoundError, as an
   * unknown id answered with a 404 is a HaushaltApiError: never a result without data.
   */
  async budgetData(params: BudgetParams): Promise<BudgetData> {
    const checked = validateBudgetParams(params);
    const query: QueryParams = {
      year: checked.year,
      account: checked.account,
    };
    if (checked.quota !== undefined) query["quota"] = checked.quota;
    if (checked.unit !== undefined) query["unit"] = checked.unit;
    if (checked.id !== undefined) query["id"] = checked.id;
    const request = `GET ${this.engine.describeUrl(PATH, query)}`;
    const data = assertBudgetData(await this.engine.getJson<unknown>(PATH, query), request);
    // The portal answers some ids that name nothing with HTTP 200 and an empty element, not a 404.
    if (checked.id !== undefined && Object.keys(data.detail).length === 0) throw new HaushaltNotFoundError(request, checked.id);
    return data;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check the top-level shape every budgetData response has — an object with `meta`
 * and `detail` objects — so a 2xx `null`, array or other body (the undocumented
 * endpoint changing shape, a broken proxy) is a HaushaltParseError instead of a
 * "successful" result. The record contents are not checked. The error names the request
 * (`GET <url>: …`, userinfo redacted).
 */
function assertBudgetData(body: unknown, request: string): BudgetData {
  if (!isObject(body) || !isObject(body["meta"]) || !isObject(body["detail"])) {
    throw new HaushaltParseError(`${request}: unexpected response shape: expected a JSON object with meta and detail.`);
  }
  return body as unknown as BudgetData;
}

/**
 * Check `budgetData`'s params as it does, before any request, and return them as they are
 * sent: the id trimmed and in composed Unicode, and the unit a `G-`/`F-` id implies filled in
 * when `unit` is omitted. Every rejected
 * value is a HaushaltValidationError; a value of the wrong type is named by its type
 * (`Invalid year "2023": Expected a number, got a string.`).
 */
export function validateBudgetParams(params: BudgetParams): BudgetParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new HaushaltValidationError("Invalid params: expected an object with year and account.");
  }
  // A misspelt key (`Id`, `quota ` from a config file) used to be dropped silently, so the
  // call answered for the whole year instead of the element asked for.
  assertKnownKeys("params", params, BUDGET_PARAM_NAMES);
  assertValid(`year ${shown(params.year)}`, params.year, yearProblem);
  checkEnum("account", params.account, AccountValues);
  if (params.quota !== undefined) checkEnum("quota", params.quota, QuotaValues);
  if (params.unit !== undefined) checkEnum("unit", params.unit, UnitValues);
  if (params.id === undefined) return params;
  // A string's reasons quote it themselves (visibly); a value of another type is named by it.
  assertValid(typeof params.id === "string" ? "id" : `id ${shown(params.id)}`, params.id, idProblem);
  // Sent as a token: trimmed and in composed Unicode.
  const id = normalizeToken(params.id);
  if (params.unit !== undefined) {
    assertValid(`id ${shown(id)} for unit ${params.unit}`, { id, unit: params.unit }, idUnitProblem);
    return { ...params, id };
  }
  const unit = unitOfId(id);
  return unit === "single" ? { ...params, id } : { ...params, id, unit };
}

/** Every BudgetParams key; any other key is a HaushaltValidationError. */
const BUDGET_PARAM_NAMES = ["year", "account", "quota", "unit", "id"] as const satisfies ReadonlyArray<keyof BudgetParams>;

function checkEnum(name: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HaushaltValidationError(`Invalid ${name} ${shown(value)}: expected one of ${allowed.join(", ")}.`);
  }
}

/**
 * A rejected value as a message shows it: a string quoted visibly (`quoteValue`: its userinfo
 * redacted, cut at 50 characters, invisible and control characters escaped), a number as is, anything else by its type — so a wrong-typed
 * value can't look valid (`2023` for the string "2023") and a huge or hostile one isn't
 * echoed whole.
 */
function shown(value: unknown): string {
  if (typeof value === "string") return quoteValue(value, 50);
  if (typeof value === "number") return String(value);
  return `(${value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`})`;
}

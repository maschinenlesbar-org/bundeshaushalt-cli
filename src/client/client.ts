// BundeshaushaltClient — a typed client over the open (no-auth) budget-data
// endpoint of the German federal budget portal (https://bundeshaushalt.de).
//
//   client.budgetData({ year: 2024, account: "expenses" })
//   client.budgetData({ year: 2024, account: "expenses", id: "G-5", unit: "group" })

import { RequestEngine, type EngineOptions } from "./engine.js";
import { AccountValues, QuotaValues, UnitValues, unitOfId } from "./enums.js";
import { HaushaltError, HaushaltParseError } from "./errors.js";
import type { QueryParams } from "./query.js";
import type { BudgetData, BudgetParams } from "./types.js";
import { assertValid, idProblem, idUnitProblem, yearProblem } from "./validate.js";

// NOTE: This is an undocumented, internal endpoint of bundeshaushalt.de (note the
// "internalapi" path segment). It is not a published, stable public API and may
// change shape, rate-limit, or disappear without notice. It is the only route that
// serves this data today; isolate any change here if a public endpoint appears.
const PATH = "/internalapi/budgetData";

export class BundeshaushaltClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Budget data for a year + account, optionally scoped by quota/unit/id. The
   * params are checked before any request (a HaushaltError, as a rejected promise):
   * `year` an integer from `MIN_YEAR` to `maxYear()`, next year (`yearProblem`; a
   * HaushaltValidationError), `account`/`quota`/`unit` from their value sets, `id`
   * non-blank, without surrounding whitespace and not a bare `G-`/`F-` prefix
   * (`idProblem`; a HaushaltValidationError).
   *
   * An id's prefix fixes its grouping (`unitOfId`): without `unit`, a `G-`/`F-` id
   * sends `unit=group`/`unit=function`; a `unit` that contradicts the id is a
   * HaushaltValidationError (`idUnitProblem`), since the API answers a mismatched
   * pair with a bare 404 for an id that exists. See `validateBudgetParams`.
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
    return assertBudgetData(await this.engine.getJson<unknown>(PATH, query));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check the top-level shape every budgetData response has — an object with `meta`
 * and `detail` objects — so a 2xx `null`, array or other body (the undocumented
 * endpoint changing shape, a broken proxy) is a HaushaltParseError instead of a
 * "successful" result. The record contents are not checked.
 */
function assertBudgetData(body: unknown): BudgetData {
  if (!isObject(body) || !isObject(body["meta"]) || !isObject(body["detail"])) {
    throw new HaushaltParseError(
      `Unexpected response shape from ${PATH}: expected a JSON object with meta and detail.`,
    );
  }
  return body as unknown as BudgetData;
}

/**
 * Check `budgetData`'s params as it does, before any request, and return them with
 * the unit a `G-`/`F-` id implies filled in when `unit` is omitted. Throws a
 * HaushaltError (a HaushaltValidationError for the id rules).
 */
export function validateBudgetParams(params: BudgetParams): BudgetParams {
  assertValid(`year ${String(params.year)}`, params.year, yearProblem);
  checkEnum("account", params.account, AccountValues);
  if (params.quota !== undefined) checkEnum("quota", params.quota, QuotaValues);
  if (params.unit !== undefined) checkEnum("unit", params.unit, UnitValues);
  if (params.id === undefined) return params;
  const id = assertValid(`id "${String(params.id)}"`, params.id, idProblem);
  if (params.unit !== undefined) {
    assertValid(`id "${id}" for unit ${params.unit}`, { id, unit: params.unit }, idUnitProblem);
    return params;
  }
  const unit = unitOfId(id);
  return unit === "single" ? params : { ...params, unit };
}

function checkEnum(name: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HaushaltError(
      `Invalid ${name} "${String(value)}": expected one of ${allowed.join(", ")}.`,
    );
  }
}

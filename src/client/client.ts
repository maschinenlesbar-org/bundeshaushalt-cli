// BundeshaushaltClient — a typed client over the open (no-auth) budget-data
// endpoint of the German federal budget portal (https://bundeshaushalt.de).
//
//   client.budgetData({ year: 2024, account: "expenses" })
//   client.budgetData({ year: 2024, account: "expenses", id: "G-5", unit: "group" })

import { RequestEngine, type EngineOptions } from "./engine.js";
import { AccountValues, MIN_YEAR, QuotaValues, UnitValues } from "./enums.js";
import { HaushaltError } from "./errors.js";
import type { QueryParams } from "./query.js";
import type { BudgetData, BudgetParams } from "./types.js";

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
   * `year` an integer from `MIN_YEAR` on, `account`/`quota`/`unit` from their value
   * sets, `id` non-blank. The upper year bound is left to the API (404 for a year it
   * does not have).
   */
  async budgetData(params: BudgetParams): Promise<BudgetData> {
    checkParams(params);
    const query: QueryParams = {
      year: params.year,
      account: params.account,
    };
    if (params.quota !== undefined) query["quota"] = params.quota;
    if (params.unit !== undefined) query["unit"] = params.unit;
    if (params.id !== undefined) query["id"] = params.id;
    return this.engine.getJson(PATH, query);
  }
}

function checkParams(params: BudgetParams): void {
  if (!Number.isSafeInteger(params.year) || params.year < MIN_YEAR) {
    throw new HaushaltError(`Invalid year ${String(params.year)}: expected an integer from ${MIN_YEAR} on.`);
  }
  checkEnum("account", params.account, AccountValues);
  if (params.quota !== undefined) checkEnum("quota", params.quota, QuotaValues);
  if (params.unit !== undefined) checkEnum("unit", params.unit, UnitValues);
  if (params.id !== undefined && (typeof params.id !== "string" || params.id.trim() === "")) {
    throw new HaushaltError(`Invalid id "${String(params.id)}": expected a non-empty budget number.`);
  }
}

function checkEnum(name: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HaushaltError(
      `Invalid ${name} "${String(value)}": expected one of ${allowed.join(", ")}.`,
    );
  }
}

// BundeshaushaltClient — a typed client over the open (no-auth) budget-data
// endpoint of the German federal budget portal (https://bundeshaushalt.de).
//
//   client.budgetData({ year: 2024, account: "expenses" })
//   client.budgetData({ year: 2024, account: "expenses", id: "G-",  unit: "group" })

import { RequestEngine, type EngineOptions } from "./engine.js";
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

  /** Budget data for a year + account, optionally scoped by quota/unit/id. */
  budgetData(params: BudgetParams): Promise<BudgetData> {
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

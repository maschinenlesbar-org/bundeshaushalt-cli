import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, assertEnum, renderJson } from "../shared.js";
import { HaushaltError } from "../../client/errors.js";
import { AccountValues, QuotaValues, UnitValues, MIN_YEAR } from "../../client/enums.js";
import type { Account } from "../../client/enums.js";
import type { BudgetParams } from "../../client/types.js";

/**
 * Upper bound for an accepted year. Derived from the current year (rather than a
 * hard-coded literal) so the validator stays meaningful as years advance. The
 * portal publishes the upcoming year's draft budget, so allow current year + 1.
 */
function maxYear(): number {
  return new Date().getUTCFullYear() + 1;
}

/** Parse + range-check a positional year (a four-digit integer in range). */
function requireYear(value: string): number {
  const ceiling = maxYear();
  // Validate the raw four-digit shape before coercing, so loose inputs like
  // "2024.0" or " 2024 " are rejected rather than silently normalised.
  if (!/^\d{4}$/.test(value)) {
    throw new HaushaltError(
      `Invalid year "${value}". Expected a four-digit year between ${MIN_YEAR} and ${ceiling}.`,
    );
  }
  const n = Number(value);
  if (n < MIN_YEAR || n > ceiling) {
    throw new HaushaltError(
      `Invalid year "${value}". Expected a four-digit year between ${MIN_YEAR} and ${ceiling}.`,
    );
  }
  return n;
}

/** Build the optional quota/unit/id params shared by all budget commands. */
function optionsFrom(opts: Record<string, unknown>): Omit<BudgetParams, "year" | "account"> {
  const params: Omit<BudgetParams, "year" | "account"> = {};
  if (opts["quota"] !== undefined) {
    params.quota = assertEnum(String(opts["quota"]), QuotaValues, "quota");
  }
  if (opts["unit"] !== undefined) {
    params.unit = assertEnum(String(opts["unit"]), UnitValues, "unit");
  }
  if (opts["id"] !== undefined) {
    const id = String(opts["id"]).trim();
    // Reject empty/whitespace ids so bad input fails locally with a clear
    // message instead of producing an opaque API error (or `id=` in the query).
    if (id.length === 0) {
      throw new HaushaltError(`Invalid id "". Expected a non-empty budget number.`);
    }
    params.id = id;
  }
  return params;
}

function addBudgetOptions(cmd: Command): Command {
  return cmd
    .option("--quota <quota>", `target | actual (default target)`)
    .option("--unit <unit>", `single | function | group (default single)`)
    .option("--id <id>", 'budget number id ("G-" prefix for groups, "F-" for functions)');
}

export function registerBudgetCommands(program: Command, deps: CliDeps): void {
  addBudgetOptions(
    program
      .command("budget <year> <account>")
      .description(`Federal budget data (account: ${AccountValues.join(" | ")})`),
  ).action(
    action(deps, async ({ client, global, opts }, [year, account]) => {
      renderJson(
        deps,
        global,
        await client.budgetData({
          year: requireYear(year!),
          account: assertEnum(account!, AccountValues, "account"),
          ...optionsFrom(opts),
        }),
      );
    }),
  );

  // Convenience shortcuts that preset the account.
  const shortcut = (name: string, account: Account, desc: string) => {
    addBudgetOptions(program.command(`${name} <year>`).description(desc)).action(
      action(deps, async ({ client, global, opts }, [year]) => {
        renderJson(
          deps,
          global,
          await client.budgetData({ year: requireYear(year!), account, ...optionsFrom(opts) }),
        );
      }),
    );
  };
  shortcut("expenses", "expenses", "Federal expenses for a year (shortcut)");
  shortcut("income", "income", "Federal income for a year (shortcut)");
}

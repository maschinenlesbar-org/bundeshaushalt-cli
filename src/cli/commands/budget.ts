import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, assertEnum, renderJson } from "../shared.js";
import { HaushaltError } from "../../client/errors.js";
import { AccountValues, QuotaValues, UnitValues, MIN_YEAR } from "../../client/enums.js";
import type { Account } from "../../client/enums.js";
import type { BudgetParams } from "../../client/types.js";

/**
 * Upper bound for an accepted year. Derived from the current year (rather than a
 * hard-coded literal) so the validator stays meaningful as years advance.
 *
 * Capped at the current year: the portal only serves data up to (and including)
 * the current budget year. Allowing current year + 1 turned a predictable
 * client-side rejection into a network round-trip that the API answers with 404.
 */
function maxYear(): number {
  return new Date().getUTCFullYear();
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
    const raw = String(opts["id"]);
    // A value that looks like an option flag (e.g. `--id --quota`) is almost
    // certainly a missing-value mistake: commander otherwise swallows the next
    // flag as the id and sends `id=--quota` to the API. Reject it locally.
    if (raw.startsWith("-")) {
      throw new HaushaltError(
        `Invalid id "${raw}". The --id value looks like an option; did you forget to supply an id?`,
      );
    }
    const id = raw.trim();
    // Reject empty/whitespace ids so bad input fails locally with a clear
    // message instead of producing an opaque API error (or `id=` in the query).
    if (id.length === 0) {
      throw new HaushaltError(`Invalid id "". Expected a non-empty budget number.`);
    }
    // Reject surrounding whitespace rather than silently trimming it: silent
    // mutation can mask copy-paste errors and collapse two distinct inputs.
    if (id !== raw) {
      throw new HaushaltError(`Invalid id "${raw}". Surrounding whitespace is not allowed.`);
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

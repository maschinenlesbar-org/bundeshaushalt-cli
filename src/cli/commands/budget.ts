import type { Command } from "commander";
import { Option } from "commander";
import type { CliDeps } from "../io.js";
import { action, assertEnum, once, parseChoice, renderJson } from "../shared.js";
import { HaushaltValidationError, quoteValue } from "../../client/errors.js";
import { AccountValues, QuotaValues, UnitValues, MIN_YEAR, maxYear } from "../../client/enums.js";
import type { Account, Quota, Unit } from "../../client/enums.js";
import type { BudgetParams } from "../../client/types.js";

/**
 * Parse a positional year: the raw four-digit shape only, so loose inputs like
 * "2024.0" or " 2024 " are rejected rather than silently normalised. The range
 * (MIN_YEAR to next year) is the client's rule (yearProblem), checked before any
 * request.
 */
function requireYear(value: string): number {
  if (!/^\d{4}$/.test(value)) {
    throw new HaushaltValidationError(
      `Invalid year "${quoteValue(value)}". Expected a four-digit year between ${MIN_YEAR} and ${maxYear()}.`,
    );
  }
  return Number(value);
}

/** Build the optional quota/unit/id params shared by all budget commands. */
function optionsFrom(opts: Record<string, unknown>): Omit<BudgetParams, "year" | "account"> {
  const params: Omit<BudgetParams, "year" | "account"> = {};
  // --quota / --unit are validated by commander's .choices() (see
  // addBudgetOptions), so they are already one of the allowed values here.
  if (opts["quota"] !== undefined) params.quota = opts["quota"] as Quota;
  if (opts["unit"] !== undefined) params.unit = opts["unit"] as Unit;
  if (opts["id"] !== undefined) {
    const raw = String(opts["id"]);
    // A value that looks like an option flag (e.g. `--id --quota`) is almost
    // certainly a missing-value mistake: commander otherwise swallows the next
    // flag as the id and sends `id=--quota` to the API. Reject it locally.
    if (raw.startsWith("-")) {
      throw new HaushaltValidationError(
        `Invalid id "${quoteValue(raw)}". The --id value looks like an option; did you forget to supply an id?`,
      );
    }
    // The id rules (its shape, and that its G-/F- prefix fixes --unit, set when
    // omitted) are the client's: budgetData checks them before any request.
    params.id = raw;
  }
  return params;
}

function addBudgetOptions(cmd: Command): Command {
  return cmd
    .addOption(
      // choices() for the help text; the parser repeats its check and rejects a repeat.
      new Option("--quota <quota>", "planned vs realised (default target)")
        .choices([...QuotaValues])
        .argParser(once("--quota", parseChoice(QuotaValues))),
    )
    .addOption(
      new Option("--unit <unit>", "how elements are grouped (default single)")
        .choices([...UnitValues])
        .argParser(once("--unit", parseChoice(UnitValues))),
    )
    .option(
      "--id <id>",
      'element id: "G-…" a group, "F-…" a function, unprefixed the budget structure; must match --unit, which it sets when omitted',
      once("--id", (value: string) => value),
    );
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

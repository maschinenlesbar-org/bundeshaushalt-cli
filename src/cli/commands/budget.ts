import type { Command } from "commander";
import { Option } from "commander";
import type { CliDeps } from "../io.js";
import { action, assertEnum, renderJson } from "../shared.js";
import { HaushaltError } from "../../client/errors.js";
import { AccountValues, QuotaValues, UnitValues, MIN_YEAR } from "../../client/enums.js";
import type { Account, Quota, Unit } from "../../client/enums.js";
import type { BudgetParams } from "../../client/types.js";

/**
 * Upper bound for an accepted year. Derived from the current year (rather than a
 * hard-coded literal) so the validator stays meaningful as years advance.
 *
 * Capped at next year: every summer the portal publishes the government's draft
 * budget (Regierungsentwurf) for the following year — in September 2026 it served
 * 2027 — so the current year alone would lock that newest budget out for months.
 * Outside that window the API answers next year with a 404 (exit 4). Next year
 * also covers the first hour of 1 January in German time, when UTC still reports
 * the old year.
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
      throw new HaushaltError(
        `Invalid id "${raw}". The --id value looks like an option; did you forget to supply an id?`,
      );
    }
    const id = raw.trim();
    // Reject empty/whitespace ids so bad input fails locally with a clear
    // message instead of producing an opaque API error (or `id=` in the query).
    if (id.length === 0) {
      throw new HaushaltError(`Invalid id "${raw}". Expected a non-empty budget number.`);
    }
    // Reject surrounding whitespace rather than silently trimming it: silent
    // mutation can mask copy-paste errors and collapse two distinct inputs.
    if (id !== raw) {
      throw new HaushaltError(`Invalid id "${raw}". Surrounding whitespace is not allowed.`);
    }
    // A bare group/function prefix names no element; the live API answers it with a
    // 503, which would be retried as transient and read as an outage.
    if (/^[GF]-$/i.test(id)) {
      throw new HaushaltError(
        `Invalid id "${raw}". Expected a number after the "${id.toUpperCase()}" prefix, e.g. "${id.toUpperCase()}5".`,
      );
    }
    params.id = id;
    // The prefix fixes the grouping, and the API answers a mismatched pair with a
    // bare 404 ("not found" for an id that exists): infer --unit when it is omitted,
    // reject a contradicting one.
    const idUnit = unitOfId(id);
    if (params.unit === undefined) {
      if (idUnit !== "single") params.unit = idUnit;
    } else if (params.unit !== idUnit) {
      const why =
        idUnit === "single"
          ? `${params.unit} ids start with "${UNIT_PREFIX[params.unit]}" (e.g. "${UNIT_EXAMPLE[params.unit]}")`
          : `a "${UNIT_PREFIX[idUnit]}" id belongs to --unit ${idUnit}`;
      throw new HaushaltError(`Invalid id "${raw}" for --unit ${params.unit}: ${why}.`);
    }
  }
  return params;
}

/** The id prefix of each grouping (the API matches it case-insensitively). */
const UNIT_PREFIX: Record<Unit, string> = { group: "G-", function: "F-", single: "" };
const UNIT_EXAMPLE: Record<Unit, string> = { group: "G-5", function: "F-0", single: "14" };

/** The grouping an id belongs to, by its prefix: G- group, F- function, none single. */
function unitOfId(id: string): Unit {
  const prefix = id.slice(0, 2).toUpperCase();
  if (prefix === UNIT_PREFIX.group) return "group";
  if (prefix === UNIT_PREFIX.function) return "function";
  return "single";
}

function addBudgetOptions(cmd: Command): Command {
  return cmd
    .addOption(
      new Option("--quota <quota>", "planned vs realised (default target)").choices([
        ...QuotaValues,
      ]),
    )
    .addOption(
      new Option("--unit <unit>", "how elements are grouped (default single)").choices([
        ...UnitValues,
      ]),
    )
    .option(
      "--id <id>",
      'element id: "G-…" a group, "F-…" a function, unprefixed the budget structure; must match --unit, which it sets when omitted',
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

// Enum-like value sets. These const arrays double as runtime CLI choice
// validators and as TS union types.

/** Which side of the budget to query. */
export const AccountValues = ["expenses", "income"] as const;
export type Account = (typeof AccountValues)[number];

/** Planned (`target`) vs. realised (`actual`) figures. */
export const QuotaValues = ["target", "actual"] as const;
export type Quota = (typeof QuotaValues)[number];

/**
 * How budget elements are grouped:
 *   single   — by budget structure (Einzelplan → Kapitel → Titel)
 *   function — by functional area (Funktion)
 *   group    — by economic group (Gruppe)
 */
export const UnitValues = ["single", "function", "group"] as const;
export type Unit = (typeof UnitValues)[number];

/**
 * The id prefix of each grouping: `G-` group, `F-` function, none for the budget
 * structure (`single`). The API matches the prefix case-insensitively and answers
 * an id/unit pair that disagrees with a bare 404, "not found" for an id that exists.
 */
export const UNIT_PREFIX: Readonly<Record<Unit, string>> = { group: "G-", function: "F-", single: "" };

/** An example id of each grouping, for messages. */
export const UNIT_EXAMPLE: Readonly<Record<Unit, string>> = { group: "G-5", function: "F-0", single: "14" };

/** The grouping an id belongs to, by its prefix (any case): `G-` group, `F-` function, none single. */
export function unitOfId(id: string): Unit {
  const prefix = id.slice(0, 2).toUpperCase();
  if (prefix === UNIT_PREFIX.group) return "group";
  if (prefix === UNIT_PREFIX.function) return "function";
  return "single";
}

/** Earliest year the API serves. */
export const MIN_YEAR = 2012;

/**
 * Latest accepted year: next year, derived from the clock (UTC) rather than a
 * hard-coded literal. Every summer the portal publishes the government's draft
 * budget (Regierungsentwurf) for the following year (in September 2026 it served
 * 2027), so the current year alone would lock that newest budget out for months.
 * Before the draft appears the API answers next year with a 404. Next year also
 * covers the first hour of 1 January in German time, when UTC still reports the
 * old year.
 */
export function maxYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

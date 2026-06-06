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
 *   single   — by individual budget item (Einzelplan/Titel)
 *   function — by functional area (Funktion)
 *   group    — by economic group (Gruppe)
 */
export const UnitValues = ["single", "function", "group"] as const;
export type Unit = (typeof UnitValues)[number];

/** Earliest year the API serves. */
export const MIN_YEAR = 2012;

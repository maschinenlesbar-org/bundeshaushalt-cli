// The use cases of the skills as library functions, built on the client: each carries the traps
// the skills document, so no caller (the CLI, the MCP server's tools, a library user) has to know
// them.
// - lookupBudgetData: one budgetData answer, or why there is none (a 404 or an empty element is
//   "not published yet" or "no such element that year", never a bare not found);
// - getBudgetBreakdown: a view ranked by amount, with shares, the path and the leaf's
//   cross-references (budget-ministry-breakdown);
// - comparePlanToActual: Soll against Ist, joined by id, with the deltas (budget-plan-vs-actual);
// - getBudgetTrend: one figure across years, with gaps and renames marked (budget-trend).

import type { BundeshaushaltClient } from "./client.js";
import { HaushaltApiError, HaushaltNotFoundError, HaushaltParseError, HaushaltValidationError } from "./errors.js";
import { maxYear, MIN_YEAR, type Account, type Quota, type Unit } from "./enums.js";
import type { BudgetData, BudgetElement, BudgetParams, LabeledElement } from "./types.js";

/** What every operation takes besides its input: the clock (tests inject one). */
export interface OperationOptions {
  now?: () => Date;
}

/** The element a view is about: the whole budget (no id) or one element of a grouping. */
export interface BudgetSelection {
  /** The budget year (2012 to next year). */
  year: number;
  /** expenses (default) or income. */
  account?: Account | undefined;
  /** single (by ministry, default), group (economic, `G-` ids) or function (purpose, `F-` ids); a `G-`/`F-` id sets it. */
  unit?: Unit | undefined;
  /** An element id from a breakdown (`14`, `1405`, `G-6`, `F-03`); none: the whole budget. */
  id?: string | undefined;
}

/** The answer of {@link lookupBudgetData}. */
export type BudgetLookup = { status: "ok"; data: BudgetData } | { status: "empty"; searched: BudgetParams; reason: string };

/**
 * One budgetData answer, or why the API has none. A 404 or an empty element (the CLI's exit 4)
 * means: for `actual`, the year's realised figures are not published yet (or the id doesn't exist
 * then); for next year, the draft budget isn't out yet; for an id, no such element that year, in
 * that grouping. Every other error (a bad parameter, the network, a 5xx) is thrown.
 */
export async function lookupBudgetData(client: BundeshaushaltClient, params: BudgetParams, options: OperationOptions = {}): Promise<BudgetLookup> {
  try {
    return { status: "ok", data: await client.budgetData(params) };
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return { status: "empty", searched: { ...params }, reason: notFoundReason(params, options) };
  }
}

/** True for the two ways the API says "nothing here": a 404, and an id answered with an empty element. */
function isNotFound(err: unknown): boolean {
  return (err instanceof HaushaltApiError && err.status === 404) || err instanceof HaushaltNotFoundError;
}

function notFoundReason(params: BudgetParams, options: OperationOptions): string {
  const now = options.now?.() ?? new Date();
  const element = params.id === undefined ? "" : ` (or element ${params.id} doesn't exist in ${params.year}: ids differ by year and grouping; list the level above for valid ids)`;
  if (params.quota === "actual") {
    return `The realised figures (Ist) for ${params.year} are not published${element}. Ist appears only once a year's accounts are closed, months after it ends; the current year has only planned figures (quota target). This doesn't mean nothing was spent.`;
  }
  if (params.year > now.getUTCFullYear()) {
    return `The draft budget (Regierungsentwurf) for ${params.year} is not published yet${element}; it appears each summer. Try ${params.year - 1}.`;
  }
  if (params.id !== undefined) {
    return `No budget element ${params.id} in ${params.year} (${params.account}, unit ${params.unit ?? "single"}). Ids differ by year and grouping (Einzelplan 24 exists only from 2025); list the level above for valid ids, and keep the unit the id came from.`;
  }
  return `No budget data for ${params.year} (${params.account}).`;
}

/**
 * {@link lookupBudgetData} for the operations, which compute with the figures: an answer whose
 * element has no numeric value, or with a child that has no id or no numeric value, is a
 * HaushaltParseError. The undocumented endpoint changing shape (values as strings, an empty
 * element for the whole budget) used to give an `ok` answer with no rows, null figures or equal
 * totals, the children it couldn't read dropped silently.
 */
async function lookupView(client: BundeshaushaltClient, params: BudgetParams, options: OperationOptions): Promise<BudgetLookup> {
  const lookup = await lookupBudgetData(client, params, options);
  if (lookup.status === "empty") return lookup;
  const problem = viewProblem(lookup.data);
  if (problem !== undefined) {
    const what = `${params.year}, ${params.account}${params.quota === undefined ? "" : `, ${params.quota}`}${params.unit === undefined ? "" : `, unit ${params.unit}`}${params.id === undefined ? "" : `, id ${params.id}`}`;
    throw new HaushaltParseError(`budgetData (${what}): unexpected response shape: ${problem}. The portal's internal endpoint may have changed.`);
  }
  return lookup;
}

function viewProblem(data: BudgetData): string | undefined {
  const value: unknown = data.detail["value"];
  if (typeof value !== "number") return `the element's value is ${value === undefined ? "missing" : `not a number (${value === null ? "null" : typeof value})`}`;
  const children: unknown = data.children;
  if (children === undefined) return undefined;
  if (!Array.isArray(children)) return "children is not a list";
  const bad = children.findIndex((c: unknown) => typeof c !== "object" || c === null || typeof (c as BudgetElement).id !== "string" || typeof (c as BudgetElement).value !== "number");
  return bad === -1 ? undefined : `child ${bad + 1} of ${children.length} has no id or no numeric value`;
}

/** The params of a selection, as the client takes them. */
function paramsOf(selection: BudgetSelection, quota: Quota): BudgetParams {
  return {
    year: selection.year,
    account: selection.account ?? "expenses",
    quota,
    ...(selection.unit === undefined ? {} : { unit: selection.unit }),
    ...(selection.id === undefined ? {} : { id: selection.id }),
  };
}

/** One element of a level, as a breakdown lists it. */
export interface BreakdownRow {
  id: string;
  label: string;
  /** Euros (not thousands): 175675498000 is €175.7 bn. */
  value: number;
  /** Share of the whole budget in percent, two decimals. */
  sharePercent: number;
  /** Share of the element broken down in percent, two decimals. */
  shareOfParentPercent: number;
}

/** The input of {@link getBudgetBreakdown}. */
export interface BreakdownInput extends BudgetSelection {
  /** target (planned, Soll; default) or actual (realised, Ist). */
  quota?: Quota | undefined;
  /** The most rows listed; the rest are summed (1–100, default 15). */
  limit?: number | undefined;
}

/** The answer of {@link getBudgetBreakdown}. */
export type Breakdown =
  | { status: "empty"; searched: BudgetParams; reason: string }
  | {
      status: "ok";
      year: number;
      account: Account;
      quota: Quota;
      unit: Unit;
      /** The element broken down: its label, its amount in euros, its depth and its path from the top. */
      element: { id?: string; label: string; value: number; level?: number; maxLevel?: number; path: { id: string; label: string }[] };
      /** What the rows are (Einzelplan, Kapitel, Titel, Hauptgruppe, …); absent at a leaf. */
      rowsAre?: string;
      /** The element's children by amount, largest first. */
      rows: BreakdownRow[];
      /** The children past `limit`, summed. */
      rest?: { count: number; value: number };
      /** At a leaf (a Titel), which has no children: the same line in the other groupings, and its pages in the Haushaltsplan. */
      leaf: boolean;
      related?: Record<string, { id: string; label: string }[]>;
      pdf?: string[];
      /** The view's last change at the portal (dd.mm.yyyy). */
      modified?: string;
    };

/**
 * A view of the budget ranked by amount: the whole budget or one element, by ministry
 * (Einzelplan), economic group or function, planned or realised. The rows are sorted here (the
 * API's order is not relied on); past `limit` they are summed into `rest`. At a leaf there are no
 * rows (not "no breakdown"): the answer has the element's amount, its cross-references in the
 * other groupings and its PDF pages. A 404 or an empty element is `empty` with the reason.
 */
export async function getBudgetBreakdown(client: BundeshaushaltClient, input: BreakdownInput, options: OperationOptions = {}): Promise<Breakdown> {
  const limit = checkedLimit(input.limit, 15, 100);
  const lookup = await lookupView(client, paramsOf(input, input.quota ?? "target"), options);
  if (lookup.status === "empty") return lookup;
  const { meta, detail } = lookup.data;
  const children = elements(lookup.data.children);
  const sorted = [...children].sort((a, b) => b.value - a.value);
  const rows = sorted.slice(0, limit).map(rowOf);
  const others = sorted.slice(limit);
  const level = typeof meta.levelCur === "number" ? meta.levelCur : undefined;
  const maxLevel = typeof meta.levelMax === "number" ? meta.levelMax : undefined;
  const leaf = lookup.data.children === undefined;
  const id = typeof detail["id"] === "string" ? detail["id"] : undefined;
  const related = leaf ? relatedOf(lookup.data.related) : undefined;
  const rawPdf: unknown = detail["pdf"];
  const pdf: string[] = Array.isArray(rawPdf) ? rawPdf.filter((p): p is string => typeof p === "string") : [];
  return {
    status: "ok",
    year: meta.year,
    account: meta.account,
    quota: meta.quota,
    unit: meta.unit,
    element: {
      ...(id === undefined ? {} : { id }),
      label: String(detail["label"] ?? ""),
      value: Number(detail["value"]),
      ...(level === undefined ? {} : { level }),
      ...(maxLevel === undefined ? {} : { maxLevel }),
      path: pathOf(lookup.data.parents, id),
    },
    ...(typeof detail["tableLabel"] === "string" && !leaf ? { rowsAre: detail["tableLabel"] } : {}),
    rows,
    ...(others.length === 0 ? {} : { rest: { count: others.length, value: sum(others.map((e) => e.value)) } }),
    leaf,
    ...(related === undefined ? {} : { related }),
    ...(pdf.length === 0 ? {} : { pdf }),
    ...(meta.modifyDate === undefined ? {} : { modified: meta.modifyDate }),
  };
}

/** The input of {@link comparePlanToActual}. */
export interface PlanVsActualInput extends BudgetSelection {
  /** Rank the elements by the difference in euros (default) or in percent of the plan; in percent, elements with nothing planned (no percent) come first. */
  rankBy?: "euros" | "percent" | undefined;
  /** The most elements listed per end (overspent, underspent; 1–50, default 5). */
  limit?: number | undefined;
}

/** One element in both quotas. */
export interface PlanVsActualRow {
  id: string;
  label: string;
  /** Planned (Soll) and realised (Ist), in euros; Ist carries cents. */
  target: number;
  actual: number;
  /** actual − target in euros (cents kept): positive is over plan, negative under. */
  delta: number;
  /** delta in percent of the plan, one decimal; null when nothing was planned. */
  deltaPercent: number | null;
}

/** The answer of {@link comparePlanToActual}. */
export type PlanVsActual =
  | { status: "empty"; searched: BudgetParams; reason: string; latestYearWithActuals?: number }
  | {
      status: "ok";
      year: number;
      account: Account;
      unit: Unit;
      /** What the plan and the realised figures cover, as the portal labels them (a plan may include a supplementary budget). */
      planLabel: string;
      actualLabel: string;
      element: { id?: string; label: string };
      totals: { target: number; actual: number; delta: number; deltaPercent: number | null; executedPercent: number | null };
      /** Elements compared. */
      compared: number;
      overspent: PlanVsActualRow[];
      underspent: PlanVsActualRow[];
      /** Planned but with no realised line, and realised without a planned line. */
      onlyInPlan: { id: string; label: string; value: number }[];
      onlyInActual: { id: string; label: string; value: number }[];
    };

/** How far back comparePlanToActual looks for a year with realised figures. */
const ACTUALS_LOOKBACK = 2;

/**
 * Planned (Soll) against realised (Ist) figures of one year, for the whole budget or one element,
 * joined by id (never by label). Ist is published only once a year's accounts are closed: when it
 * isn't there, the answer is `empty` with the reason and the latest of the two years before that
 * has Ist (`latestYearWithActuals`), never a comparison against nothing; an element with no Ist
 * line in a year whose Ist is published is `empty` saying that, without an earlier year. Elements present in one
 * quota only are listed apart, not dropped. Differences keep the cents of the Ist figures.
 */
export async function comparePlanToActual(client: BundeshaushaltClient, input: PlanVsActualInput, options: OperationOptions = {}): Promise<PlanVsActual> {
  const limit = checkedLimit(input.limit, 5, 50);
  const plan = await lookupView(client, paramsOf(input, "target"), options);
  if (plan.status === "empty") return plan;
  const real = await lookupView(client, paramsOf(input, "actual"), options);
  if (real.status === "empty") {
    // An element without an Ist line in a year whose Ist is out: no realised figure under this id
    // that year, not "not published" (with an earlier year offered in its place).
    if (input.id !== undefined) {
      const year = await lookupBudgetData(client, paramsOf({ ...input, id: undefined }, "actual"), options);
      if (year.status === "ok") {
        return {
          ...real,
          reason: `There is no realised line (Ist) for element ${input.id} in ${input.year}, although ${input.year}'s realised figures are published: the portal has a plan for it but no realised figure under this id that year (it may have been booked under another element, or ids changed). Compare the level above, or break down ${input.year}'s realised figures.`,
        };
      }
    }
    for (let year = input.year - 1; year >= Math.max(MIN_YEAR, input.year - ACTUALS_LOOKBACK); year--) {
      const earlier = await lookupBudgetData(client, paramsOf({ ...input, year }, "actual"), options);
      if (earlier.status === "ok") return { ...real, latestYearWithActuals: year };
    }
    return real;
  }
  const planned = elements(plan.data.children);
  const realised = new Map(elements(real.data.children).map((e) => [e.id, e]));
  const plannedIds = new Set(planned.map((e) => e.id));
  const rows: PlanVsActualRow[] = [];
  const onlyInPlan: { id: string; label: string; value: number }[] = [];
  for (const p of planned) {
    const a = realised.get(p.id);
    if (a === undefined) onlyInPlan.push({ id: p.id, label: p.label, value: p.value });
    else rows.push(compareRow(p.id, p.label, p.value, a.value));
  }
  const onlyInActual = [...realised.values()].filter((a) => !plannedIds.has(a.id)).map((a) => ({ id: a.id, label: a.label, value: a.value }));
  // Both ends by the size of the difference. In percent, spending where nothing was planned has
  // no percent: it comes first (by euros), never ranked as 0 %.
  const byEuros = (a: PlanVsActualRow, b: PlanVsActualRow): number => Math.abs(b.delta) - Math.abs(a.delta);
  const byPercent = (a: PlanVsActualRow, b: PlanVsActualRow): number =>
    a.deltaPercent === null || b.deltaPercent === null
      ? Number(a.deltaPercent !== null) - Number(b.deltaPercent !== null) || byEuros(a, b)
      : Math.abs(b.deltaPercent) - Math.abs(a.deltaPercent) || byEuros(a, b);
  const rank = input.rankBy === "percent" ? byPercent : byEuros;
  const target = Number(plan.data.detail["value"]);
  const actual = Number(real.data.detail["value"]);
  const totals = compareRow("", "", target, actual);
  const id = typeof plan.data.detail["id"] === "string" ? plan.data.detail["id"] : undefined;
  return {
    status: "ok",
    year: plan.data.meta.year,
    account: plan.data.meta.account,
    unit: plan.data.meta.unit,
    planLabel: viewLabel(plan.data),
    actualLabel: viewLabel(real.data),
    element: { ...(id === undefined ? {} : { id }), label: String(plan.data.detail["label"] ?? "") },
    totals: { target, actual, delta: totals.delta, deltaPercent: totals.deltaPercent, executedPercent: target === 0 ? null : round(actual / target * 100, 1) },
    compared: rows.length,
    overspent: rows.filter((r) => r.delta > 0).sort(rank).slice(0, limit),
    underspent: rows.filter((r) => r.delta < 0).sort(rank).slice(0, limit),
    onlyInPlan,
    onlyInActual,
  };
}

/** The whole view's label ("Sollwerte des Haushaltsjahres 2023 einschl. 1. Nachtrag"): the top's, also below it. */
function viewLabel(data: BudgetData): string {
  if (typeof data.detail["id"] !== "string") return String(data.detail["label"] ?? "");
  return String(data.parents?.[0]?.find((e) => e.id === null || e.id === undefined)?.label ?? "");
}

function compareRow(id: string, label: string, target: number, actual: number): PlanVsActualRow {
  const delta = round(actual - target, 2);
  return { id, label, target, actual, delta, deltaPercent: target === 0 ? null : round(delta / target * 100, 1) };
}

/** The input of {@link getBudgetTrend}. */
export interface TrendInput {
  /** The first and last year (default 2012 to next year: the draft budget, once published). */
  fromYear?: number | undefined;
  toYear?: number | undefined;
  account?: Account | undefined;
  /** target (planned, default) or actual (realised: later years are gaps until published). Never mixed in one series. */
  quota?: Quota | undefined;
  unit?: Unit | undefined;
  /** One element by id, the same in every year; none: the whole budget. */
  id?: string | undefined;
}

/** One year of a trend: its figure, or why there is none. */
export type TrendPoint =
  | {
      year: number;
      /** Euros. */
      value: number;
      label: string;
      /** Change against the year before in percent of its amount's size, one decimal: positive is a rise, also for a negative figure (−10 bn to −5 bn is +50); absent after a gap or a zero. */
      changePercent?: number;
      /** The element's label differs from the year before: a rename, often with moved responsibilities; not comparable growth. */
      renamedFrom?: string;
      /** A year after the current one: the government's draft budget (Regierungsentwurf). */
      draft?: true;
    }
  | { year: number; gap: string };

/** The answer of {@link getBudgetTrend}. */
export type Trend =
  | { status: "empty"; searched: TrendInput; reason: string }
  | {
      status: "ok";
      account: Account;
      quota: Quota;
      unit: Unit;
      element: { id?: string; label: string };
      points: TrendPoint[];
      /** First and last year with a figure, the change between them in percent and per year (CAGR), one decimal. */
      span?: { from: number; to: number; changePercent: number; perYearPercent: number };
      /** Years with a label change (see renamedFrom): compare across them with care. */
      breaks: number[];
      gaps: number[];
    };

/**
 * One figure across years: the whole budget's total or one element's amount (by id, the same id
 * every year: Einzelplan numbers stay, names change), one request per year, in order. A year
 * without the figure is a gap with its reason (not published yet, no such element then), never a
 * zero and never the end of the series; a label change marks a break in comparability. A year
 * outside 2012 to next year is a HaushaltValidationError before any request. Every other error
 * ends the call. Nominal euros, not adjusted for inflation.
 */
export async function getBudgetTrend(client: BundeshaushaltClient, input: TrendInput, options: OperationOptions = {}): Promise<Trend> {
  const now = options.now?.() ?? new Date();
  const from = input.fromYear ?? MIN_YEAR;
  const to = input.toYear ?? maxYear(now);
  // Both ends checked before any request: a year past next year failed only when its turn came,
  // after the years before it had been read, and named neither the argument nor the range.
  const latest = maxYear(now);
  for (const [name, year] of [["fromYear", from], ["toYear", to]] as const) {
    if (!Number.isSafeInteger(year) || year < MIN_YEAR || year > latest) {
      throw new HaushaltValidationError(`Invalid ${name} ${year}: Expected a year between ${MIN_YEAR} and ${latest} (next year: the latest budget, a draft once published).`);
    }
  }
  if (from > to) throw new HaushaltValidationError(`Invalid years: fromYear ${from} is after toYear ${to}.`);
  const quota = input.quota ?? "target";
  const points: TrendPoint[] = [];
  let meta: BudgetData["meta"] | undefined;
  let previous: { value: number; label: string } | undefined;
  let lastLabel = "";
  for (let year = from; year <= to; year++) {
    const lookup = await lookupView(client, paramsOf({ ...input, year }, quota), options);
    if (lookup.status === "empty") {
      points.push({ year, gap: lookup.reason });
      previous = undefined;
      continue;
    }
    meta = lookup.data.meta;
    const value = Number(lookup.data.detail["value"]);
    const label = String(lookup.data.detail["label"] ?? "");
    const renamed = input.id !== undefined && lastLabel !== "" && label !== lastLabel ? lastLabel : undefined;
    points.push({
      year,
      value,
      label,
      // Against the previous amount's size, so the sign is the direction also below zero (G-9 is negative).
      ...(previous === undefined || previous.value === 0 ? {} : { changePercent: round((value - previous.value) / Math.abs(previous.value) * 100, 1) }),
      ...(renamed === undefined ? {} : { renamedFrom: renamed }),
      ...(year > now.getUTCFullYear() ? { draft: true as const } : {}),
    });
    previous = { value, label };
    lastLabel = label;
  }
  const figures = points.filter((p): p is Extract<TrendPoint, { value: number }> => "value" in p);
  const gaps = points.filter((p) => "gap" in p).map((p) => p.year);
  if (figures.length === 0 || meta === undefined) {
    const reason = (points[0] as { gap?: string } | undefined)?.gap ?? "No year has the figure.";
    return { status: "empty", searched: { ...input, fromYear: from, toYear: to, quota }, reason: `No year from ${from} to ${to} has the figure. The first year's reason: ${reason}` };
  }
  const first = figures[0] as (typeof figures)[number];
  const last = figures[figures.length - 1] as (typeof figures)[number];
  const years = last.year - first.year;
  const span =
    years > 0 && first.value > 0 && last.value > 0
      ? { from: first.year, to: last.year, changePercent: round((last.value - first.value) / first.value * 100, 1), perYearPercent: round(((last.value / first.value) ** (1 / years) - 1) * 100, 1) }
      : undefined;
  return {
    status: "ok",
    account: meta.account,
    quota,
    unit: meta.unit,
    element: { ...(input.id === undefined ? {} : { id: input.id }), label: input.id === undefined ? "the whole budget" : last.label },
    points,
    ...(span === undefined ? {} : { span }),
    breaks: figures.filter((p) => p.renamedFrom !== undefined).map((p) => p.year),
    gaps,
  };
}

/** The children as elements (lookupView has checked that each has an id and a numeric value). */
function elements(children: BudgetData["children"]): { id: string; label: string; value: number; relativeValue: number; relativeToParentValue: number }[] {
  return (children ?? []).flatMap((child) => {
    const c = child as BudgetElement;
    if (typeof c.id !== "string" || typeof c.value !== "number") return [];
    return [{ id: c.id, label: String(c.label ?? ""), value: c.value, relativeValue: Number(c.relativeValue), relativeToParentValue: Number(c.relativeToParentValue) }];
  });
}

function rowOf(e: ReturnType<typeof elements>[number]): BreakdownRow {
  return { id: e.id, label: e.label, value: e.value, sharePercent: round(e.relativeValue, 2), shareOfParentPercent: round(e.relativeToParentValue, 2) };
}

/**
 * The path to the element from the top: per level of `parents` (each lists all of that level's
 * elements, not just the path), the one whose id begins the element's id. The root (id null) is
 * left out.
 */
function pathOf(parents: LabeledElement[][] | undefined, id: string | undefined): { id: string; label: string }[] {
  if (id === undefined || parents === undefined) return [];
  return parents.flatMap((level) => {
    const hit = level.find((e) => typeof e.id === "string" && e.id !== "" && id.toUpperCase().startsWith(e.id.toUpperCase()));
    return hit === undefined ? [] : [{ id: hit.id as string, label: String(hit.label ?? "") }];
  });
}

function relatedOf(related: BudgetData["related"]): Record<string, { id: string; label: string }[]> | undefined {
  if (related === undefined) return undefined;
  const out: Record<string, { id: string; label: string }[]> = {};
  for (const [grouping, path] of Object.entries(related)) {
    if (!Array.isArray(path)) continue;
    out[grouping] = path.flatMap((e) => (typeof e.id === "string" ? [{ id: e.id, label: String(e.label ?? "") }] : []));
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function checkedLimit(value: number | undefined, fallback: number, max: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw new HaushaltValidationError(`Invalid limit: Expected a whole number from 1 to ${max}.`);
  return limit;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function sum(values: number[]): number {
  return round(values.reduce((a, b) => a + b, 0), 2);
}

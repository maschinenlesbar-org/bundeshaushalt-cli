// The use cases of the skills against recorded portal answers, with the skills' traps as cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeshaushaltClient, comparePlanToActual, getBudgetBreakdown, getBudgetTrend, HaushaltApiError, HaushaltParseError, HaushaltValidationError, lookupBudgetData } from "../src/index.js";
import { EMPTY_ELEMENT, expenses2024, expenses2024Actual, ministry12, ministry14, portal, titel140555408, view, viewKey } from "./fixtures.js";
import { jsonResponse } from "./helpers.js";
import type { MockTransport } from "./helpers.js";

const clientOf = (mock: MockTransport) => new BundeshaushaltClient({ transport: mock.transport, maxRetries: 0 });
const now = () => new Date("2026-11-19T12:00:00Z");
const top = (year: number, value: number, quota: "target" | "actual" = "target") =>
  view({ year, quota, label: `${quota === "target" ? "Sollwerte" : "Istwerte"} des Haushaltsjahres ${year}`, value });

test("getBudgetBreakdown: rows ranked by amount whatever the API's order, shares rounded, the rest summed", async () => {
  const b = await getBudgetBreakdown(clientOf(portal([expenses2024])), { year: 2024, limit: 2 });
  assert.equal(b.status, "ok");
  if (b.status !== "ok") return;
  assert.deepEqual(b.rows.map((r) => r.id), ["11", "14"]);
  assert.equal(b.rows[0]?.sharePercent, 36.84);
  assert.deepEqual(b.rest, { count: 2, value: 44145217000 + 39571791000 });
  assert.equal(b.element.value, 476807656000, "euros, not thousands");
  assert.equal(b.rowsAre, "Einzelplan", "the dimension is on detail.tableLabel, not meta");
  assert.equal(b.leaf, false);
});

test("getBudgetBreakdown: a drill-down gives the path from the top, picked from the siblings each level lists", async () => {
  const b = await getBudgetBreakdown(clientOf(portal([ministry14])), { year: 2024, id: "14" });
  assert.equal(b.status, "ok");
  if (b.status !== "ok") return;
  assert.deepEqual(b.element.path, [{ id: "14", label: "14 Bundesministerium der Verteidigung" }]);
  assert.deepEqual(b.rows.map((r) => r.id), ["1403", "1408", "1405"]);
  assert.equal(b.rowsAre, "Kapitel");
});

test("getBudgetBreakdown: a leaf (no children key) is the amount with its cross-references and PDF page, not 'no breakdown'", async () => {
  const b = await getBudgetBreakdown(clientOf(portal([titel140555408])), { year: 2024, id: "140555408" });
  assert.equal(b.status, "ok");
  if (b.status !== "ok") return;
  assert.equal(b.leaf, true);
  assert.deepEqual(b.rows, []);
  assert.equal(b.element.value, 467225000);
  assert.deepEqual(b.element.path.map((p) => p.id), ["14", "1405", "140555408"]);
  assert.deepEqual(b.related?.["group"]?.map((g) => g.id), ["G-5", "G-55", "G-554"]);
  assert.equal(b.pdf?.length, 1);
});

test("getBudgetBreakdown: a G- id sends unit group, so the API finds it (a mismatched pair is a bare 404)", async () => {
  const g6 = view({ year: 2024, unit: "group", id: "G-6", label: "6 Zuweisungen und Zuschüsse", value: 294893063000, children: [["G-63", "63 Sonstige", 184465875000]] });
  const mock = portal([g6]);
  const b = await getBudgetBreakdown(clientOf(mock), { year: 2024, id: "G-6" });
  assert.equal(b.status, "ok");
  assert.equal(new URL(mock.last().url).searchParams.get("unit"), "group");
});

test("getBudgetBreakdown: an unknown id, or one answered with an empty element, is empty with a reason, never a bare not found", async () => {
  const mock = portal([], { [viewKey(2024, "expenses", "target", "group", "G-1")]: EMPTY_ELEMENT });
  for (const id of ["99", "G-1"]) {
    const b = await getBudgetBreakdown(clientOf(mock), { year: 2024, id }, { now });
    assert.equal(b.status, "empty", id);
    if (b.status !== "empty") continue;
    assert.match(b.reason, new RegExp(`No budget element ${id} in 2024.*Ids differ by year`));
  }
});

test("getBudgetBreakdown: actual for a year whose accounts aren't closed is 'not published', not 'nothing spent'", async () => {
  const b = await getBudgetBreakdown(clientOf(portal([])), { year: 2026, quota: "actual" }, { now });
  assert.equal(b.status, "empty");
  if (b.status !== "empty") return;
  assert.match(b.reason, /realised figures \(Ist\) for 2026 are not published.*doesn't mean nothing was spent/);
});

test("getBudgetBreakdown: next year before its draft is out says so", async () => {
  const b = await getBudgetBreakdown(clientOf(portal([])), { year: 2027 }, { now });
  assert.equal(b.status, "empty");
  if (b.status === "empty") assert.match(b.reason, /draft budget \(Regierungsentwurf\) for 2027 is not published yet/);
});

test("a changed answer shape (values as strings, an empty element for the whole budget) is an error, never an ok answer with no rows or null figures", async () => {
  const stringly = JSON.parse(JSON.stringify(expenses2024, (key, value) => (key === "value" && typeof value === "number" ? String(value) : value))) as unknown;
  const strings = portal([], { [viewKey(2024)]: stringly, [viewKey(2024, "expenses", "actual")]: stringly });
  const emptied = portal([], { [viewKey(2024)]: { meta: expenses2024.meta, detail: {} }, [viewKey(2024, "expenses", "actual")]: { meta: expenses2024.meta, detail: {} } });
  for (const mock of [strings, emptied]) {
    const shape = (err: unknown) => err instanceof HaushaltParseError && /unexpected response shape/.test(err.message) && /2024/.test(err.message);
    await assert.rejects(getBudgetBreakdown(clientOf(mock), { year: 2024 }, { now }), shape);
    await assert.rejects(comparePlanToActual(clientOf(mock), { year: 2024 }, { now }), shape);
    await assert.rejects(getBudgetTrend(clientOf(mock), { fromYear: 2024, toYear: 2024 }, { now }), shape);
  }
  const oneChild = view({ year: 2024, label: "Sollwerte des Haushaltsjahres 2024", value: 10, children: [["01", "01 A", 10]] });
  (oneChild.children as unknown as Record<string, unknown>[]).push({ id: "02", label: "02 B", value: "5" });
  await assert.rejects(getBudgetBreakdown(clientOf(portal([oneChild])), { year: 2024 }, { now }), (err) => err instanceof HaushaltParseError && /child 2 of 2/.test(err.message));
});

test("lookupBudgetData: an error other than not found is thrown, not turned into a reason", async () => {
  const mock = portal([], { [viewKey(2024)]: jsonResponse({ message: "boom" }, 500) });
  await assert.rejects(lookupBudgetData(clientOf(mock), { year: 2024, account: "expenses" }), (err) => err instanceof HaushaltApiError && err.status === 500);
  await assert.rejects(getBudgetBreakdown(clientOf(portal([])), { year: 2024, limit: 0 }), HaushaltValidationError);
});

test("comparePlanToActual: joined by id, deltas keep the cents, both ends ranked, one-sided elements listed apart", async () => {
  const mock = portal([expenses2024, expenses2024Actual]);
  const c = await comparePlanToActual(clientOf(mock), { year: 2024 });
  assert.equal(c.status, "ok");
  if (c.status !== "ok") return;
  assert.equal(c.planLabel, "Sollwerte des Haushaltsjahres 2024");
  assert.equal(c.actualLabel, "Istwerte des Haushaltsjahres 2024");
  assert.deepEqual(c.overspent.map((r) => [r.id, r.delta]), [["11", 5897920713.62], ["12", 1114261281.89]]);
  assert.deepEqual(c.underspent.map((r) => [r.id, r.delta, r.deltaPercent]), [["14", -1664793142.41, -3.2]]);
  assert.deepEqual(c.onlyInPlan.map((r) => r.id), ["32"]);
  assert.deepEqual(c.onlyInActual.map((r) => r.id), ["60"]);
  assert.equal(c.totals.delta, -2053928390.42);
  assert.equal(c.totals.executedPercent, 99.6);
  assert.equal(c.compared, 3);
});

test("comparePlanToActual: rankBy percent ranks by the share of the plan, euros by the amount", async () => {
  const plan = view({ year: 2023, label: "Sollwerte des Haushaltsjahres 2023", value: 1100, children: [["01", "01 A", 100], ["02", "02 B", 1000]] });
  const real = view({ year: 2023, quota: "actual", label: "Istwerte des Haushaltsjahres 2023", value: 1250, children: [["01", "01 A", 150], ["02", "02 B", 1100]] });
  const ranked = async (rankBy: "euros" | "percent") => {
    const c = await comparePlanToActual(clientOf(portal([plan, real])), { year: 2023, rankBy });
    return c.status === "ok" ? c.overspent.map((r) => [r.id, r.deltaPercent]) : [];
  };
  assert.deepEqual(await ranked("euros"), [["02", 10], ["01", 50]]);
  assert.deepEqual(await ranked("percent"), [["01", 50], ["02", 10]]);
});

test("comparePlanToActual: rankBy percent ranks spending with nothing planned first (no percent), not as 0 %", async () => {
  const plan = view({ year: 2024, label: "Sollwerte des Haushaltsjahres 2024", value: 10e6, children: [["01", "01 A", 0], ["03", "03 C", 10e6], ["04", "04 D", 0]] });
  const real = view({ year: 2024, quota: "actual", label: "Istwerte des Haushaltsjahres 2024", value: 80e6 - 2e6, children: [["01", "01 A", 50e6], ["03", "03 C", 30e6], ["04", "04 D", -2e6]] });
  const c = await comparePlanToActual(clientOf(portal([plan, real])), { year: 2024, rankBy: "percent", limit: 1 });
  assert.equal(c.status, "ok");
  if (c.status !== "ok") return;
  assert.deepEqual(c.overspent.map((r) => [r.id, r.deltaPercent]), [["01", null]]);
  assert.deepEqual(c.underspent.map((r) => [r.id, r.deltaPercent]), [["04", null]]);
});

test("comparePlanToActual: no Ist yet is empty with the reason and the latest year that has it, never a comparison against nothing", async () => {
  const mock = portal([top(2026, 520e9), top(2025, 500e9), top(2024, 470e9, "actual")]);
  const c = await comparePlanToActual(clientOf(mock), { year: 2026 }, { now });
  assert.equal(c.status, "empty");
  if (c.status !== "empty") return;
  assert.match(c.reason, /realised figures \(Ist\) for 2026 are not published/);
  assert.equal(c.latestYearWithActuals, 2024);
  assert.ok(mock.calls.length <= 4, "looks back two years at most");
});

test("comparePlanToActual: an element without a realised line in a year whose Ist is published says so, not 'not published'", async () => {
  const actual14of2023 = view({ year: 2023, quota: "actual", id: "14", label: "14 Bundesministerium der Verteidigung", value: 50e9 });
  const c = await comparePlanToActual(clientOf(portal([ministry14, expenses2024Actual, actual14of2023])), { year: 2024, id: "14" }, { now });
  assert.equal(c.status, "empty");
  if (c.status !== "empty") return;
  assert.match(c.reason, /no realised line \(Ist\) for element 14 in 2024/);
  assert.match(c.reason, /2024's realised figures are published/);
  assert.doesNotMatch(c.reason, /are not published/);
  assert.equal(c.latestYearWithActuals, undefined, "2024 has actuals: no earlier year is offered instead");
});

test("comparePlanToActual: below the top the labels say what the view covers, from the top of the path", async () => {
  const actual14 = view({ ...{ year: 2024, quota: "actual" as const, id: "14", label: "14 Bundesministerium der Verteidigung", value: 50287144857.59, total: 474753727609.58 }, parents: [[{ id: null, label: "Istwerte des Haushaltsjahres 2024" }]], children: [["1403", "1403 Kommandobehörden und Truppen", 19000000000]] });
  const c = await comparePlanToActual(clientOf(portal([ministry14, actual14])), { year: 2024, id: "14" });
  assert.equal(c.status, "ok");
  if (c.status !== "ok") return;
  assert.equal(c.planLabel, "Sollwerte des Haushaltsjahres 2024");
  assert.equal(c.actualLabel, "Istwerte des Haushaltsjahres 2024");
  assert.equal(c.element.id, "14");
  assert.deepEqual(c.onlyInPlan.map((r) => r.id), ["1408", "1405"]);
});

test("getBudgetTrend: one figure per year, change per year, the span with its yearly rate", async () => {
  const mock = portal([top(2021, 400e9), top(2022, 500e9), top(2023, 460e9), top(2024, 480e9)]);
  const t = await getBudgetTrend(clientOf(mock), { fromYear: 2021, toYear: 2024 }, { now });
  assert.equal(t.status, "ok");
  if (t.status !== "ok") return;
  assert.deepEqual(t.points.map((p) => ("value" in p ? [p.year, p.value, p.changePercent] : [p.year])), [[2021, 400e9, undefined], [2022, 500e9, 25], [2023, 460e9, -8], [2024, 480e9, 4.3]]);
  assert.deepEqual(t.span, { from: 2021, to: 2024, changePercent: 20, perYearPercent: 6.3 });
  assert.equal(mock.calls.length, 4, "one request per year");
});

test("getBudgetTrend: a change of a negative figure has the sign of its direction (a rise from -10 bn to -5 bn is +50 %)", async () => {
  const g9 = (year: number, value: number) => view({ year, unit: "group", id: "G-9", label: "9 Besondere Finanzierungsausgaben", value });
  const mock = portal([g9(2020, -10e9), g9(2021, -5e9), g9(2022, -12e9)]);
  const t = await getBudgetTrend(clientOf(mock), { fromYear: 2020, toYear: 2022, id: "G-9" }, { now });
  assert.equal(t.status, "ok");
  if (t.status !== "ok") return;
  assert.deepEqual(t.points.map((p) => ("value" in p ? p.changePercent : null)), [undefined, 50, -140]);
});

test("getBudgetTrend: a year without the element is a gap with its reason, not a zero and not the end; a rename is a break", async () => {
  const mock = portal([ministry12(2022, 36e9), ministry12(2024, 44e9), ministry12(2025, 38e9)]);
  const t = await getBudgetTrend(clientOf(mock), { fromYear: 2022, toYear: 2025, id: "12" }, { now });
  assert.equal(t.status, "ok");
  if (t.status !== "ok") return;
  assert.deepEqual(t.gaps, [2023]);
  const gap = t.points[1];
  assert.ok(gap !== undefined && "gap" in gap && /No budget element 12 in 2023/.test(gap.gap));
  const after = t.points[2];
  assert.ok(after !== undefined && "value" in after && after.changePercent === undefined, "no change across a gap");
  assert.deepEqual(t.breaks, [2025]);
  const renamed = t.points[3];
  assert.ok(renamed !== undefined && "value" in renamed && renamed.renamedFrom === "12 Bundesministerium für Digitales und Verkehr");
  assert.equal(t.element.label, "12 Bundesministerium für Verkehr");
});

test("getBudgetTrend: by default from 2012 to next year; a year after the current one is the draft; years without Ist are gaps", async () => {
  const mock = portal([top(2026, 520e9), top(2027, 530e9)]);
  const t = await getBudgetTrend(clientOf(mock), {}, { now });
  assert.equal(t.status, "ok");
  if (t.status !== "ok") return;
  assert.equal(t.points.length, 2027 - 2012 + 1);
  const draft = t.points.at(-1);
  assert.ok(draft !== undefined && "value" in draft && draft.draft === true);
  const actual = await getBudgetTrend(clientOf(portal([top(2024, 470e9, "actual")])), { fromYear: 2024, toYear: 2025, quota: "actual" }, { now });
  assert.equal(actual.status, "ok");
  if (actual.status === "ok") assert.deepEqual(actual.gaps, [2025]);
});

test("getBudgetTrend: a year past next year is refused before any request, naming the argument and the latest year", async () => {
  const mock = portal([top(2026, 520e9), top(2027, 530e9)]);
  await assert.rejects(
    getBudgetTrend(clientOf(mock), { fromYear: 2026, toYear: 2030 }, { now }),
    (err) => err instanceof HaushaltValidationError && /toYear 2030/.test(err.message) && /2012 and 2027/.test(err.message),
  );
  await assert.rejects(getBudgetTrend(clientOf(mock), { fromYear: 2011, toYear: 2013 }, { now }), (err) => err instanceof HaushaltValidationError && /fromYear 2011/.test(err.message));
  assert.equal(mock.calls.length, 0, "nothing sent");
});

test("getBudgetTrend: no year with the figure is empty; reversed years and a server error are errors", async () => {
  const none = await getBudgetTrend(clientOf(portal([])), { fromYear: 2023, toYear: 2024, id: "24" }, { now });
  assert.equal(none.status, "empty");
  await assert.rejects(getBudgetTrend(clientOf(portal([])), { fromYear: 2024, toYear: 2023 }), HaushaltValidationError);
  const broken = portal([top(2023, 1)], { [viewKey(2024)]: jsonResponse({ message: "boom" }, 500) });
  await assert.rejects(getBudgetTrend(clientOf(broken), { fromYear: 2023, toYear: 2024 }), HaushaltApiError);
});

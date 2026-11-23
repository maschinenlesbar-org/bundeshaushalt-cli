// This server's tools against a mock of the budget portal, with the skills' traps as cases: rows
// ranked whatever the API's order, a leaf is an amount with its cross-references (not "no
// breakdown"), missing realised figures are "not published" with the latest year that has them
// (never a comparison against nothing), a trend keeps gaps and marks renames. The rules every
// server follows are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { EMPTY_ELEMENT, expenses2024, expenses2024Actual, ministry12, ministry14, portal, titel140555408, view, viewKey } from "./helpers.js";

const top = (year: number, value: number, quota: "target" | "actual" = "target") =>
  view({ year, quota, label: `${quota === "target" ? "Sollwerte" : "Istwerte"} des Haushaltsjahres ${year}`, value });
const world = portal([expenses2024, expenses2024Actual, ministry14, titel140555408, ministry12(2023, 40e9), ministry12(2025, 38e9)], {
  [viewKey(2024, "expenses", "target", "group", "G-1")]: EMPTY_ELEMENT,
});

test("four tools: the three use cases first, then the generic one", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["getBudgetBreakdown", "comparePlanToActual", "getBudgetTrend", "getBudgetData"]);
});

test("getBudgetBreakdown: ranked rows with shares and the rest summed; the source is the request", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("getBudgetBreakdown", { year: 2024, limit: 3 });
  const answer = result.structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "ok", result.content[0]?.text);
  assert.deepEqual((answer["rows"] as { id: string }[]).map((r) => r.id), ["11", "14", "12"]);
  assert.deepEqual(answer["rest"], { count: 1, value: 39571791000 });
  assert.equal(answer["rowsAre"], "Einzelplan");
  assert.match(String(answer["source"]), /\/internalapi\/budgetData\?year=2024&account=expenses$/);
  assert.match(String(answer["licence"]), /Bundesministerium der Finanzen/);
  await connection.close();
});

test("getBudgetBreakdown under a small size cap: the rows it drops are still counted (listed), so listed + rest is the element's value", async () => {
  const children: [string, string, number][] = Array.from({ length: 140 }, (_, i) => [`6002${String(i).padStart(5, "0")}`, `${i} ${"Zuweisung an die Länder für Maßnahmen ".repeat(4)}`.slice(0, 165), 1e9 - i * 1e6]);
  const total = children.reduce((a, [, , value]) => a + value, 0);
  const kapitel = view({ year: 2024, id: "6002", label: "6002 Allgemeine Bewilligungen", value: total, children });
  const connection = await connect({ transport: portal([kapitel]), config: { maxResultChars: 8000 } });
  const answer = (await connection.call("getBudgetBreakdown", { year: 2024, id: "6002", limit: 100 })).structuredContent as Record<string, unknown>;
  await connection.close();
  const rows = answer["rows"] as { value: number }[];
  const listed = answer["listed"] as { count: number; value: number };
  const rest = answer["rest"] as { count: number; value: number };
  assert.equal(answer["truncated"], true);
  assert.ok(rows.length < 100, `the cap dropped rows (${rows.length})`);
  assert.equal(listed.count, 100);
  assert.equal(listed.count + rest.count, 140);
  assert.equal(Math.round(listed.value + rest.value), total, "nothing is in neither");
  assert.match(String(answer["reason"]), /rows lost entries/);
});

test("getBudgetBreakdown: a leaf is its amount, path, cross-references and PDF page", async () => {
  const connection = await connect({ transport: world });
  const answer = (await connection.call("getBudgetBreakdown", { year: 2024, id: "140555408" })).structuredContent as Record<string, unknown>;
  assert.equal(answer["leaf"], true);
  assert.deepEqual(answer["rows"], []);
  assert.deepEqual((answer["element"] as { path: { id: string }[] }).path.map((p) => p.id), ["14", "1405", "140555408"]);
  assert.ok((answer["related"] as Record<string, unknown>)["function"]);
  await connection.close();
});

test("getBudgetBreakdown: an id answered with an empty element is empty with a reason; the source carries the unit the id implies", async () => {
  const connection = await connect({ transport: world });
  const answer = (await connection.call("getBudgetBreakdown", { year: 2024, id: "G-1" })).structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "empty");
  assert.match(String(answer["reason"]), /No budget element G-1 in 2024/);
  assert.match(String(answer["source"]), /unit=group&id=G-1$/);
  await connection.close();
});

test("getBudgetBreakdown: a G- id with the wrong unit is a tool error saying so, before any request", async () => {
  const connection = await connect({ transport: world });
  const before = world.calls.length;
  const result = await connection.call("getBudgetBreakdown", { year: 2024, id: "G-6", unit: "single" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /G-6/);
  assert.equal(world.calls.length, before);
  await connection.close();
});

test("comparePlanToActual: deltas with cents, both ends, one-sided elements apart", async () => {
  const connection = await connect({ transport: world });
  const answer = (await connection.call("comparePlanToActual", { year: 2024 })).structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "ok");
  assert.deepEqual((answer["overspent"] as { id: string }[]).map((r) => r.id), ["11", "12"]);
  assert.deepEqual((answer["underspent"] as { id: string; delta: number }[]).map((r) => [r.id, r.delta]), [["14", -1664793142.41]]);
  assert.deepEqual((answer["onlyInPlan"] as { id: string }[]).map((r) => r.id), ["32"]);
  assert.deepEqual((answer["onlyInActual"] as { id: string }[]).map((r) => r.id), ["60"]);
  assert.match(String(answer["source"]), /quota=target%2Cactual/);
  await connection.close();
});

test("comparePlanToActual: a year without Ist is empty, 'not published', with the latest year that has it", async () => {
  const transport = portal([top(2025, 500e9), top(2024, 470e9), top(2024, 468e9, "actual")]);
  const connection = await connect({ transport });
  const answer = (await connection.call("comparePlanToActual", { year: 2025 })).structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "empty");
  assert.match(String(answer["reason"]), /Ist\) for 2025 are not published/);
  assert.equal(answer["latestYearWithActuals"], 2024);
  await connection.close();
});

test("getBudgetTrend: by id across a gap and a rename", async () => {
  const connection = await connect({ transport: world });
  const answer = (await connection.call("getBudgetTrend", { fromYear: 2023, toYear: 2025, id: "12" })).structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "ok");
  assert.deepEqual(answer["gaps"], [2024]);
  assert.deepEqual(answer["breaks"], [2025]);
  assert.deepEqual(answer["span"], { from: 2023, to: 2025, changePercent: -5, perYearPercent: -2.5 });
  assert.match(String(answer["source"]), /year=2023\.\.2025&account=expenses&id=12$/);
  await connection.close();
});

test("getBudgetData: the view as sent, children paged, the path instead of every level's siblings", async () => {
  const connection = await connect({ transport: world });
  const answer = (await connection.call("getBudgetData", { year: 2024, id: "14", limit: 2 })).structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "ok");
  assert.equal(answer["total"], 3);
  assert.equal((answer["children"] as unknown[]).length, 2);
  assert.equal(answer["nextOffset"], 2);
  assert.deepEqual((answer["path"] as { id: string }[]).map((p) => p.id), ["14"]);
  const missing = (await connection.call("getBudgetData", { year: 2024, id: "99" })).structuredContent as Record<string, unknown>;
  assert.equal(missing["status"], "empty");
  await connection.close();
});

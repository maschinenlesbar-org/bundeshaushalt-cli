import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeshaushaltClient } from "../src/client/client.js";
import { HaushaltApiError, HaushaltError, HaushaltParseError } from "../src/client/errors.js";
import type { BudgetData, BudgetParams } from "../src/client/types.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): BundeshaushaltClient {
  return new BundeshaushaltClient({ transport: mt.transport });
}

const body = { meta: {}, detail: {}, children: [] };

test("budgetData sends year + account", async () => {
  const mt = constantJson(body);
  await clientWith(mt).budgetData({ year: 2024, account: "expenses" });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, "/internalapi/budgetData");
  assert.equal(url.searchParams.get("year"), "2024");
  assert.equal(url.searchParams.get("account"), "expenses");
});

test("budgetData includes optional quota/unit/id only when set", async () => {
  const mt = constantJson(body);
  await clientWith(mt).budgetData({ year: 2023, account: "income", unit: "group", id: "G-" });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("unit"), "group");
  assert.equal(url.searchParams.get("id"), "G-");
  assert.equal(url.searchParams.get("quota"), null);
});

test("a 404 raises HaushaltApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).budgetData({ year: 2024, account: "expenses" }),
    (err) => err instanceof HaushaltApiError && err.status === 404,
  );
});

test("the BudgetData type admits the live leaf and top-level shapes", () => {
  // Trimmed from live responses (expenses 2024 and --id 090168301): the top-level
  // detail has no id/budgetNumber, a leaf has no children, related is a flat list
  // per grouping and the root in parents has id null. Type-checked, not run.
  const top: BudgetData = {
    meta: { year: 2024, account: "expenses", quota: "target", unit: "single" },
    detail: { label: "Sollwerte des Haushaltsjahres 2024", value: 476807656000, relativeValue: 100, relativeToParentValue: 100 },
    children: [],
  };
  const leaf: BudgetData = {
    meta: { year: 2024, account: "expenses", quota: "target", unit: "single" },
    detail: {
      id: "090168301",
      budgetNumber: "0901 683 01 - 165",
      label: "0901 683 01 Zentrales Innovationsprogramm Mittelstand (ZIM)",
      value: 635315000,
      relativeValue: 0.13324345614114888,
      relativeToParentValue: 13.981840981826457,
      pdf: ["http://www.bundeshaushalt.de/static/daten/2024/soll/epl09.pdf#page=9"],
    },
    parents: [[{ id: null, label: "Sollwerte des Haushaltsjahres 2024" }]],
    related: { agency: [{ id: "09", label: "09 Bundesministerium für Wirtschaft und Klimaschutz" }] },
  };
  assert.equal(leaf.children, undefined);
  assert.equal(leaf.related?.agency?.[0]?.id, "09");
  assert.equal(top.children?.length, 0);
});

test("numeric engine options must be integers in range; a bad one throws instead of disabling a limit", () => {
  const bad: [string, number][] = [
    ["timeoutMs", -1],
    ["timeoutMs", Number.NaN],
    ["timeoutMs", 1.5],
    ["timeoutMs", 2_147_483_648],
    ["maxRetries", -1],
    ["maxRetries", Number.POSITIVE_INFINITY],
    ["maxRetries", 11],
    ["retryDelayMs", -1],
    ["retryDelayMs", 30_001],
    ["maxRedirects", -1],
    ["maxRedirects", Number.NaN],
    ["maxRedirects", 21],
    ["maxResponseBytes", -1],
    ["maxResponseBytes", 0.5],
  ];
  for (const [name, value] of bad) {
    assert.throws(
      () => new BundeshaushaltClient({ [name]: value }),
      (e: unknown) =>
        e instanceof HaushaltError &&
        new RegExp(`^Invalid option ${name}: expected an integer from 0 to \\d+, got `).test(e.message),
      `${name}=${value}`,
    );
  }
  for (const [name, value] of [
    ["timeoutMs", 0],
    ["timeoutMs", 2_147_483_647],
    ["maxRetries", 10],
    ["retryDelayMs", 0],
    ["maxRedirects", 0],
    ["maxResponseBytes", 0],
  ] as const) {
    assert.doesNotThrow(() => new BundeshaushaltClient({ [name]: value }), `${name}=${value}`);
  }
});

test("budgetData checks its params before any request", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ year: 1999, account: "expenses" }, /^Invalid year 1999: expected an integer from 2012 on\.$/],
    [{ year: 2024.5, account: "expenses" }, /^Invalid year 2024\.5/],
    [{ year: 2024, account: "bogus" }, /^Invalid account "bogus": expected one of expenses, income\.$/],
    [{ year: 2024, account: "expenses", quota: "nope" }, /^Invalid quota "nope"/],
    [{ year: 2024, account: "expenses", unit: "x" }, /^Invalid unit "x"/],
    [{ year: 2024, account: "expenses", id: " " }, /^Invalid id " ": expected a non-empty budget number\.$/],
  ];
  for (const [params, message] of cases) {
    const mt = constantJson(body);
    await assert.rejects(
      () => clientWith(mt).budgetData(params as unknown as BudgetParams),
      (e: unknown) => e instanceof HaushaltError && message.test(e.message),
      JSON.stringify(params),
    );
    assert.equal(mt.calls.length, 0, JSON.stringify(params));
  }
});

test("a 2xx body without the meta/detail envelope raises HaushaltParseError", async () => {
  for (const bad of [null, [1, 2], "x", 5, {}, { meta: {} }, { meta: null, detail: {} }, { meta: {}, detail: [] }]) {
    const mt = constantJson(bad);
    await assert.rejects(
      () => clientWith(mt).budgetData({ year: 2024, account: "expenses" }),
      (e: unknown) =>
        e instanceof HaushaltParseError &&
        e.message ===
          "Unexpected response shape from /internalapi/budgetData: expected a JSON object with meta and detail.",
      JSON.stringify(bad),
    );
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeshaushaltClient } from "../src/client/client.js";
import { HaushaltApiError } from "../src/client/errors.js";
import type { BudgetData } from "../src/client/types.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): BundeshaushaltClient {
  return new BundeshaushaltClient({ transport: mt.transport });
}

const body = { meta: {}, details: {}, children: [] };

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

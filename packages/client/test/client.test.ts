import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeshaushaltClient } from "../src/client.js";
import { HaushaltApiError, HaushaltError, HaushaltNotFoundError, HaushaltParseError } from "../src/errors.js";
import type { BudgetData, BudgetParams } from "../src/types.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): BundeshaushaltClient {
  return new BundeshaushaltClient({ transport: mt.transport });
}

const body = { meta: {}, detail: { label: "Sollwerte" }, children: [] };

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
  await clientWith(mt).budgetData({ year: 2023, account: "income", unit: "group", id: "G-5" });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("unit"), "group");
  assert.equal(url.searchParams.get("id"), "G-5");
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
    [{ year: 1999, account: "expenses" }, /^Invalid year 1999: Expected a year between 2012 and \d{4}\.$/],
    [{ year: 2024.5, account: "expenses" }, /^Invalid year 2024\.5/],
    [{ year: 9999, account: "expenses" }, /^Invalid year 9999: Expected a year between 2012 and \d{4}\.$/],
    [{ year: 2024, account: "bogus" }, /^Invalid account "bogus": expected one of expenses, income\.$/],
    [{ year: 2024, account: "expenses", quota: "nope" }, /^Invalid quota "nope"/],
    [{ year: 2024, account: "expenses", unit: "x" }, /^Invalid unit "x"/],
    [{ year: 2024, account: "expenses", id: " " }, /^Invalid id: Expected a non-empty value\.$/],
    [{ year: 2024, account: "expenses", id: "1\u200b4" }, /^Invalid id: "1\\u200b4" contains an invisible or control character \(U\+200B\)\.$/],
    [{ year: 2024, account: "expenses", id: 1405 }, /^Invalid id 1405: Expected a string/],
    [{ year: 2024, account: "expenses", id: "g-" }, /^Invalid id: Expected a number after the "G-" prefix, e\.g\. "G-5"\.$/],
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
          "GET https://bundeshaushalt.de/internalapi/budgetData?year=2024&account=expenses: unexpected response shape: expected a JSON object with meta and detail.",
      JSON.stringify(bad),
    );
  }
});

test("the library quotes a rejected id at most 200 characters long, redacted before the cut (L3)", async () => {
  const mt = constantJson(body);
  const client = clientWith(mt);
  await assert.rejects(client.budgetData({ year: 2024, account: "expenses", unit: "group", id: `1${"9".repeat(5000)}` }), (err: Error) => {
    assert.ok(err.message.length < 400, `${err.message.length}`);
    assert.match(err.message, /^Invalid id "19+"… for unit group/);
    return true;
  });
  await assert.rejects(client.budgetData({ year: 2024, account: "expenses", unit: "group", id: `https://u:${"p".repeat(300)}@h.example` }), (err: Error) => {
    assert.ok(!err.message.includes("ppp"), err.message.slice(0, 200));
    return true;
  });
  assert.equal(mt.calls.length, 0);
});

test("a refused value is quoted visibly: format, control and half characters escaped, never raw (D10)", async () => {
  const cases: Array<[Partial<BudgetParams>, string]> = [
    [{ account: "expen​ses" as BudgetParams["account"] }, 'Invalid account "expen\\u200bses": expected one of expenses, income.'],
    [{ quota: "tar‮get" as BudgetParams["quota"] }, 'Invalid quota "tar\\u202eget": expected one of target, actual.'],
    [{ unit: "gro­up" as BudgetParams["unit"] }, 'Invalid unit "gro\\u00adup": expected one of single, function, group.'],
    [{ unit: "x\u0085\ud800" as BudgetParams["unit"] }, 'Invalid unit "x\\u0085\\ud800": expected one of single, function, group.'],
  ];
  for (const [params, message] of cases) {
    const mt = constantJson(body);
    await assert.rejects(
      () => clientWith(mt).budgetData({ year: 2024, account: "expenses", ...params } as BudgetParams),
      (e: unknown) => e instanceof HaushaltError && e.message === message,
      message,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("an id is sent as a token: trimmed and in composed Unicode (D8)", async () => {
  for (const [id, sent] of [[" 14 ", "14"], ["0901\n", "0901"], ["\tG-5", "G-5"]] as const) {
    const mt = constantJson({ meta: {}, detail: { label: "x" } });
    await clientWith(mt).budgetData({ year: 2024, account: "expenses", id });
    assert.equal(new URL(mt.last().url).searchParams.get("id"), sent, JSON.stringify(id));
  }
  const mt = constantJson({ meta: {}, detail: { label: "x" } });
  await clientWith(mt).budgetData({ year: 2024, account: "expenses", id: " G-5 " });
  assert.equal(new URL(mt.last().url).searchParams.get("unit"), "group");
});

test("an id the API answers with an empty element (HTTP 200, detail {}) is a HaushaltNotFoundError, never a result (Bug 2)", async () => {
  // As the live portal answered `--id G-1` on the expenses side (an income group) and `--id G-05`
  // (all of meta null): 200, an empty detail, no children.
  const parents = [[{ id: null, label: "Sollwerte des Haushaltsjahres 2024" }], [{ id: "G-6", label: "6 Ausgaben für Zuweisungen" }]];
  const answers: Array<[string, unknown]> = [
    ["G-1", { meta: { year: 2024, unit: "group", account: "expenses", levelCur: 1, levelMax: 4 }, detail: {}, parents }],
    ["G-05", { meta: { year: null, unit: null, account: null, levelCur: null, levelMax: null }, detail: {}, parents }],
  ];
  for (const [id, answer] of answers) {
    const mt = constantJson(answer);
    await assert.rejects(
      () => clientWith(mt).budgetData({ year: 2024, account: "expenses", id }),
      (e: unknown) =>
        e instanceof HaushaltNotFoundError &&
        e.id === id &&
        e.message ===
          `GET https://bundeshaushalt.de/internalapi/budgetData?year=2024&account=expenses&unit=group&id=${id}: ` +
            `no budget element ${JSON.stringify(id)}: the API answered with an empty element.`,
      id,
    );
    assert.equal(mt.calls.length, 1, id);
  }
  // Without an id the answer is the year's top level, never looked up: an empty detail stays as it is.
  const top = await clientWith(constantJson({ meta: {}, detail: {} })).budgetData({ year: 2024, account: "expenses" });
  assert.deepEqual(top.detail, {});
  // An element that exists has a detail.
  const found = await clientWith(constantJson({ meta: {}, detail: { label: "Einzelplan", value: 1 } })).budgetData({ year: 2024, account: "expenses", id: "14" });
  assert.equal(found.detail.label, "Einzelplan");
});

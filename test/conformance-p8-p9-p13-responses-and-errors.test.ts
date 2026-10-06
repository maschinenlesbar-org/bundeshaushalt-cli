// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { BundeshaushaltClient as Client } from "../src/client/client.js";
import {
  HaushaltError as BaseError,
  HaushaltParseError as ParseError,
  HaushaltValidationError as ValidationError,
} from "../src/client/errors.js";
import type { BudgetParams } from "../src/client/types.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.budgetData({ year: 2024, account: "expenses" });
const textBody = (text: string): unknown => ({ meta: {}, detail: { label: text } });
const readText = (result: unknown): string => (result as { detail: { label: string } }).detail.label;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  null, {}, [], "text", 42, { meta: {} }, { detail: {} }, { error: "boom" }, { meta: null, detail: {} },
  { meta: {}, detail: [] }, { meta: "x", detail: {} },
];
const budget = (params: unknown) => () => new Client().budgetData(params as BudgetParams);
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["budgetData(undefined)", budget(undefined)],
  ["budgetData(null)", budget(null)],
  ["year '2023'", budget({ year: "2023", account: "income" })],
  ["year NaN", budget({ year: Number.NaN, account: "income" })],
  ["year 2024.5", budget({ year: 2024.5, account: "income" })],
  ["year 2011", budget({ year: 2011, account: "income" })],
  ["account 'income '", budget({ year: 2023, account: "income " })],
  ["account 5", budget({ year: 2023, account: 5 })],
  ["quota null", budget({ year: 2023, account: "income", quota: null })],
  ["quota 'ist'", budget({ year: 2023, account: "income", quota: "ist" })],
  ["unit 'groups'", budget({ year: 2023, account: "income", unit: "groups" })],
  ["id 1405", budget({ year: 2023, account: "income", id: 1405 })],
  ["id ''", budget({ year: 2023, account: "income", id: "" })],
  ["id 'G-'", budget({ year: 2023, account: "income", id: "G-" })],
  ["id 'G-5' unit function", budget({ year: 2023, account: "income", id: "G-5", unit: "function" })],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["maxRedirects: 21", () => new Client({ maxRedirects: 21 })],
  ["retryDelayMs: Infinity", () => new Client({ retryDelayMs: Number.POSITIVE_INFINITY })],
  ["maxResponseBytes: -5", () => new Client({ maxResponseBytes: -5 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["baseUrl: {}", () => new Client({ baseUrl: {} as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as never })],
  ["sleep: 1", () => new Client({ sleep: 1 as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});

test("P13: a wrong-typed year or id gets a message naming the type, not one that looks valid", async () => {
  await assert.rejects(budget({ year: "2023", account: "income" })(), (e: unknown) => {
    assert.ok(e instanceof ValidationError);
    assert.equal(e.message, 'Invalid year "2023": Expected a number, got a string.');
    return true;
  });
  await assert.rejects(budget({ year: 2023, account: "income", id: 1405 })(), (e: unknown) => {
    assert.ok(e instanceof ValidationError);
    assert.match(e.message, /^Invalid id 1405: Expected a string .*got a number\.$/);
    return true;
  });
});

test("P13: an unparseable redirect Location is a network error naming the request", async () => {
  const { HaushaltNetworkError } = await import("../src/client/errors.js");
  for (const location of ["http://[::1", "http://exa mple.com:99999/x"]) {
    const client = new Client({
      transport: async () => ({ status: 302, headers: { location }, body: Buffer.alloc(0) }),
      maxRetries: 0,
    });
    await assert.rejects(textCall(client), (e: unknown) => {
      assert.ok(e instanceof HaushaltNetworkError, String(e));
      assert.match(e.message, /^Invalid redirect Location ".*" for GET https:\/\/bundeshaushalt\.de\//);
      return true;
    });
  }
});

test("P13: server text in a message is cut at 500 characters", async () => {
  const detail = "x".repeat(200_000);
  const client = new Client({
    transport: async () => ({ status: 500, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ detail })) }),
    maxRetries: 0,
  });
  await assert.rejects(textCall(client), (e: unknown) => e instanceof BaseError && e.message.length < 700 && e.message.endsWith("…"));
});

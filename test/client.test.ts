import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeshaushaltClient } from "../src/client/client.js";
import { HaushaltApiError } from "../src/client/errors.js";
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

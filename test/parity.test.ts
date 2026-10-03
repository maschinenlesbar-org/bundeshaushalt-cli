// CLI <-> library parity: the same input through run() and through the library
// on one recording mock transport must give the same outcome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeshaushaltClient } from "../src/client/client.js";
import { HaushaltValidationError } from "../src/client/errors.js";
import { assertParity, parity } from "./helpers.js";

test("parity control: a valid query sends the identical request from CLI and library", async () => {
  const p = await parity(["--compact", "expenses", "2024", "--id", "14"], (transport) =>
    new BundeshaushaltClient({ transport }).budgetData({ year: 2024, account: "expenses", id: "14" }),
  );
  assertParity(p, "expenses 2024 --id 14");
});

test("an id with surrounding whitespace or a bare G-/F- prefix is rejected by CLI and library alike, before any request", async () => {
  const cases: [string, string | undefined][] = [
    ["G-", "group"],
    ["f-", undefined],
    [" 14 ", undefined],
    ["14\n", undefined],
  ];
  for (const [id, unit] of cases) {
    const argv = ["--compact", "--max-retries", "0", "expenses", "2024", "--id", id, ...(unit ? ["--unit", unit] : [])];
    const p = await parity(argv, (transport) =>
      new BundeshaushaltClient({ transport, maxRetries: 0 }).budgetData({
        year: 2024,
        account: "expenses",
        id,
        ...(unit ? { unit: unit as "group" } : {}),
      }),
    );
    assertParity(p, JSON.stringify(id));
    assert.equal(p.cli.code, 1, JSON.stringify(id));
    assert.equal(p.lib.requests.length, 0, JSON.stringify(id));
    assert.ok(!p.lib.ok && p.lib.error instanceof HaushaltValidationError, JSON.stringify(id));
    assert.deepEqual(p.cli.err, [`Error: ${(p.lib.error as Error).message}`], JSON.stringify(id));
  }
});

test("a G-/F- id sets the unit when it is omitted, in CLI and library alike", async () => {
  const cases: [string, "expenses" | "income", string | null][] = [
    ["G-5", "expenses", "group"],
    ["g-5", "expenses", "group"],
    ["F-0", "expenses", "function"],
    ["F-0", "income", "function"],
    ["14", "expenses", null],
  ];
  for (const [id, account, unit] of cases) {
    const p = await parity(["--compact", "budget", "2024", account, "--id", id], (transport) =>
      new BundeshaushaltClient({ transport }).budgetData({ year: 2024, account, id }),
    );
    assertParity(p, `${account} ${id}`);
    assert.equal(new URL(p.lib.requests[0]!.url).searchParams.get("unit"), unit, `${account} ${id}`);
  }
});

test("an id whose prefix contradicts the unit is rejected by CLI and library alike, before any request", async () => {
  const cases: [string, "single" | "function" | "group", string][] = [
    ["14", "group", 'Invalid id "14" for unit group: Expected an id starting with "G-" (e.g. "G-5").'],
    ["14", "function", 'Invalid id "14" for unit function: Expected an id starting with "F-" (e.g. "F-0").'],
    ["G-5", "function", 'Invalid id "G-5" for unit function: A "G-" id belongs to unit group.'],
    ["G-5", "single", 'Invalid id "G-5" for unit single: A "G-" id belongs to unit group.'],
    ["F-0", "group", 'Invalid id "F-0" for unit group: A "F-" id belongs to unit function.'],
  ];
  for (const [id, unit, message] of cases) {
    const p = await parity(["--compact", "expenses", "2024", "--unit", unit, "--id", id], (transport) =>
      new BundeshaushaltClient({ transport }).budgetData({ year: 2024, account: "expenses", id, unit }),
    );
    assertParity(p, `${unit} ${id}`);
    assert.ok(!p.lib.ok && p.lib.error instanceof HaushaltValidationError, `${unit} ${id}`);
    assert.equal((p.lib.error as Error).message, message);
    assert.deepEqual(p.cli.err, [`Error: ${message}`]);
    assert.equal(p.cli.code, 1);
  }
});

test("the year range (MIN_YEAR to next year) is enforced by CLI and library alike", async () => {
  const next = new Date().getUTCFullYear() + 1;
  for (const year of [2011, 2012, next, next + 1, 2099]) {
    const p = await parity(["--compact", "--max-retries", "0", "expenses", String(year)], (transport) =>
      new BundeshaushaltClient({ transport, maxRetries: 0 }).budgetData({ year, account: "expenses" }),
    );
    assertParity(p, String(year));
    const inRange = year >= 2012 && year <= next;
    assert.equal(p.lib.ok, inRange, String(year));
    if (!inRange) {
      assert.ok(!p.lib.ok && p.lib.error instanceof HaushaltValidationError, String(year));
      assert.equal((p.lib.error as Error).message, `Invalid year ${year}: Expected a year between 2012 and ${next}.`);
      assert.deepEqual(p.cli.err, [`Error: ${(p.lib.error as Error).message}`]);
    }
  }
});

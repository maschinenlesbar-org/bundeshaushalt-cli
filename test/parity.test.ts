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

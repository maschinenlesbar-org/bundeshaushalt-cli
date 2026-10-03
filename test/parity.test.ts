// CLI <-> library parity: the same input through run() and through the library
// on one recording mock transport must give the same outcome.

import { test } from "node:test";
import { BundeshaushaltClient } from "../src/client/client.js";
import { assertParity, parity } from "./helpers.js";

test("parity control: a valid query sends the identical request from CLI and library", async () => {
  const p = await parity(["--compact", "expenses", "2024", "--id", "14"], (transport) =>
    new BundeshaushaltClient({ transport }).budgetData({ year: 2024, account: "expenses", id: "14" }),
  );
  assertParity(p, "expenses 2024 --id 14");
});

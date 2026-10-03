import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeshaushaltClient } from "../src/client/client.js";
import { HaushaltError, HaushaltValidationError } from "../src/client/errors.js";
import { assertValid, type Problem } from "../src/client/validate.js";
import * as root from "../src/index.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";

const nonEmpty: Problem<string> = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("thing", "x", nonEmpty), "x");
});

test("assertValid throws HaushaltValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("thing", " ", nonEmpty),
    (e: unknown) =>
      e instanceof HaushaltValidationError &&
      e instanceof HaushaltError &&
      e.name === "HaushaltValidationError" &&
      e.message === "Invalid thing: Expected a non-empty value.",
  );
});

test("assertValid inside an async function rejects instead of throwing synchronously", async () => {
  const check = async (v: string) => assertValid("thing", v, nonEmpty);
  const pending = check("");
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, HaushaltValidationError);
});

test("the package root exports assertValid and HaushaltValidationError", () => {
  assert.equal(root.assertValid, assertValid);
  assert.equal(root.HaushaltValidationError, HaushaltValidationError);
});

test("run() prints a HaushaltValidationError from an action as 'Error: <message>' and exits 1", async () => {
  const err: string[] = [];
  const client = new BundeshaushaltClient({
    transport: async () => {
      throw new Error("no request expected");
    },
  });
  client.budgetData = async () => {
    throw new HaushaltValidationError("Invalid thing: Expected a non-empty value.");
  };
  const deps: CliDeps = { io: { out: () => {}, err: (s) => err.push(s) }, createClient: () => client };
  assert.equal(await run(["expenses", "2024"], deps), 1);
  assert.deepEqual(err, ["Error: Invalid thing: Expected a non-empty value."]);
});

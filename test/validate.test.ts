import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeshaushaltClient } from "../src/client/client.js";
import { HaushaltError, HaushaltValidationError } from "../src/client/errors.js";
import { assertValid, idProblem, idUnitProblem, type Problem } from "../src/client/validate.js";
import { unitOfId } from "../src/client/enums.js";
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

test("idProblem: a non-blank budget number without surrounding whitespace or a bare G-/F- prefix", () => {
  for (const ok of ["14", "090168301", "G-5", "g-5", "F-0", "f-12"]) assert.equal(idProblem(ok), undefined, ok);
  assert.equal(idProblem(""), "Expected a non-empty budget number.");
  assert.equal(idProblem("  "), "Expected a non-empty budget number.");
  assert.equal(idProblem(14), "Expected a non-empty budget number.");
  assert.equal(idProblem(" 14 "), "Surrounding whitespace is not allowed.");
  assert.equal(idProblem("14\n"), "Surrounding whitespace is not allowed.");
  assert.equal(idProblem("G-"), 'Expected a number after the "G-" prefix, e.g. "G-5".');
  assert.equal(idProblem("f-"), 'Expected a number after the "F-" prefix, e.g. "F-5".');
});

test("unitOfId reads the grouping from the id prefix, case-insensitively", () => {
  for (const [id, unit] of [["G-5", "group"], ["g-5", "group"], ["F-0", "function"], ["f-12", "function"], ["14", "single"], ["090168301", "single"]] as const) {
    assert.equal(unitOfId(id), unit, id);
  }
});

test("idUnitProblem: the id prefix must match the unit", () => {
  assert.equal(idUnitProblem({ id: "G-5", unit: "group" }), undefined);
  assert.equal(idUnitProblem({ id: "f-0", unit: "function" }), undefined);
  assert.equal(idUnitProblem({ id: "14", unit: "single" }), undefined);
  assert.equal(idUnitProblem({ id: "14", unit: "group" }), 'Expected an id starting with "G-" (e.g. "G-5").');
  assert.equal(idUnitProblem({ id: "G-5", unit: "single" }), 'A "G-" id belongs to unit group.');
});

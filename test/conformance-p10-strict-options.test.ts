// Conformance test P10 (fix plan 2026-10-06, decision 5): a parameter the API would ignore
// never goes out. The library rejects unknown option keys and wrong value types instead of
// ignoring them, and the CLI rejects a repeated single-value flag instead of keeping the
// last. bundeshaushalt has no filter syntax, only budgetData's params object, so this
// follows reisewarnungen-cli's strict-options test (its own option objects) plus the
// repeated-flag case of the shared marktstammdatenregister-cli test.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { BundeshaushaltClient as Client } from "../src/client/client.js";
import { HaushaltValidationError as ValidationError } from "../src/client/errors.js";
import type { BudgetParams } from "../src/client/types.js";
const okBody = { meta: {}, detail: {} };
const call = (c: Client, params: unknown): Promise<unknown> => c.budgetData(params as BudgetParams);
/** Calls whose params must be rejected before any request. */
const badCalls: Array<[string, unknown]> = [
  ["misspelt id", { year: 2024, account: "expenses", Id: "14" }],
  ["padded key", { year: 2024, account: "expenses", "id ": "14" }],
  ["unknown key", { year: 2024, account: "expenses", filter: "14" }],
  ["__proto__ key", JSON.parse('{"year": 2024, "account": "expenses", "__proto__": {"id": "14"}}')],
  ["constructor key", { year: 2024, account: "expenses", constructor: "14" }],
  ["null params", null],
  ["array params", [2024, "expenses"]],
  ["id as an array", { year: 2024, account: "expenses", id: ["14", "06"] }],
  ["year as an array", { year: [2024], account: "expenses" }],
  ["year NaN", { year: Number.NaN, account: "expenses" }],
  ["quota as an array", { year: 2024, account: "expenses", quota: ["target"] }],
];
/** Client options that must be rejected by the constructor. */
const badOptions: unknown[] = [{ timeout: 5 }, { baseurl: "https://h.example" }, JSON.parse('{"__proto__": {}}'), "https://h.example"];
/** Single-value flags given twice: each must be a usage error, before any request. */
const REPEATED_SINGLE_ARGVS: string[][] = [
  ["expenses", "2024", "--id", "14", "--id", "06"],
  ["expenses", "2024", "--quota", "target", "--quota", "actual"],
  ["income", "2024", "--unit", "group", "--unit", "function"],
  ["--timeout", "5000", "--timeout", "0", "expenses", "2024"],
  ["--base-url", "https://a.example", "expenses", "2024", "--base-url", "https://b.example"],
];
const USAGE_EXIT = 1;
// --------------------------------------------------------------------------------------

function client(): { c: Client; requests: () => number; transport: () => Promise<HttpResponse> } {
  let n = 0;
  const transport = async (): Promise<HttpResponse> => {
    n++;
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(okBody)) };
  };
  return { c: new Client({ transport }), requests: () => n, transport };
}

test("P10: unknown param keys and wrong value types are rejected before any request", async () => {
  for (const [label, params] of badCalls) {
    const { c, requests } = client();
    await assert.rejects(call(c, params), ValidationError, label);
    assert.equal(requests(), 0, label);
  }
  // A key set to undefined (a spread config) changes nothing.
  const { c, requests } = client();
  await call(c, { year: 2024, account: "expenses", id: undefined, quota: undefined });
  assert.equal(requests(), 1);
});

test("P10: the client constructor rejects unknown option keys", () => {
  for (const options of badOptions) {
    assert.throws(() => new Client(options as never), ValidationError, JSON.stringify(options));
  }
  assert.doesNotThrow(() => new Client({ timeoutMs: undefined }));
  assert.doesNotThrow(() => new Client(null as never));
});

test("P10: a misspelt key names the right one", async () => {
  const { c } = client();
  await assert.rejects(call(c, { year: 2024, account: "expenses", Id: "14" }), /did you mean id\?/);
  assert.throws(() => new Client({ timeout: 5 } as never), /did you mean timeoutMs\?/);
});

test("P10: a repeated single-value flag is a usage error, not 'last one wins'", async () => {
  for (const argv of REPEATED_SINGLE_ARGVS) {
    const { transport, requests } = client();
    const err: string[] = [];
    const deps: CliDeps = {
      io: { out: () => {}, err: (s) => err.push(s) },
      createClient: (opts) => new Client({ ...opts, transport }),
    };
    const code = await run(argv, deps);
    assert.equal(code, USAGE_EXIT, `${argv.join(" ")}: ${err.join("\n")}`);
    assert.match(err.join("\n"), /was given more than once/, argv.join(" "));
    assert.equal(requests(), 0, argv.join(" "));
  }
});

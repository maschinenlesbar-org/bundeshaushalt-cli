import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { BundeshaushaltClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

const body = { meta: {}, details: {}, children: [] };

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new BundeshaushaltClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("budget <year> <account> builds the query", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["budget", "2024", "expenses"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("year"), "2024");
  assert.equal(url.searchParams.get("account"), "expenses");
});

test("expenses shortcut presets the account", async () => {
  const cli = makeCli(() => jsonResponse(body));
  await run(["expenses", "2023", "--unit", "function"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("account"), "expenses");
  assert.equal(url.searchParams.get("unit"), "function");
});

test("rejects an invalid account before any request", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["budget", "2024", "spending"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid account/);
});

test("rejects a year before 2012", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["budget", "1999", "expenses"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid year/);
});

test("rejects an invalid unit", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["budget", "2024", "expenses", "--unit", "department"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("income shortcut presets account=income", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["income", "2024"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("account"), "income");
});

test("rejects a non-Latin-1 --user-agent with a clear message before any request", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["--user-agent", "🌦", "expenses", "2024"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid User-Agent/);
});

test("rejects a numeric option above MAX_SAFE_INTEGER", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["--timeout", "99999999999999999999", "expenses", "2024"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /no greater than/);
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["income", "2024"], cli.deps);
  assert.equal(code, 4);
});

test("rejects a year above the upper bound before any request", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["budget", "9999", "expenses"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid year/);
});

test("rejects a non-four-digit year before any request", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["budget", "999999", "expenses"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid year/);
});

test("accepts MIN_YEAR (the lower boundary)", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["budget", "2012", "expenses"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("year"), "2012");
});

test("--id reaches the query", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["budget", "2024", "expenses", "--id", "G-123"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("id"), "G-123");
});

test("rejects an empty --id before any request", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["budget", "2024", "expenses", "--id", "  "], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid id/);
});

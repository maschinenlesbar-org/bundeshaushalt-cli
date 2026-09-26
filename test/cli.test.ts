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

test("a valid --quota reaches the query", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["expenses", "2024", "--quota", "actual"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("quota"), "actual");
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

test("subcommand help lists the global options that apply to it", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["help", "expenses"], cli.deps);
  assert.equal(code, 0);
  const help = cli.out.join("\n");
  assert.match(help, /Global Options:/);
  assert.match(help, /--base-url/);
  assert.match(help, /--user-agent/);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { ...body, meta: { label: `Bund${controls}`, unit: String.fromCharCode(0x1b) + "[31m" } };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "budget", "2024", "expenses"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Bund\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
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

test("--timeout accepts up to the largest timer Node supports and rejects more", async () => {
  const { MAX_TIMEOUT_MS } = await import("../src/client/index.js");
  assert.equal(MAX_TIMEOUT_MS, 2_147_483_647);

  const cli = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--timeout", "2147483647", "expenses", "2024"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(body));
  assert.notEqual(await run(["--timeout", "2147483648", "expenses", "2024"], over.deps), 0);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /2147483647/);
});

test("rejects a non-http(s) or malformed --base-url at parse time, before any request", async () => {
  for (const bad of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
    const cli = makeCli(() => jsonResponse(body));
    const code = await run(["--base-url", bad, "expenses", "2024"], cli.deps);
    assert.notEqual(code, 0, `${bad} should be rejected`);
    assert.equal(cli.mt.calls.length, 0, `${bad} must not reach the transport`);
    assert.match(cli.err.join("\n"), /--base-url/, `${bad} error should name --base-url`);
  }
});

test("accepts next year (the published draft budget) and rejects the year after", async () => {
  const next = new Date().getUTCFullYear() + 1;
  const cli = makeCli(() => jsonResponse(body));
  assert.equal(await run(["expenses", String(next)], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("year"), String(next));

  const over = makeCli(() => jsonResponse(body));
  assert.equal(await run(["expenses", String(next + 1)], over.deps), 1);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), new RegExp(`between 2012 and ${next}\\.`));
});

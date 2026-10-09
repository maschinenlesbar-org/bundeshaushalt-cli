import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { BundeshaushaltClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse, redirectResponse, untimed } from "./helpers.js";
import { credentialsIn } from "../src/client/errors.js";

const body = { meta: {}, detail: {}, children: [] };

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

test("rejects a blank, control-character or non-Latin-1 --user-agent before any request", async () => {
  const cases = [
    ["", /Expected a non-empty value\./],
    ["   ", /Expected a non-empty value\./],
    ["a\r\nX-Evil: 1", /Value contains control characters\./],
    ["🌦", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
  ] as const;
  for (const [ua, message] of cases) {
    const cli = makeCli(() => jsonResponse(body));
    const code = await run(["--user-agent", ua, "expenses", "2024"], cli.deps);
    assert.equal(code, 1, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0, JSON.stringify(ua));
    assert.match(cli.err.join("\n"), message, JSON.stringify(ua));
  }
  const ok = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--user-agent", "my-app/1.0\tüber", "expenses", "2024"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "my-app/1.0\tüber");
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
  assert.equal(untimed(cli.err.join("\n")), 'ERROR [bundeshaushalt.cli] Invalid id "  ": Expected a non-empty budget number.');
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

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["100", false]] as const) {
    const cli = makeCli(() => jsonResponse(body));
    const code = await run(["--max-retries", value, "expenses", "2024"], cli.deps);
    assert.equal(code, ok ? 0 : 1, value);
    if (!ok) {
      assert.equal(cli.mt.calls.length, 0);
      assert.match(cli.err.join("\n"), /<= 10/);
    }
  }
});

test("rejects a bare G-/F- prefix as --id before any request", async () => {
  for (const id of ["G-", "F-", "g-"]) {
    const cli = makeCli(() => jsonResponse(body));
    const code = await run(["budget", "2024", "expenses", "--unit", "group", "--id", id], cli.deps);
    assert.equal(code, 1, id);
    assert.equal(cli.mt.calls.length, 0, id);
    assert.match(cli.err.join("\n"), /Expected a number after the "[GF]-" prefix/, id);
  }
});

test("a deeply nested response fails pretty-printing cleanly and still prints with --compact", async () => {
  const depth = 200_000;
  const nested = "[".repeat(depth) + "]".repeat(depth);
  const deep = () => rawResponse(`{"meta":{},"detail":{},"x":${nested}}`, "application/json");
  const pretty = makeCli(deep);
  assert.equal(await run(["expenses", "2024"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(untimed(pretty.err.join("\n")), "ERROR [bundeshaushalt.cli] The response is nested too deeply to pretty-print; try --compact.");

  // Compact serialisation goes much deeper (it prints this one on current Node);
  // should a runtime's stack still be too small, it must fail just as cleanly.
  const compact = makeCli(deep);
  const code = await run(["--compact", "expenses", "2024"], compact.deps);
  if (code === 0) assert.ok(compact.out.join("").includes(nested));
  else assert.equal(untimed(compact.err.join("\n")), "ERROR [bundeshaushalt.cli] The response is nested too deeply to print.");
});

test("bidi controls in server data are escaped in the JSON output", async () => {
  const served = { ...body, meta: { label: `a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x2066)}c` } };
  const cli = makeCli(() => jsonResponse(served));
  assert.equal(await run(["--compact", "expenses", "2024"], cli.deps), 0);
  const text = cli.out.join("\n");
  assert.match(text, /a\\u202eb\\u2066c/);
  assert.deepEqual(JSON.parse(text), served);
});

test("a null 2xx body exits 1 with a parse error, not success", async () => {
  const cli = makeCli(() => jsonResponse(null));
  assert.equal(await run(["--compact", "expenses", "2024"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[bundeshaushalt\.api\] Unexpected response shape from \/internalapi\/budgetData/);
});

test("a 404 for --quota actual hints that realised figures may not be published yet", async () => {
  const actual = makeCli(() => jsonResponse({}, 404));
  assert.equal(await run(["expenses", "2026", "--quota", "actual"], actual.deps), 4);
  assert.match(untimed(actual.err.join("\n")), /^ERROR \[bundeshaushalt\.api\] HTTP 404 /);
  assert.match(untimed(actual.err.join("\n")), /^INFO  \[bundeshaushalt\.api\] with --quota actual, a 404 also means/m);

  const target = makeCli(() => jsonResponse({}, 404));
  assert.equal(await run(["expenses", "2026", "--id", "99"], target.deps), 4);
  assert.doesNotMatch(target.err.join("\n"), /with --quota actual/);
  assert.deepEqual(target.err.map(untimed).map((line) => line.split(" ")[0]), ["ERROR"]);
});

test("--id's G-/F- prefix sets --unit when omitted", async () => {
  for (const [id, unit] of [["G-5", "group"], ["f-0", "function"], ["14", null]] as const) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run(["budget", "2024", "expenses", "--id", id], cli.deps), 0, id);
    assert.equal(new URL(cli.mt.last().url).searchParams.get("unit"), unit, id);
  }
});

test("rejects an --id whose prefix contradicts --unit before any request", async () => {
  const cases = [
    ["single", "G-5", 'Invalid id "G-5" for unit single: A "G-" id belongs to unit group.'],
    ["function", "G-5", 'Invalid id "G-5" for unit function: A "G-" id belongs to unit group.'],
    ["group", "14", 'Invalid id "14" for unit group: Expected an id starting with "G-" (e.g. "G-5").'],
    ["function", "14", 'Invalid id "14" for unit function: Expected an id starting with "F-" (e.g. "F-0").'],
  ] as const;
  for (const [unit, id, message] of cases) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run(["budget", "2024", "expenses", "--unit", unit, "--id", id], cli.deps), 1, id);
    assert.equal(cli.mt.calls.length, 0, id);
    assert.equal(untimed(cli.err.join("\n")), `ERROR [bundeshaushalt.cli] ${message}`);
  }
  const ok = makeCli(() => jsonResponse(body));
  assert.equal(await run(["budget", "2024", "expenses", "--unit", "group", "--id", "g-5"], ok.deps), 0);
});

test("--help says that --timeout 0 means no limit", async () => {
  const cli = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--help"], cli.deps), 0);
  assert.match(cli.out.join("\n").replace(/\s+/g, " "), /--timeout <ms> time limit per request in milliseconds, whole response included \(0 = no limit\)/);
});

test("a year, account or id the user typed with a line break or a control is echoed in one record", async () => {
  const forged = "\n2026-10-09T01:00:00.000Z INFO  [bundeshaushalt.api] all good\u001b]0;t\u0007\r‮";
  for (const argv of [
    ["budget", "2024", `expenses${forged}`],
    ["expenses", `2024${forged}`],
    ["expenses", "2024", "--id", `-x${forged}`],
    ["expenses", "2024", "--unit", "group", "--id", `14${forged}`],
  ]) {
    const cli = makeCli(() => jsonResponse(body));
    const code = await run(argv, cli.deps);
    assert.equal(code, 1, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.equal(cli.err.length, 1, cli.err.join("\n"));
    const line = cli.err[0] as string;
    assert.match(line, /^\S+ ERROR \[bundeshaushalt\.cli\] Invalid /, line);
    assert.doesNotMatch(line, /[\n\r\u001b\u0007‮]/, line);
    assert.ok(line.includes("\\n2026-10-09T01:00:00.000Z INFO"), line);
  }
});

test("a rejected year, account or id is quoted at most 200 characters long in the CLI's own messages (L3)", async () => {
  const long = "9".repeat(5000);
  for (const argv of [
    ["expenses", `1${long}`],
    ["budget", "2024", `x${long}`],
    ["expenses", "2024", "--id", `-${long}`],
    ["expenses", "2024", "--unit", "group", "--id", `1${long}`],
  ]) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" ").slice(0, 40));
    assert.equal(cli.mt.calls.length, 0);
    const record = cli.err[0] ?? "";
    const own = record.slice(record.indexOf("Invalid "));
    assert.match(own, /^Invalid (year|account|id) "[^"…]{1,200}…"/, own.slice(0, 300));
    assert.ok(own.length < 450, `${own.length}: ${own.slice(0, 300)}`);
  }
});

test("a quoted value is redacted before it is cut, so no part of a password is left without its @", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const value = `https://u:${"p".repeat(300)}@h.example`;
  assert.equal(await run(["budget", "2024", value], cli.deps), 1);
  assert.ok(!cli.err.join("\n").includes("ppp"), cli.err.join("\n").slice(0, 300));
  assert.match(cli.err.join("\n"), /Invalid account "https:\/\/\*\*\*@h\.example\/?"/);
});

test("a credential URL with DEL and a space, echoed in Invalid account, is redacted in jsonl too (B04-1)", async () => {
  const cli = makeCli(() => jsonResponse(body));
  const code = await run(["--log-format", "jsonl", "budget", "2024", "http://u:PWX X\u007fz@h.example"], cli.deps);
  assert.equal(code, 1);
  assert.ok(!cli.err.join("\n").includes("PWX"), cli.err.join("\n"));
});

test("an a:b@c argument (a User-Agent, an account) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const cli = makeCli(() => jsonResponse({ ...body, detail: { label: "run:2026-10-09@x" } }));
  assert.equal(await run(["--user-agent", "run:2026-10-09@x", "expenses", "2024"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"label": "run:2026-10-09@x"/);
  const typed = makeCli(() => jsonResponse(body));
  assert.equal(await run(["budget", "2024", "run:2026-10-09@x"], typed.deps), 1);
  assert.ok(typed.err.some((line) => line.includes('"run:2026-10-09@x"')), typed.err.join("\n"));
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
});

test("commander's output is one record per line, and every failed run has an ERROR (B01-2)", async () => {
  for (const argv of [["expense", "2024"], ["budget", "2024"], [], ["help", "expens"], ["expenses", "2024", "--quota", "x"]]) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.match(cli.err[0] ?? "", /^\S+ ERROR \[bundeshaushalt\.cli\] /, `${argv.join(" ")}:\n${cli.err.join("\n")}`);
    for (const line of cli.err) assert.match(line, /^\S+ (ERROR|INFO ) \[bundeshaushalt\.cli\] .*\S/, line);
    assert.ok(cli.err.every((line) => !line.includes("\\n")), cli.err.join("\n"));
  }
  const typo = makeCli(() => jsonResponse(body));
  await run(["expense", "2024"], typo.deps);
  assert.match(typo.err[0] ?? "", /unknown command 'expense' \(Did you mean expenses\?\)$/);
  const bare = makeCli(() => jsonResponse(body));
  await run([], bare.deps);
  assert.match(bare.err[0] ?? "", /ERROR \[bundeshaushalt\.cli\] missing command: `bundeshaushalt <subcommand>`$/);
});

test("a repeated --log-format is reported in the format commander kept, the first (L6)", async () => {
  for (const [first, second] of [["jsonl", "text"], ["text", "jsonl"]]) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run(["--log-format", first!, "--log-format", second!, "expenses", "2024"], cli.deps), 1);
    const line = cli.err[0] ?? "";
    if (first === "jsonl") {
      const record = JSON.parse(line) as Record<string, unknown>;
      assert.deepEqual([record["level"], record["topic"]], ["ERROR", "bundeshaushalt.cli"]);
      assert.match(record["msg"] as string, /--log-format was given more than once/);
    } else {
      assert.match(line, /^\S+Z ERROR \[bundeshaushalt\.cli\] .*--log-format was given more than once/);
    }
  }
});

test("an option's value that looks like --log-format sets no format, in a parse error too (B03-1, L6)", async () => {
  // commander takes "--log-format=text" as the User-Agent: the real flag, jsonl, counts.
  const real = makeCli(() => jsonResponse({}, 404));
  assert.equal(await run(["--log-format", "jsonl", "--user-agent", "--log-format=text", "income", "2025"], real.deps), 4);
  assert.equal((JSON.parse(real.err[0] ?? "") as Record<string, unknown>)["level"], "ERROR");
  // commander takes "--log-format" as the User-Agent and then fails on the command "jsonl".
  const ua = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--user-agent", "--log-format", "jsonl", "expenses", "2024"], ua.deps), 1);
  assert.match(ua.err[0] ?? "", /^\S+Z ERROR \[bundeshaushalt\.cli\] /);
  // --base-url swallows the flag: its rejection is logged in text.
  const base = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--base-url", "--log-format=jsonl", "expenses", "2024"], base.deps), 1);
  assert.match(base.err[0] ?? "", /^\S+Z ERROR \[bundeshaushalt\.cli\] option '--base-url <url>'/);
});

test("the --quota actual hint follows what the user asked, also after a redirect that drops the query (B02-2)", async () => {
  // The portal (or a mirror) redirects to a URL without the query; the 404 comes from there.
  const responder = (req: { url: string }) =>
    new URL(req.url).pathname.startsWith("/moved") ? jsonResponse({}, 404) : redirectResponse("/moved/internalapi/budgetData");
  const actual = makeCli(responder);
  assert.equal(await run(["budget", "2024", "income", "--quota", "actual"], actual.deps), 4);
  assert.match(untimed(actual.err.join("\n")), /^ERROR \[bundeshaushalt\.api\] HTTP 404 for GET https:\/\/bundeshaushalt\.de\/moved\//);
  assert.match(untimed(actual.err.join("\n")), /^INFO  \[bundeshaushalt\.api\] with --quota actual, a 404 also means/m);
  // Without --quota actual no hint, whatever the final URL says.
  const target = makeCli((req) =>
    new URL(req.url).pathname.startsWith("/moved") ? jsonResponse({}, 404) : redirectResponse("/moved/internalapi/budgetData?quota=actual"));
  assert.equal(await run(["budget", "2024", "income"], target.deps), 4);
  assert.doesNotMatch(target.err.join("\n"), /with --quota actual/);
});

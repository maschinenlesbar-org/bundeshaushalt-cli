import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { BundeshaushaltClient } from "@maschinenlesbar.org/bundeshaushalt-client/internal/client";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/bundeshaushalt-client/internal/http";
import { makeMockTransport, jsonResponse, rawResponse, redirectResponse, untimed } from "./helpers.js";
import { credentialsIn } from "@maschinenlesbar.org/bundeshaushalt-client/internal/errors";
import { renderJson } from "../src/cli/shared.js";

const body = { meta: {}, detail: { label: "Sollwerte" }, children: [] };

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
  assert.equal(untimed(cli.err.join("\n")), "ERROR [bundeshaushalt.cli] Invalid id: Expected a non-empty value.");
});

test("--timeout accepts up to the largest timer Node supports and rejects more", async () => {
  const { MAX_TIMEOUT_MS } = await import("@maschinenlesbar.org/bundeshaushalt-client");
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

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed.
  const depth = 200_000;
  const nested = "[".repeat(depth) + "]".repeat(depth);
  const text = `{"meta":{},"detail":{},"x":${nested}}`;
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(text));
  } catch {
    compactPrints = false;
  }
  const deep = () => rawResponse(text, "application/json");
  const pretty = makeCli(deep);
  assert.equal(await run(["expenses", "2024"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(
    untimed(pretty.err.join("\n")),
    `ERROR [bundeshaushalt.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  );
  const compact = makeCli(deep);
  assert.equal(await run(["--compact", "expenses", "2024"], compact.deps), compactPrints ? 0 : 1);
  if (compactPrints) assert.ok(compact.out.join("").includes(nested));
  else assert.equal(untimed(compact.err.join("\n")), "ERROR [bundeshaushalt.output] The answer is nested too deeply to print.");
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli(() => jsonResponse(body));
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { meta: {} }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli(() => jsonResponse(body));
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { meta: {}, detail: { label: huge } });
  renderJson(deps, { compact: true }, { meta: {}, x: [[["Titel"]]], label: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { meta: {} });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const { deps, out } = makeCli(() => jsonResponse(body));
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
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
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[bundeshaushalt\.api\] GET https:\/\/bundeshaushalt\.de\/internalapi\/budgetData\?year=2024&account=expenses: unexpected response shape: expected a JSON object with meta and detail\.$/);
});

test("an id the API answers with an empty element exits 4 with an ERROR of the api area, nothing on stdout (Bug 2)", async () => {
  const empty = { meta: { year: 2024, unit: "group", levelCur: 1, levelMax: 4 }, detail: {}, parents: [[{ id: null, label: "Sollwerte" }]] };
  const cli = makeCli(() => jsonResponse(empty));
  assert.equal(await run(["--compact", "expenses", "2024", "--id", "G-1"], cli.deps), 4);
  assert.deepEqual(cli.out, []);
  assert.deepEqual(cli.err.map(untimed), [
    'ERROR [bundeshaushalt.api] GET https://bundeshaushalt.de/internalapi/budgetData?year=2024&account=expenses&unit=group&id=G-1: no budget element "G-1": the API answered with an empty element.',
  ]);
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

test("a refused value is shown with its invisible characters escaped, in commander's errors and the CLI's own (D10)", async () => {
  for (const [argv, shown] of [
    [["expenses", "2024", "--quota", "tar\u200bget"], "tar\\u200bget"],
    [["expenses", "2024", "--unit", "gro\u202eup"], "gro\\u202eup"],
    [["expenses", "2024", "--unit", "x\ud800"], "x\\ud800"],
    [["budget", "2024", "expen\u00adses"], "expen\\u00adses"],
    [["expenses", "2024", "--id", "-\u2066x"], "-\\u2066x"],
  ] as const) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run([...argv], cli.deps), 1, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    const err = cli.err.join("\n");
    assert.ok(err.includes(shown), `${argv.join(" ")}: ${err}`);
    assert.doesNotMatch(err, /[\u200b\u202e\u00ad\u2066\ufffd]/, err);
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
    assert.match(own, /^Invalid (year|account|id) "[^"…]{1,200}"…/, own.slice(0, 300));
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

test("a credential URL given as --id is refused before any request, its password redacted in the record (B04-2, D8)", async () => {
  // A budget number has no "/", so a URL never reaches a request (where it went out
  // percent-encoded, and the 404 record had to redact that form).
  for (const format of ["text", "jsonl"]) {
    const cli = makeCli(() => jsonResponse({}, 404));
    assert.equal(await run(["--log-format", format, "income", "2023", "--id", "http://u:PWXplain@h.example"], cli.deps), 1);
    assert.equal(cli.mt.calls.length, 0);
    const all = cli.err.join("\n");
    assert.ok(!all.includes("PWX"), `${format}: ${all}`);
    assert.match(all, /Invalid id: \\?"http:\/\/\*\*\*@h\.example\/?\\?" is no budget number/, all);
  }
});

test("a subcommand's value option does not swallow the program's --log-format, in a parse error too (L6)", async () => {
  // commander takes the program's --log-format out of argv first; --id is left without its value.
  const cli = makeCli(() => jsonResponse(body));
  assert.notEqual(await run(["income", "2023", "--id", "--log-format", "jsonl"], cli.deps), 0);
  assert.ok(cli.err.length > 0 && cli.err.every((line) => line.startsWith("{")), cli.err.join("\n"));
  assert.match((JSON.parse(cli.err[0] ?? "") as Record<string, unknown>)["msg"] as string, /--id <id>' argument missing/);
});

// T15 of the 2026-10-21 fix round (jobsuche-cli 28be809, ladesaeulenregister-cli 001c48d): a URL
// with a password anywhere in an argument — an id, a year, padded, after a dash, inside a
// phrase, an option value, commander's echo — must never reach stderr, neither raw in a refusal
// or note nor percent-encoded in the request URL of an error record.
test("a password in a URL inside any argument is redacted on stderr, raw or percent-encoded (T15)", async () => {
  const url = "https://bob:s3cretpw@host.example/x";
  const argvs = [
    ["expenses", "2024", "--id", url],
    ["expenses", "2024", "--id", ` ${url}`],
    ["expenses", "2024", "--id", `\t${url}`],
    ["expenses", "2024", "--id", ` -${url}`],
    ["expenses", "2024", "--id", `G-${url}`],
    ["expenses", "2024", "--id", `F-01 ${url}`],
    ["expenses", "2024", "--id", `01\u0007${url}`],
    ["expenses", "2024", `--id= ${url}`],
    ["expenses", ` ${url}`],
    ["expenses", `2024 ${url}`],
    ["budget", "2024", ` ${url}`],
    ["budget", "2024", "expenses", "--quota", ` ${url}`],
    ["budget", "2024", "expenses", "--unit", ` ${url}`],
    [` ${url}`],
    [url],
    ["expenses", "2024", url],
    ["expenses", "2024", "--id", url, "--bogus"],
    ["--timeout", ` ${url}`, "expenses", "2024"],
  ];
  const answers: Array<() => HttpResponse> = [
    () => jsonResponse({ message: `bad value ${url}` }, 404),
    () => jsonResponse({}, 500),
    () => rawResponse("busy", "text/plain", 503),
    () => jsonResponse({ meta: {}, detail: { budget: 0 } }),
    () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
  ];
  for (const argv of argvs) {
    for (const answer of answers) {
      const cli = makeCli(answer);
      await run(["--max-retries", "0", ...argv], cli.deps);
      const err = cli.err.join("\n");
      assert.doesNotMatch(err, /s3cretpw|bob%3As3|s3cretpw%40/, `${JSON.stringify(argv)}: ${err}`);
    }
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  parseRetryAfter,
  stripCrossOriginCredentials,
} from "../src/client/engine.js";
import {
  HaushaltApiError,
  HaushaltNetworkError,
  HaushaltParseError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, redirectResponse } from "./helpers.js";

// Built via char codes so no raw control bytes ever appear in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1 = String.fromCharCode(0x9b); // a C1 control (CSI)

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("internalapi/"), "https://example.test/internalapi/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("buildUrl preserves a base URL path prefix", () => {
  const e = new RequestEngine({ baseUrl: "https://host.test/api" });
  assert.equal(e.buildUrl("/internalapi/x"), "https://host.test/api/internalapi/x");
});

test("buildUrl rejects a scheme-only base URL instead of mangling the host", () => {
  const e = new RequestEngine({ baseUrl: "https:" });
  assert.throws(() => e.buildUrl("/internalapi/budgetData"), HaushaltNetworkError);
});

test("buildUrl rejects a base URL carrying a query string", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/?x=1" });
  assert.throws(() => e.buildUrl("/internalapi/x"), HaushaltNetworkError);
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws HaushaltParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), HaushaltParseError);
});

test("getJson rejects a non-JSON Content-Type, naming the type returned", async () => {
  const mt = makeMockTransport(() => rawResponse("<h1>nope</h1>", "text/html"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof HaushaltParseError && /Content-Type "text\/html"/.test(err.message),
  );
});

test("getJson reports an empty (204) response body clearly", async () => {
  const mt = makeMockTransport(() => rawResponse("", "application/json", 204));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof HaushaltParseError && /Empty response body/.test(err.message),
  );
});

test("a 503 is retried up to maxRetries then surfaces as HaushaltApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof HaushaltApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("follows a redirect and returns the final body", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(new URL(req.url).pathname, "/x");
      return redirectResponse("/y");
    }
    assert.equal(new URL(req.url).pathname, "/y");
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("a redirect loop is bounded by maxRedirects with a clear 'too many redirects' error", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return redirectResponse("/loop");
  });
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    maxRedirects: 2,
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof HaushaltNetworkError && /Too many redirects/.test(err.message),
  );
  assert.equal(calls, 3); // initial + 2 redirect hops
});

test("stripCrossOriginCredentials drops auth headers across origins, keeps same-origin", () => {
  const creds = {
    Authorization: "Bearer secret",
    "X-API-Key": "k",
    Cookie: "s=1",
    "User-Agent": "ua/1",
    Accept: "application/json",
  };
  // Same origin: nothing stripped.
  assert.deepEqual(
    stripCrossOriginCredentials(creds, "https://a.test/x", "https://a.test/y"),
    creds,
  );
  // Cross origin: sensitive headers removed, benign ones retained.
  const stripped = stripCrossOriginCredentials(creds, "https://a.test/x", "https://b.test/y");
  assert.equal(stripped["Authorization"], undefined);
  assert.equal(stripped["X-API-Key"], undefined);
  assert.equal(stripped["Cookie"], undefined);
  assert.equal(stripped["User-Agent"], "ua/1");
  assert.equal(stripped["Accept"], "application/json");
});

test("benign headers survive a cross-origin redirect end to end", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    if (calls === 1) return redirectResponse("https://other.test/y");
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    userAgent: "ua/1",
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  const second = mt.calls[1]!;
  assert.equal(second.headers?.["User-Agent"], "ua/1");
  assert.equal(second.headers?.["Accept"], "application/json");
});

test("refuses an https->http downgrade on redirect", async () => {
  const mt = makeMockTransport(() => redirectResponse("http://example.test/y"));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), HaushaltNetworkError);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
  assert.equal(mt.last().headers?.["Accept-Encoding"], "gzip, deflate, br");
});

test("error detail is stripped of terminal control characters", async () => {
  // ESC + C1 (CSI) + BEL interleaved with printable text, delivered in a non-2xx
  // JSON error body. JSON.parse turns the escaped bytes into real control chars.
  const evil = `boom${ESC}[31mred${BEL}${C1}2J`;
  const mt = makeMockTransport(() => jsonResponse({ detail: evil }, 500));
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof HaushaltApiError);
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters are preserved.
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("a non-JSON Content-Type is stripped of control characters in the message", async () => {
  // A hostile 200 with a crafted Content-Type carrying an escape sequence.
  const mt = makeMockTransport(() => rawResponse("<h1>x</h1>", `text/html${ESC}[2J`));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof HaushaltParseError);
      assert.ok(!hasControlChars(err.message));
      return true;
    },
  );
});

/** An engine over a transport that always answers `status` with this Retry-After. */
function retryAfterEngine(status: number, header: string) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status,
    headers: { "retry-after": header },
    body: Buffer.alloc(0),
  }));
  const e = new RequestEngine({
    transport: mt.transport,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { e, mt, delays };
}

test("a valid Retry-After is waited out instead of the linear backoff", async () => {
  const { e, mt, delays } = retryAfterEngine(429, "1");
  await assert.rejects(() => e.getJson("/x"), HaushaltApiError);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("a malformed Retry-After (-1, 1.5, ...) falls back to the linear backoff", async () => {
  for (const header of ["", "-1", "1.5", "+5", "abc", "1e3", "0x10", "2026-09-26T10:00:00Z"]) {
    const { e, delays } = retryAfterEngine(429, header);
    await assert.rejects(() => e.getJson("/x"), HaushaltApiError);
    assert.deepEqual(delays, [200, 400], header);
  }
});

test("a Retry-After beyond 30 s is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999999", "Wed, 21 Oct 2099 07:28:00 GMT"]) {
    const { e, mt, delays } = retryAfterEngine(503, header);
    await assert.rejects(
      () => e.getJson("/x"),
      (err) => err instanceof HaushaltApiError && err.status === 503,
    );
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0);
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

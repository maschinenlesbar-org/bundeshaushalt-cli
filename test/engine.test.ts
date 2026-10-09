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
  HaushaltValidationError,
  cutText,
  toWellFormed,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, redirectResponse } from "./helpers.js";
import type { HttpResponse } from "../src/client/http.js";

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

test("the constructor rejects a bad base URL as a HaushaltValidationError, not a network error", () => {
  for (const baseUrl of ["https:", "https://example.test/?x=1", "https://example.test/#f", "ftp://example.test", "notaurl"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (e: unknown) => e instanceof HaushaltValidationError && !(e instanceof HaushaltNetworkError),
      baseUrl,
    );
  }
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

test("server text on stderr loses line breaks and bidi controls", async () => {
  const rlo = String.fromCharCode(0x202e);
  const mt = makeMockTransport(() =>
    jsonResponse({ detail: `nope\n\nbundeshaushalt: all good, exit 0${rlo}gnp.exe x` }, 404),
  );
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof HaushaltApiError);
      assert.equal(err.detail, "nope bundeshaushalt: all good, exit 0gnp.exe x");
      assert.ok(!/[\n\r]/.test(err.message));
      return true;
    },
  );
});

test("a base URL's userinfo is sent as an Authorization header and kept out of error messages", async () => {
  const mt = makeMockTransport(() => jsonResponse({ detail: "busy" }, 500));
  const e = new RequestEngine({ baseUrl: "http://user:s%40cret@mirror.test/api/", transport: mt.transport });
  assert.equal(e.buildUrl("/x", { a: "1" }), "http://user:s%40cret@mirror.test/api/x?a=1");
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof HaushaltApiError);
      // The userinfo travels as the Authorization header, never in the request URL.
      assert.equal(err.url, "http://mirror.test/api/x");
      assert.equal(err.message, "HTTP 500 for GET http://mirror.test/api/x: busy");
      return true;
    },
  );
  assert.equal(mt.last().url, "http://mirror.test/api/x");
  assert.equal(mt.last().headers?.["Authorization"], `Basic ${Buffer.from("user:s@cret").toString("base64")}`);

  assert.throws(
    () => new RequestEngine({ baseUrl: "http://user:secret@mirror.test/?q=1" }),
    (err: unknown) =>
      err instanceof HaushaltValidationError && !err.message.includes("secret") && err.message.includes("***@"),
  );
});

test("the body is decoded by its declared charset and a UTF-8 BOM is ignored", async () => {
  const latin1 = makeMockTransport(() =>
    rawResponse(Buffer.from('{"label":"Grüße"}', "latin1"), "application/json; charset=iso-8859-1"),
  );
  assert.deepEqual(await new RequestEngine({ transport: latin1.transport }).getJson("/x"), { label: "Grüße" });

  const bom = makeMockTransport(() =>
    rawResponse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"label":"Grüße"}')]), "application/json"),
  );
  assert.deepEqual(await new RequestEngine({ transport: bom.transport }).getJson("/x"), { label: "Grüße" });

  const unknown = makeMockTransport(() => rawResponse("{}", "application/json; charset=x-nope"));
  await assert.rejects(
    () => new RequestEngine({ transport: unknown.transport }).getJson("/x"),
    (err: unknown) => err instanceof HaushaltParseError && err.message === 'Unsupported response charset "x-nope" from /x.',
  );
});

test("custom transports: header names in any case are read (Location, Content-Type)", async () => {
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ === 0
      ? { status: 302, headers: { Location: "/moved" } as unknown as HttpResponse["headers"], body: Buffer.alloc(0) }
      : { status: 200, headers: { "Content-Type": "text/html" } as unknown as HttpResponse["headers"], body: Buffer.from("<html>") },
  );
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof HaushaltParseError && /Content-Type "text\/html"/.test(err.message),
  );
  assert.equal(new URL(mt.last().url).pathname, "/moved");
});

test("custom transports: a Uint8Array error body keeps its detail and text", async () => {
  const body = new Uint8Array(Buffer.from('{"detail":"no such id"}'));
  const mt = makeMockTransport(() => ({ status: 404, headers: { "content-type": "application/json" }, body: body as Buffer }));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof HaushaltApiError && err.detail === "no such id" && err.body === '{"detail":"no such id"}',
  );
});

test("custom transports: a string body or missing headers is a HaushaltNetworkError, not a raw TypeError", async () => {
  for (const response of [
    { status: 200, headers: {}, body: "{}" },
    { status: 200, body: Buffer.from("{}") },
    { status: 0, headers: {}, body: Buffer.from("{}") },
  ]) {
    const e = new RequestEngine({ transport: async () => response as unknown as HttpResponse });
    await assert.rejects(() => e.getJson("/x"), HaushaltNetworkError);
  }
});

test("a redirect to a non-http(s) target is refused before the transport sees it", async () => {
  for (const location of ["file:///etc/passwd", "data:text/plain,hi", "javascript:alert(1)", "ftp://example.test/x"]) {
    const mt = makeMockTransport(() => redirectResponse(location));
    const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
    await assert.rejects(
      () => e.getJson("/x"),
      (err) => err instanceof HaushaltNetworkError && /unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 1, location);
  }
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail cut at 500 characters keeps the message well-formed", async () => {
  for (const detail of ["\u{1f600}".repeat(600), "a" + "\u{1f600}".repeat(600)]) {
    const engine = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({ detail }, 500)).transport, maxRetries: 0 });
    await assert.rejects(engine.getJson("/internalapi/budgetData"), (err: Error) => {
      assert.equal(toWellFormed(err.message), err.message);
      assert.match(err.message, /…$/);
      return true;
    });
  }
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // The engine sends the pair UTF-8 encoded (basicAuthorization), so that is the form a server echoes.
  const basic = Buffer.from("alice:pa ss-pw", "utf8").toString("base64");
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.example",
    maxRetries: 0,
    transport: makeMockTransport(() => jsonResponse({ detail: `no: Basic ${basic} / alice:pa ss-pw / pa ss-pw` }, 401)).transport,
  });
  await assert.rejects(engine.getJson("/internalapi/budgetData"), (err: HaushaltApiError) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.body.includes(form), err.body);
    return true;
  });
});

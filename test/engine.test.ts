import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, stripCrossOriginCredentials } from "../src/client/engine.js";
import {
  HaushaltApiError,
  HaushaltNetworkError,
  HaushaltParseError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, redirectResponse } from "./helpers.js";

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

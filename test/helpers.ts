// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import assert from "node:assert/strict";
import type { Transport, HttpRequest, HttpResponse } from "../src/client/http.js";
import { BundeshaushaltClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function rawResponse(
  data: string | Buffer,
  contentType: string,
  status = 200,
): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

export function redirectResponse(location: string, status = 302): HttpResponse {
  return {
    status,
    headers: { location },
    body: Buffer.alloc(0),
  };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/** A transport that always returns the same JSON body. */
export function constantJson(body: unknown, status = 200): MockTransport {
  return makeMockTransport(() => jsonResponse(body, status));
}

/** What the CLI did with one argv: exit code, captured output, requests sent. */
export interface CliOutcome {
  code: number;
  out: string[];
  err: string[];
  requests: HttpRequest[];
}

/** What a library call did: its value or the error it threw, and the requests sent. */
export type LibOutcome =
  | { ok: true; value: unknown; requests: HttpRequest[] }
  | { ok: false; error: unknown; requests: HttpRequest[] };

export interface ParityOutcome {
  cli: CliOutcome;
  lib: LibOutcome;
}

/**
 * Run one input through the CLI (`run(argv)`, its client built on the mock
 * transport) and through a library call on the same transport, and return both
 * outcomes. `libCall` gets the transport and builds its own client, so a
 * constructor-time rejection is captured too. The requests of each side are
 * recorded separately.
 */
export async function parity(
  argv: string[],
  libCall: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () =>
    jsonResponse({ meta: {}, detail: {}, children: [] }),
): Promise<ParityOutcome> {
  const mt = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new BundeshaushaltClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(argv, deps);
  const cli: CliOutcome = { code, out, err, requests: mt.calls.splice(0) };
  let lib: LibOutcome;
  try {
    const value = await libCall(mt.transport);
    lib = { ok: true, value, requests: mt.calls.splice(0) };
  } catch (error) {
    lib = { ok: false, error, requests: mt.calls.splice(0) };
  }
  return { cli, lib };
}

/**
 * Assert that both sides of a parity() run had the same outcome: the CLI exits 0
 * exactly when the library call succeeds, and both sent the identical requests
 * (none at all when both rejected the input).
 */
export function assertParity({ cli, lib }: ParityOutcome, label = ""): void {
  const shape = (rs: HttpRequest[]) => rs.map((r) => `${r.method} ${r.url} UA=${r.headers?.["User-Agent"] ?? ""}`);
  assert.equal(cli.code === 0, lib.ok, `${label}: CLI exit ${cli.code} ${cli.err.join(" ")} vs library ${lib.ok ? "ok" : String(lib.error)}`);
  assert.deepEqual(shape(cli.requests), shape(lib.requests), `${label}: requests differ`);
}

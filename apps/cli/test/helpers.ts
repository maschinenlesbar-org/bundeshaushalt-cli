// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import assert from "node:assert/strict";
import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/bundeshaushalt-client/internal/http";
import { BundeshaushaltClient } from "@maschinenlesbar.org/bundeshaushalt-client/internal/client";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/bundeshaushalt-client/test/helpers";

export * from "@maschinenlesbar.org/bundeshaushalt-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [bundeshaushalt.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
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
    jsonResponse({ meta: {}, detail: { label: "Sollwerte" }, children: [] }),
): Promise<ParityOutcome> {
  const mt = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new BundeshaushaltClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(argv, deps);
  const cli: CliOutcome = { code, out, err: err.map(untimed), requests: mt.calls.splice(0) };
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

// ---- the kit's parity shape, for the shared conformance bodies -------------------

/** What the CLI did with one input, as the kit's conformance tests read it: output joined. */
export interface KitCliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/** What the library did with the same input: its value, or its error's class name and message. */
export interface KitLibOutcome {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
  requests: HttpRequest[];
}

/**
 * parity() in the shape the shared conformance bodies (P24, P25) expect, the one the kit
 * (create-cli's template) has: stdout and stderr each joined into one string (stderr
 * untimed), the library's error as its class name and message. The tests imported as
 * `parity` read this one; this repo's own parity tests keep the arrays above.
 */
export async function kitParity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () =>
    jsonResponse({ meta: {}, detail: { label: "Sollwerte" }, children: [] }),
): Promise<{ cli: KitCliOutcome; lib: KitLibOutcome }> {
  const { cli, lib } = await parity(argv, call, responder);
  const kitLib: KitLibOutcome = lib.ok
    ? { ok: true, value: lib.value, requests: lib.requests }
    : {
        ok: false,
        error:
          lib.error instanceof Error
            ? { name: lib.error.constructor.name, message: lib.error.message }
            : { name: typeof lib.error, message: String(lib.error) },
        requests: lib.requests,
      };
  return { cli: { code: cli.code, out: cli.out.join("\n"), err: cli.err.join("\n"), requests: cli.requests }, lib: kitLib };
}

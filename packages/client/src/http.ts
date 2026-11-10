// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { HaushaltNetworkError, redactUrl, credentialsIn, redactCredentials, typedUrlCredentials } from "./errors.js";

// Async (libuv thread-pool) variants of the zlib calls, so decoding a large body
// does not block the event loop — this transport ships as a reusable library.
const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);

// Node's timers hold the delay in a 32-bit signed integer. A larger value makes
// Node emit a `TimeoutOverflowWarning` to stderr and mis-fire the timer, so clamp
// here: the effective timeout is already unbounded for practical
// purposes (~24.8 days).
/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Decompress a body according to its Content-Encoding (identity if none/unknown).
 *
 * `maxBytes` (when > 0) bounds the *decompressed* output via zlib's
 * `maxOutputLength`: a small compressed body can expand to many gigabytes
 * ("decompression bomb"), so capping only the compressed wire bytes is not
 * enough. Past the cap zlib throws `ERR_BUFFER_TOO_LARGE`, which is turned into
 * the same documented size-cap error the wire-size cap produces.
 */
async function decode(
  body: Buffer,
  encoding: string | undefined,
  maxBytes: number | undefined,
): Promise<Buffer> {
  const limit = maxBytes && maxBytes > 0 ? { maxOutputLength: maxBytes } : {};
  const overCap = (): HaushaltNetworkError =>
    new HaushaltNetworkError(sizeLimitMessage(maxBytes ?? 0));
  const isOverCap = (err: unknown): boolean =>
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE";
  try {
    switch ((encoding ?? "").toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return await gunzip(body, limit);
      case "deflate":
        // `deflate` is ambiguous: some servers send zlib-wrapped data (RFC 1950),
        // some send raw DEFLATE (RFC 1951). Try zlib-wrapped first, then raw.
        try {
          return await inflate(body, limit);
        } catch (err) {
          if (isOverCap(err)) throw err; // a size-cap hit, not a wrapper mismatch
          return await inflateRaw(body, limit);
        }
      case "br":
        return await brotliDecompress(body, limit);
      default:
        if (maxBytes && maxBytes > 0 && body.length > maxBytes) throw overCap();
        return body;
    }
  } catch (err) {
    if (isOverCap(err)) throw overCap();
    throw err;
  }
}

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Timeout for the whole request, response body included, in milliseconds. */
  timeoutMs?: number;
  /**
   * Aborted when the engine's overall deadline (`timeoutMs`) passes. A transport should stop
   * the request then (`fetch(url, { signal })`); the engine rejects at the deadline either way,
   * and enforces `maxResponseBytes` on the body it gets back, so neither limit depends on it.
   */
  signal?: AbortSignal;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
  /**
   * Always `"manual"` from the engine: a transport must not follow redirects. The engine
   * follows them itself and decides per hop whether the `Authorization` header goes along
   * (same origin only). A fetch-based transport passes it on: `fetch(url, { redirect })`.
   */
  redirect?: "manual";
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /**
   * The URL the response came from, if the transport knows it (fetch's `response.url`).
   * When it is on another origin than the request, the transport followed a redirect
   * itself and the engine rejects the response with a HaushaltNetworkError.
   */
  url?: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The message for a body over the size cap, naming the option on both sides. */
export function sizeLimitMessage(maxBytes: number): string {
  return `Response exceeded the size limit of ${maxBytes} bytes (maxResponseBytes; --max-response-bytes on the CLI)`;
}

/** Wrap a thrown value as a HaushaltNetworkError unless it already is one. */
function toNetworkError(err: unknown): HaushaltNetworkError {
  if (err instanceof HaushaltNetworkError) return err;
  return new HaushaltNetworkError(err instanceof Error ? err.message : String(err), { cause: err });
}

/** The most received chunks the default transport keeps unjoined. */
const COALESCE_CHUNKS = 1024;
/** The bytes of unjoined chunks at which the default transport joins them into one Buffer. */
const COALESCE_BYTES = 64 * 1024;

/**
 * `url` for a message, its userinfo redacted; one typed without its scheme (`user:pw@host`,
 * `TOKEN:@host`) or with a mistyped one (`http//user:pw@host`) is read as a URL all the same
 * (`typedUrlCredentials`), since `redactUrl` finds a userinfo only after a scheme.
 */
function shownUrl(url: string): string {
  return credentialsIn(url).length > 0 ? redactUrl(url) : redactCredentials(url, typedUrlCredentials(url));
}

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs).
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new HaushaltNetworkError(`Invalid URL: ${shownUrl(request.url)}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      // `user:password@host` without a scheme parses with the user name as the scheme: name a
      // scheme only when the value spells one (`<scheme>://`).
      const named = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(request.url) ? ` "${url.protocol}"` : "";
      reject(
        new HaushaltNetworkError(`Unsupported protocol${named} in URL: ${shownUrl(request.url)}`),
      );
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    // The timeout covers the whole exchange — connecting, waiting, reading and
    // decoding the body. A socket idle timeout alone would let a server that
    // trickles a byte now and then hold the request open indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = <T>(fn: (value: T) => void) => (value: T) => {
      clearTimeout(timer);
      fn(value);
    };
    const done = settle(resolve);
    const fail = settle(reject);

    const onResponse = (res: http.IncomingMessage): void => {
      // Small chunks are joined as they arrive (`pending`, at most COALESCE_CHUNKS of them or
      // COALESCE_BYTES), so the Buffers kept follow the bytes, not the number of chunks a server
      // chooses to send: a Buffer per one-byte chunk held ~210 bytes of heap each.
      const chunks: Buffer[] = [];
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let received = 0;
      let aborted = false;

      res.on("data", (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (maxBytes !== undefined && received > maxBytes) {
          aborted = true;
          res.destroy();
          fail(new HaushaltNetworkError(sizeLimitMessage(maxBytes)));
          return;
        }
        pending.push(chunk);
        pendingBytes += chunk.length;
        if (pending.length >= COALESCE_CHUNKS || pendingBytes >= COALESCE_BYTES) {
          chunks.push(pending.length === 1 ? chunk : Buffer.concat(pending, pendingBytes));
          pending = [];
          pendingBytes = 0;
        }
      });
      res.on("end", () => {
        if (aborted) return;
        const raw = Buffer.concat([...chunks, ...pending]);
        decode(raw, res.headers["content-encoding"], maxBytes).then(
          (body) => {
            // The body is now decoded; drop the encoding header so downstream
            // consumers don't try to decode it a second time.
            const headers = { ...res.headers };
            delete headers["content-encoding"];
            done({ status: res.statusCode ?? 0, headers, body });
          },
          (err) => {
            if (err instanceof HaushaltNetworkError) {
              fail(err);
              return;
            }
            fail(
              new HaushaltNetworkError(
                `Failed to decode ${res.headers["content-encoding"]} response body`,
                { cause: err },
              ),
            );
          },
        );
      });
      res.on("error", (err) => {
        if (aborted) return; // we already rejected with the size-cap error
        fail(new HaushaltNetworkError(`Response stream error: ${err.message}`, { cause: err }));
      });
    };

    let req: http.ClientRequest;
    try {
      // Node validates the outgoing headers synchronously here. An un-sendable
      // value (e.g. a non-Latin-1 --user-agent) makes it throw a TypeError
      // *before* the request is sent; surface it as the typed transport error
      // rather than letting a bare TypeError escape to the CLI's "Unexpected
      // error" fallback.
      req = driver.request(url, { method: request.method, headers: request.headers }, onResponse);
    } catch (err) {
      fail(toNetworkError(err));
      return;
    }

    if (request.timeoutMs && request.timeoutMs > 0) {
      const timeoutMs = Math.min(request.timeoutMs, MAX_TIMEOUT_MS);
      timer = setTimeout(() => {
        const err = new HaushaltNetworkError(`Request timed out after ${timeoutMs}ms`);
        fail(err);
        req.destroy(err);
      }, timeoutMs);
    }

    if (request.signal !== undefined) {
      const abort = (): void => {
        const err = new HaushaltNetworkError(`Request timed out after ${request.timeoutMs ?? 0}ms`);
        fail(err);
        req.destroy(err);
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    }

    req.on("error", (err) => {
      // A timeout destroy already passes an HaushaltNetworkError; don't double-wrap.
      // Otherwise prepend the request method + URL so the failure is traceable
      // (the raw Node message — e.g. "connect ECONNREFUSED 127.0.0.1:1" — has no
      // indication of which request it belongs to).
      fail(
        err instanceof HaushaltNetworkError
          ? err
          : new HaushaltNetworkError(`${request.method} ${redactUrl(request.url)} failed: ${err.message}`, {
              cause: err,
            }),
      );
    });

    try {
      if (request.body !== undefined) req.write(request.body);
      req.end();
    } catch (err) {
      fail(toNetworkError(err));
    }
  });

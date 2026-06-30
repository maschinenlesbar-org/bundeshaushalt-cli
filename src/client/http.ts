// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { HaushaltNetworkError } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** Wrap a thrown value as a HaushaltNetworkError unless it already is one. */
function toNetworkError(err: unknown): HaushaltNetworkError {
  if (err instanceof HaushaltNetworkError) return err;
  return new HaushaltNetworkError(err instanceof Error ? err.message : String(err), { cause: err });
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
      reject(new HaushaltNetworkError(`Invalid URL: ${request.url}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new HaushaltNetworkError(`Unsupported protocol "${url.protocol}" in URL: ${request.url}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    const onResponse = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;

      res.on("data", (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (maxBytes !== undefined && received > maxBytes) {
          aborted = true;
          res.destroy();
          reject(new HaushaltNetworkError(`Response exceeded maxResponseBytes (${maxBytes})`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (aborted) return;
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", (err) => {
        if (aborted) return; // we already rejected with the size-cap error
        reject(new HaushaltNetworkError(`Response stream error: ${err.message}`, { cause: err }));
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
      reject(toNetworkError(err));
      return;
    }

    if (request.timeoutMs && request.timeoutMs > 0) {
      req.setTimeout(request.timeoutMs, () => {
        req.destroy(new HaushaltNetworkError(`Request timed out after ${request.timeoutMs}ms`));
      });
    }

    req.on("error", (err) => {
      // A timeout destroy already passes an HaushaltNetworkError; don't double-wrap.
      // Otherwise prepend the request method + URL so the failure is traceable
      // (the raw Node message — e.g. "connect ECONNREFUSED 127.0.0.1:1" — has no
      // indication of which request it belongs to).
      reject(
        err instanceof HaushaltNetworkError
          ? err
          : new HaushaltNetworkError(`${request.method} ${request.url} failed: ${err.message}`, {
              cause: err,
            }),
      );
    });

    try {
      if (request.body !== undefined) req.write(request.body);
      req.end();
    } catch (err) {
      reject(toNetworkError(err));
    }
  });

// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { HaushaltApiError, HaushaltError, HaushaltNetworkError, HaushaltParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://bundeshaushalt.de";
const DEFAULT_USER_AGENT = "bundeshaushalt-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://bundeshaushalt.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /** Number of HTTP redirects (301/302/303/307/308) to follow. Defaults to 5. */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Headers that must never be replayed to a different origin on a redirect.
 * Matched case-insensitively. This mirrors the credential-stripping behaviour of
 * browsers / curl: a cross-origin `Location` must not leak auth material.
 */
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "cookie"]);

/** Drop sensitive headers when a redirect points at a different origin. */
export function stripCrossOriginCredentials(
  headers: Record<string, string>,
  fromUrl: string,
  toUrl: string,
): Record<string, string> {
  if (new URL(fromUrl).origin === new URL(toUrl).origin) return headers;
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(name.toLowerCase())) safe[name] = value;
  }
  return safe;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The media type without parameters or surrounding whitespace. */
function mediaType(contentType: string): string {
  const semi = contentType.indexOf(";");
  return (semi === -1 ? contentType : contentType.slice(0, semi)).trim();
}

/**
 * Whether a Content-Type denotes JSON: the canonical `application/json`,
 * structured-suffix types (`application/vnd.foo+json`), and the lenient
 * `text/json`. Parameters (`; charset=...`) and case are ignored.
 */
function isJsonContentType(contentType: string): boolean {
  const type = mediaType(contentType).toLowerCase();
  return type === "application/json" || type === "text/json" || type.endsWith("+json");
}

/**
 * Normalise a caller-supplied User-Agent into a safe header value.
 *
 * - An empty / whitespace-only value falls back to the default rather than
 *   sending an empty `User-Agent` (which would suppress the default entirely).
 * - A value containing control characters (CR/LF/NUL etc.) is rejected with a
 *   typed error here, instead of letting node:http throw a raw TypeError deep in
 *   the request that surfaces as an ungraceful "Unexpected error".
 */
function normalizeUserAgent(value: string | undefined): string {
  if (value === undefined) return DEFAULT_USER_AGENT;
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_USER_AGENT;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    // HTTP header values are limited to (printable) Latin-1. Reject C0 controls,
    // DEL, and anything beyond U+00FF (emoji, CJK, even U+0100) here, before
    // node:http throws an opaque TypeError ("Invalid character in header
    // content") that would otherwise escape as an ungraceful "Unexpected error".
    if (code < 0x20 || code === 0x7f || code > 0xff) {
      throw new HaushaltError(
        "Invalid User-Agent: only printable Latin-1 characters are allowed.",
      );
    }
  }
  return trimmed;
}

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // An empty / whitespace-only baseUrl falls back to the default rather than
    // collapsing (after trailing-slash stripping) to "" and building a relative
    // URL that `new URL()` rejects with a confusing "Invalid URL".
    const baseUrl = options.baseUrl?.trim() ? options.baseUrl : DEFAULT_BASE_URL;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = normalizeUserAgent(options.userAgent);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   *
   * The base URL is validated and decomposed via the WHATWG URL parser rather
   * than blindly concatenated, so a scheme-only base (`https:`) or one carrying
   * a query string (`https://host/?x=1`) is rejected with a clear,
   * base-url-specific error instead of silently producing a malformed URL — e.g.
   * promoting an internal path segment to the hostname, or emitting a double-`?`.
   * The base's own path prefix is preserved.
   */
  buildUrl(path: string, query?: QueryParams): string {
    let base: URL;
    try {
      base = new URL(this.baseUrl);
    } catch {
      throw new HaushaltNetworkError(`Invalid base URL: "${this.baseUrl}"`);
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new HaushaltNetworkError(
        `Unsupported protocol "${base.protocol}" in base URL: "${this.baseUrl}"`,
      );
    }
    if (!base.host) {
      throw new HaushaltNetworkError(`Base URL "${this.baseUrl}" has no host`);
    }
    if (base.search || base.hash) {
      throw new HaushaltNetworkError(
        `Base URL "${this.baseUrl}" must not contain a query string or fragment`,
      );
    }
    const basePath = base.pathname.replace(/\/+$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${base.origin}${basePath}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    let url = this.buildUrl(path, options.query);
    let headers: Record<string, string> = {
      Accept: options.accept,
      // Advertise the encodings the transport can decode so an RFC-compliant
      // origin (or a compressing proxy) actually compresses and we still decode it.
      "Accept-Encoding": "gzip, deflate, br",
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      // Follow redirects, resolving the Location relative to the current URL.
      if (status >= 300 && status < 400 && response.headers["location"]) {
        if (redirects >= this.maxRedirects) {
          throw new HaushaltNetworkError(
            `Too many redirects (exceeded maxRedirects=${this.maxRedirects}) for ${method} ${url}`,
          );
        }
        const location = response.headers["location"];
        if (typeof location === "string" && location.length > 0) {
          const nextUrl = new URL(location, url);
          // Refuse a downgrade from https to plaintext http on redirect.
          if (new URL(url).protocol === "https:" && nextUrl.protocol === "http:") {
            throw new HaushaltNetworkError(
              `Refusing to follow https->http redirect to ${nextUrl.toString()}`,
            );
          }
          // Strip credential headers if the redirect crosses origins.
          headers = stripCrossOriginCredentials(headers, url, nextUrl.toString());
          url = nextUrl.toString();
          redirects += 1;
          continue;
        }
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    // Honour the Content-Type: a 200 with a clearly non-JSON type (e.g. a
    // captive-portal HTML error page) should report what was actually returned
    // rather than feeding HTML into JSON.parse and blaming a parse failure. A
    // missing/empty Content-Type is treated leniently and still parsed.
    if (res.contentType && !isJsonContentType(res.contentType)) {
      throw new HaushaltParseError(
        `Expected a JSON response from ${path} but got Content-Type "${mediaType(res.contentType)}"`,
      );
    }
    const text = res.data.toString("utf8");
    // An empty 2xx body (e.g. a 204 No Content) is not valid JSON; report it as
    // such rather than emitting the opaque "Failed to parse JSON" for `""`.
    if (text.trim() === "") {
      throw new HaushaltParseError(`Empty response body from ${path} (expected JSON)`);
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new HaushaltParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): HaushaltApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    return new HaushaltApiError({ status, url, method, body: text, detail });
  }
}

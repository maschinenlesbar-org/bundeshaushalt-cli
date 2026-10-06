// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type HttpResponse, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { assertValid, baseUrlProblem, headerValueProblem } from "./validate.js";
import {
  HaushaltApiError,
  HaushaltError,
  HaushaltNetworkError,
  HaushaltParseError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";

export const DEFAULT_BASE_URL = "https://bundeshaushalt.de";
/** The User-Agent sent when the `userAgent` option is not given. */
export const DEFAULT_USER_AGENT = "bundeshaushalt-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a HaushaltError.
 */
export interface EngineOptions {
  /** Base URL of the API. Defaults to https://bundeshaushalt.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, 0..`MAX_RETRIES`
   * (10). Each waits the
   * response's `Retry-After` (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried), or else `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly: 200 ms, 400 ms,
   * ... by default). At most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number;
  /** Number of HTTP redirects (301/302/303/307/308) to follow, 0..20. Defaults to 5. */
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

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in an attacker-controlled response — the error
 * `detail`/`message`, the echoed Content-Type — safe to print into an error
 * message on stderr:
 *
 * - C0 and C1 controls and DEL are dropped. `JSON.parse` decodes an escaped ESC in
 *   an error body into a real ESC byte; printed raw, a hostile or MITM'd endpoint
 *   could drive ANSI/OSC escape sequences into the user's terminal (title
 *   spoofing, output forgery, clipboard writes on permissive terminals).
 * - Bidi formatting characters (isBidiControl) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge a line of its own.
 *
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts): `JSON.stringify` alone leaves DEL, C1 and bidi characters raw.
 * Written as a code-point filter so no raw control byte ever appears in this
 * source file.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/** Most redirects a caller may let the engine follow (the Fetch standard's limit). */
const MAX_REDIRECTS = 20;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxRetries: Infinity` retried for ever.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new HaushaltError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
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
 * Check a header value (`headerValueProblem`: not blank, printable Latin-1 plus
 * tab, the whole value scanned) and return it trimmed. Throws a
 * HaushaltValidationError `Invalid <name>: <reason>`, rather than letting node:http
 * throw a raw TypeError deep in the request.
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem).trim();
}

/**
 * Check a base URL (`baseUrlProblem`: absolute http(s), a host, no query string or
 * fragment) and return it without trailing slashes. Throws a
 * HaushaltValidationError, its URL shown through `redactUrl`.
 */
export function validateBaseUrl(raw: string): string {
  assertValid(`base URL "${redactUrl(String(raw))}"`, raw, baseUrlProblem);
  return raw.replace(/\/+$/, "");
}

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages show request URLs through redactUrl.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
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
    // Base URL and User-Agent are checked here, before any request, so a bad one
    // is a HaushaltValidationError at construction rather than a "network" error
    // later. Only `undefined` selects the default: a blank value is rejected, not
    // silently replaced (a blank baseUrl from an unset variable must not quietly
    // query production).
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertHeaderValue("User-Agent", options.userAgent);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, 5, MAX_REDIRECTS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   *
   * The base URL (checked by the constructor, `validateBaseUrl`) is decomposed via
   * the WHATWG URL parser rather than blindly concatenated, so its scheme, host
   * and own path prefix are kept exactly.
   */
  buildUrl(path: string, query?: QueryParams): string {
    return this.composeUrl(path, query, true);
  }

  /** buildUrl, with or without the base URL's userinfo. */
  private composeUrl(path: string, query: QueryParams | undefined, withUserinfo: boolean): string {
    const base = new URL(this.#baseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    // buildUrl keeps any userinfo (`http://user:pw@mirror/`); request() leaves it out and
    // sends it as an Authorization header instead (see basicAuthorization).
    const userinfo =
      withUserinfo && (base.username || base.password)
        ? `${base.username}${base.password ? `:${base.password}` : ""}@`
        : "";
    return `${base.protocol}//${userinfo}${base.host}${basePath}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    // The transport never sees the base URL's userinfo: the engine sends it as an
    // Authorization header, per hop, so a redirect to the same origin (relative or
    // absolute) keeps it and one to another origin or scheme drops it. A transport such
    // as fetch also refuses a URL with credentials outright.
    let url = this.composeUrl(path, options.query, false);
    let headers: Record<string, string> = {
      Accept: options.accept,
      // Advertise the encodings the transport can decode so an RFC-compliant
      // origin (or a compressing proxy) actually compresses and we still decode it.
      "Accept-Encoding": "gzip, deflate, br",
      "User-Agent": this.userAgent,
    };
    const authorization = basicAuthorization(this.#baseUrl);
    if (authorization !== undefined) headers["Authorization"] = authorization;
    /** Why a redirect dropped the base URL's credentials, for a 401/403 message. */
    let dropped: string | undefined;

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.transport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          redirect: "manual",
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // The default transport rejects with HaushaltNetworkError only; an injected one
        // may throw anything, and its text may carry the request URL with the base URL's
        // password (fetch refuses a URL with credentials and quotes it). Keep the
        // library's error contract — every failure is a HaushaltError — and scrub that text.
        if (cause instanceof HaushaltError && !(cause instanceof HaushaltNetworkError)) throw cause;
        if (cause instanceof HaushaltNetworkError && this.scrub(cause.message) === cause.message) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new HaushaltNetworkError(
          cause instanceof HaushaltNetworkError
            ? this.scrub(reason)
            : `${method} ${redactUrl(url)} failed: ${sanitizeServerText(this.scrub(reason))}`,
          { cause: this.scrubCause(cause) },
        );
      }

      // A transport must not follow redirects itself (`redirect: "manual"`): one that did
      // (fetch's default) may have carried the Authorization header to another host, and
      // the answer is not the one asked for. Reject it when it says so (`url`).
      const finalUrl = (response as { url?: unknown }).url;
      if (typeof finalUrl === "string" && finalUrl !== "" && originOf(finalUrl) !== originOf(url)) {
        throw new HaushaltNetworkError(
          `${method} ${redactUrl(url)} failed: the transport followed a redirect to another origin ` +
            `(${sanitizeServerText(redactUrl(this.scrub(finalUrl)))}); a transport must not follow redirects ` +
            `(HttpRequest.redirect is "manual").`,
        );
      }

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL.
      if (status >= 300 && status < 400 && response.headers["location"]) {
        if (redirects >= this.maxRedirects) {
          throw new HaushaltNetworkError(
            `Too many redirects (exceeded maxRedirects=${this.maxRedirects}) for ${method} ${redactUrl(url)}`,
          );
        }
        const location = response.headers["location"];
        if (typeof location === "string" && location.length > 0) {
          const nextUrl = new URL(location, url);
          // Refuse a downgrade from https to plaintext http on redirect.
          if (new URL(url).protocol === "https:" && nextUrl.protocol === "http:") {
            throw new HaushaltNetworkError(
              `Refusing to follow https->http redirect to ${redactUrl(nextUrl.toString())}`,
            );
          }
          // Userinfo in a Location is not used: credentials come from the base URL only,
          // as the Authorization header, never from a server.
          nextUrl.username = "";
          nextUrl.password = "";
          // Cross-origin credential strip: never forward sensitive headers (the base
          // URL's Authorization among them) to a different origin — scheme, host or
          // port — than the one they were issued for. The same origin keeps them,
          // whether the Location is relative or absolute.
          const from = new URL(url);
          if (nextUrl.origin !== from.origin && headers["Authorization"] !== undefined && dropped === undefined) {
            dropped =
              from.protocol === "http:" && nextUrl.protocol === "https:" && from.hostname === nextUrl.hostname
                ? "the server redirected http→https, which dropped the base URL's credentials; use an https base URL"
                : `the redirect to ${nextUrl.origin} dropped the base URL's credentials (they are sent to their own origin only)`;
          }
          headers = stripCrossOriginCredentials(headers, url, nextUrl.toString());
          url = nextUrl.toString();
          redirects += 1;
          continue;
        }
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, status === 401 || status === 403 ? dropped : undefined);
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
      // The Content-Type is attacker-controllable; strip control characters so a
      // hostile endpoint cannot inject terminal escape sequences via this message.
      throw new HaushaltParseError(
        `Expected a JSON response from ${path} but got Content-Type "${sanitizeServerText(mediaType(res.contentType))}"`,
      );
    }
    const text = decodeBody(res.data, res.contentType, path);
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

  private toApiError(method: string, url: string, status: number, body: Buffer, hint?: string): HaushaltApiError {
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    if (hint !== undefined) detail = detail === undefined ? hint : `${detail}; ${hint}`;
    return new HaushaltApiError({ status, url, method, body: text, detail });
  }
}

/**
 * The `Authorization` header for a URL's userinfo (`Basic base64(user:password)`, both
 * percent-decoded, as Node's own http client builds it), or undefined without userinfo.
 */
function basicAuthorization(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.username === "" && parsed.password === "") return undefined;
  const pair = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

/** The origin (scheme, host, port) of a URL, or the value itself if it doesn't parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Decode a response body by the charset of its Content-Type (UTF-8 when none is
 * given, as JSON requires). A leading byte-order mark is dropped: TextDecoder does
 * that by default, where Buffer#toString kept it and JSON.parse then failed. The
 * upstream sends UTF-8; this matters for proxies and mirrors that re-encode.
 */
function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new HaushaltParseError(
      `Unsupported response charset "${sanitizeServerText(charset)}" from ${path}.`,
    );
  }
  return decoder.decode(body);
}

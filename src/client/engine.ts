// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { TextDecoder } from "node:util";
import { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage, type HttpRequest, type HttpResponse, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { assertKnownKeys, assertValid, baseUrlProblem, headerValueProblem } from "./validate.js";
import {
  HaushaltApiError,
  HaushaltError,
  HaushaltNetworkError,
  HaushaltParseError,
  HaushaltValidationError,
  credentialsIn,
  redactCredentials,
  cutText,
  echoedCredentialForms,
  redactSecrets,
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
 * NaN, Infinity, too large) makes the constructor throw a HaushaltValidationError.
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
   * only idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms). Enforced by the
   * engine for every transport.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections, 0..`MAX_RETRIES` (10). Each waits `retryDelayMs * attempt`, or longer
   * if the response's `Retry-After` asks (up to `MAX_RETRY_AFTER_MS`; a longer one is
   * not retried, and the error names the requested wait).
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
   * Enforced by the engine for every transport.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Every EngineOptions key; any other key makes the constructor throw. */
const ENGINE_OPTION_NAMES = [
  "baseUrl",
  "transport",
  "userAgent",
  "timeoutMs",
  "maxRetries",
  "retryDelayMs",
  "maxRedirects",
  "maxResponseBytes",
  "sleep",
] as const satisfies ReadonlyArray<keyof EngineOptions>;

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
 *
 * The result is cut at MAX_SERVER_TEXT_LENGTH characters (ending in "…"; never inside a
 * surrogate pair, `cutText`), so a
 * hostile or broken body can't flood stderr or a CI log with one huge line.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  const line = out.replace(/\s+/g, " ").trim();
  return line.length > MAX_SERVER_TEXT_LENGTH ? `${cutText(line, MAX_SERVER_TEXT_LENGTH)}…` : line;
}

/**
 * Longest server text (in characters) an error message shows: an error `detail`, a
 * redirect target, an echoed Content-Type or a transport's reason.
 * `HaushaltApiError.body` keeps the full text.
 */
export const MAX_SERVER_TEXT_LENGTH = 500;

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

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. Node's transport
 * lower-cases them; a custom one may not (`Retry-After`, `Location`, `Content-Type`), and
 * a fetch transport naturally returns its `Headers` object, which has no plain properties.
 * Such an object (anything with `get` and `forEach`: `Headers`, a `Map`) is copied.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = value;
    });
    return record;
  }
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** The first value of a header (a repeated one arrives as an array). */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a HaushaltNetworkError caused by a reset or aborted connection, which the
 * engine retries — whichever transport raised it (a Node error, fetch's TypeError with
 * an undici cause). A refused connection, a DNS failure or a timeout is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return err instanceof HaushaltNetworkError && hasTransientCode(err.cause);
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
    // A string or object is echoed by type, not value: it may be long or carry anything.
    const shown = typeof value === "number" ? String(value) : `a ${value === null ? "null" : typeof value}`;
    throw new HaushaltValidationError(`Invalid option ${name}: expected an integer from 0 to ${max}, got ${shown}.`);
  }
  return value;
}

/**
 * Read a function-valued option (`transport`, `sleep`): `undefined` gives the default,
 * anything but a function throws a HaushaltValidationError here rather than a raw
 * TypeError ("this.transport is not a function") at request time.
 */
function functionOption<F extends (...args: never[]) => unknown>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new HaushaltValidationError(`Invalid option ${name}: expected a function, got ${value === null ? "null" : typeof value}.`);
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

/** True for a loopback host: `localhost`, 127.0.0.0/8 or `::1` (as URL#hostname spells it). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Whether requests to `baseUrl` would travel unencrypted, as one sentence for a warning
 * (without a `warning: ` prefix), or `undefined` when they would not: for `https:`, for a
 * URL that does not parse, and for a loopback host (`localhost`, 127.0.0.0/8, `::1`),
 * where nothing leaves the machine.
 *
 * The sentence names the host (`url.host`: host and port, never the userinfo) and what
 * secret travels with the requests: the base URL's credentials when it carries userinfo,
 * and every phrase in `secrets` (noun phrases such as "the API key"). It never contains
 * a password or key. The CLI logs it as a `WARN` record of `bundeshaushalt.http` on
 * stderr (once per run, before the first request).
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const userinfo = url.username !== "" || url.password !== "";
  const phrases = [...secrets, ...(userinfo ? ["the base URL's credentials"] : [])];
  if (phrases.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const verb = phrases.length === 1 && !userinfo ? "is" : "are";
  return `${phrases.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages show request URLs through redactUrl.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /**
   * The forms a server echoes that userinfo back in (the Basic value, the decoded
   * `user:password`, the password alone), longest first, so a password never leaves half
   * of the `user:password` around it.
   */
  readonly #echoed: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined.
    options = options ?? {};
    // An unknown key (`timeout` for `timeoutMs`) used to be ignored and the default applied.
    assertKnownKeys("client options", options, ENGINE_OPTION_NAMES);
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
    this.#echoed = credentialsIn(this.#baseUrl)
      .flatMap(echoedCredentialForms)
      .sort((a, b) => b.length - a.length);
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
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
    this.sleep = functionOption("sleep", options.sleep, realSleep);
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL, the Authorization header or the decoded `user:password`) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactSecrets(redactCredentials(text, this.#credentials), this.#echoed);
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

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new HaushaltNetworkError(
          `${request.method} ${redactUrl(request.url)} failed: request timed out after ${this.timeoutMs}ms`,
        );
        controller.abort(err);
        reject(err);
      }, Math.min(this.timeoutMs, MAX_TIMEOUT_MS));
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
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

    // Only an idempotent request is sent again: request() is public, and a POST re-sent
    // after a reset may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          redirect: "manual",
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a proxy) reset is the network-level twin of a 503:
        // retry an idempotent request, whichever transport reported it. Timeouts are not
        // retried — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
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

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the HaushaltError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new HaushaltNetworkError(
          `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
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
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a
      // custom one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new HaushaltNetworkError(`${method} ${redactUrl(url)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }
      const retryable = status === 429 || status === 503;
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      if (retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs * attempt). A Retry-After can ask for longer, never
        // for less: `Retry-After: 0` or a date in the past made a zero-delay burst against a
        // server that had just asked for less load. A Retry-After beyond MAX_RETRY_AFTER_MS
        // is not retried: the error below surfaces at once and names the requested wait.
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL.
      const location = headerValue(responseHeaders["location"]);
      if (status >= 300 && status < 400 && location) {
        if (redirects >= this.maxRedirects) {
          throw new HaushaltNetworkError(
            `Too many redirects (exceeded maxRedirects=${this.maxRedirects}) for ${method} ${redactUrl(url)}`,
          );
        }
        if (typeof location === "string" && location.length > 0) {
          // A Location that doesn't parse (`http://[::1`) is the server's fault, not a
          // bug: a typed network error naming the request, not a bare TypeError.
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, url);
          } catch {
            throw new HaushaltNetworkError(
              `Invalid redirect Location "${sanitizeServerText(this.scrub(location))}" for ${method} ${redactUrl(url)}`,
            );
          }
          // Only http(s) targets are followed; refuse any other scheme (file:, data:,
          // javascript:) here, before any transport sees it.
          if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
            throw new HaushaltNetworkError(
              `Refusing to follow redirect to unsupported protocol "${sanitizeServerText(nextUrl.protocol)}" for ${method} ${redactUrl(url)}`,
            );
          }
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

      const contentType = String(headerValue(responseHeaders["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(
          method,
          url,
          status,
          body,
          status === 401 || status === 403
            ? dropped
            : retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS
              ? `the server asked to wait ${Math.ceil(retryAfter / 1000)} s (Retry-After), longer than the ` +
                `${MAX_RETRY_AFTER_MS / 1000} s the client waits; retrying sooner won't help`
              : undefined,
        );
      }

      return { data: body, contentType, status };
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

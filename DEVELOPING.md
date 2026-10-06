# Developing & integrating

This document covers `bundeshaushalt-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`bundeshaushalt`) and a typed API client
(`BundeshaushaltClient`) for the
[bundeshaushalt.de](https://bundeshaushalt.de/) budget-data portal
(`/internalapi/budgetData`).

> **Stability note.** The client calls an *undocumented, internal endpoint* of
> the portal. It is not a published, stable public API and can change shape,
> rate-limit, or disappear without notice. Treat it as best-effort, especially
> for production or commercial use.

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed budget elements, metadata, and the `account`/`quota`/`unit` enums.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the budget-data endpoint needs no key; this client only reads.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
bundeshaushalt --help
```

## Library usage

```ts
import { BundeshaushaltClient, HaushaltApiError } from "@maschinenlesbar.org/bundeshaushalt-cli";

const client = new BundeshaushaltClient(); // defaults to https://bundeshaushalt.de

const top = await client.budgetData({ year: 2024, account: "expenses" });
console.log(top.meta.year, top.children?.length ?? 0, "children");

// A leaf (a Titel) has no `children`; `related` holds its path in each grouping.
const leaf = await client.budgetData({ year: 2024, account: "expenses", id: "090168301" });
console.log(leaf.related?.agency?.map((a) => a.label).join(" > "));

try {
  await client.budgetData({ year: 1999, account: "expenses" });
} catch (err) {
  if (err instanceof HaushaltApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new BundeshaushaltClient({
  baseUrl: "https://bundeshaushalt.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503: waits Retry-After (<= 30 s), else linear backoff; 0..10
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

Only an omitted (`undefined`) `baseUrl` or `userAgent` selects the default
(`DEFAULT_BASE_URL`, `DEFAULT_USER_AGENT`). A blank one is a
`HaushaltValidationError` from the constructor, as is a bad base URL (see *Base URL
validation* below) or a `userAgent` with a control character (CR/LF included, at
either end too) or a character above U+00FF (`headerValueProblem`, applied by the
exported `assertHeaderValue`); surrounding spaces and tabs are trimmed. The CLI's
`--base-url` and `--user-agent` parsers apply the same rules.

### Methods

`client.budgetData({ year, account, quota?, unit?, id? })`. The `AccountValues` /
`QuotaValues` / `UnitValues` enums are exported for reference, and so are
`UNIT_PREFIX` and `unitOfId(id)`: an id's `G-`/`F-` prefix fixes its unit, so
`budgetData({ year: 2024, account: "expenses", id: "G-5" })` sends `unit=group`,
and `{ id: "14", unit: "group" }` is rejected before any request.

The response types follow the live wire shape, which varies by level: the top-level
`detail` has no `id`/`budgetNumber`; `children` is absent at a leaf; `parents` (one
list per level above) is absent at the top; `related` (a flat breadcrumb list per
grouping) and `detail.pdf` appear only at a leaf. Check the optional fields before
using them.

## Architecture

```
src/
  client/
    enums.ts     # Account / Quota / Unit value sets, MIN_YEAR, UNIT_PREFIX + unitOfId
    types.ts     # BudgetData / BudgetElement / BudgetMeta + param object
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, JSON decoding, error mapping
    errors.ts    # HaushaltError / HaushaltApiError / HaushaltNetworkError / HaushaltParseError / HaushaltValidationError
    validate.ts  # input rules as pure functions (Problem) + assertValid
    client.ts    # BundeshaushaltClient — the budget-data surface over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # budget + expenses/income shortcuts
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The CLI is built around injectable `CliDeps` (client factory + I/O), so the whole program can be
  driven in-process by tests with a mocked client and captured output — no subprocesses.
- `account`/`quota`/`unit` are validated against their enums and the year is range-checked before any
  request by the client (`validateBudgetParams`, exported), and the CLI relies on it. The year must be
  an integer from `MIN_YEAR` to next year (`maxYear()`, `yearProblem`); the `id` non-blank, without
  surrounding whitespace and not a bare `G-`/`F-` prefix (`idProblem`). A library caller gets a
  `HaushaltError` (a `HaushaltValidationError` for the year and the `id`) rather than a request with
  `account=bogus`, `id=` or `id=G-`, which the API answers with a 503 that would be retried. The
  client also owns the id/unit rule: a `G-`/`F-` id sets `unit` when it is omitted (`unitOfId`), and
  a `unit` that contradicts the id is a `HaushaltValidationError` (`idUnitProblem`), because the API
  answers a mismatched pair with a bare 404 for an id that exists. The CLI's own year and id checks are only the
  four-digit shape of `<year>` and an `--id` that looks like an option (`--id --quota`).
  The numeric `EngineOptions` must be integers in
  range (`timeoutMs` 0..2^31−1, `maxRetries` 0..10, `retryDelayMs` 0..30 000, `maxRedirects` 0..20,
  `maxResponseBytes` 0..`Number.MAX_SAFE_INTEGER`); anything else — `NaN`, `Infinity`, `-1`, `1.5` —
  makes the constructor throw a `HaushaltError` naming the option.

### Library / technical terms

**API client.** [`BundeshaushaltClient`](src/client/client.ts) — the typed
wrapper over the budget-data endpoint. Usable as a library independently of the
CLI. Exposes a single method, `budgetData(...)`.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON and
maps errors. Sits between the client and the transport. `DEFAULT_BASE_URL` is
`https://bundeshaushalt.de`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default (`nodeHttpTransport`) uses Node's
built-in `http`/`https`; tests inject a mock. This is the only HTTP seam.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically, up to `--max-retries` (`0`..`MAX_RETRIES`, 10). Each retry
waits the response's `Retry-After` — delay-seconds or an IMF-fixdate HTTP-date,
parsed strictly by the exported `parseRetryAfter` — or, without a usable one,
`retryDelayMs × attempt` (200 ms, 400 ms, …). A `Retry-After` longer than
`MAX_RETRY_AFTER_MS` (30 s) is not retried: the error surfaces at once rather than
retrying inside the window the server asked us to wait out. `HaushaltApiError`
exposes `isRetryable` (true for `429`/`503`).

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses.

**RawResponse.** The engine's raw-response shape (`data`/`contentType`/`status`)
— exported for completeness; the budget endpoint returns decoded JSON.

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, and encodes spaces as `%20` (not `+`). Only `year` +
`account` are always sent; `quota`, `unit` and `id` are included only when set.

**Redirects.** Up to `maxRedirects` (default 5) `3xx` redirects are followed.
A redirect that would downgrade `https` → `http` is refused, and credential
headers are stripped when a redirect crosses origins.

**Base URL validation.** One rule, `baseUrlProblem` ([`validate.ts`](src/client/validate.ts)):
an absolute `http:`/`https:` URL with a host and no query string or fragment. The
`RequestEngine` constructor applies it through the exported `validateBaseUrl`, so
a library caller passing a bad `baseUrl` (`file:`, `ftp:`, `notaurl`, `https:`,
`https://host/?q=1`) gets a `HaushaltValidationError` from `new
BundeshaushaltClient(...)`, before any request. The CLI's `--base-url`
value-parser (`parseBaseUrl` in [`shared.ts`](src/cli/shared.ts)) calls the same
rule and reports its reason as a usage error naming `--base-url` (exit `1`). The
default transport re-checks the scheme on every hop, redirects included, and
reports that as a `HaushaltNetworkError`.
Userinfo in the base URL (`http://user:pw@mirror/`) is kept and sent as Basic
auth, for a mirror behind a login; every error message shows the URL through
`redactUrl` (`http://***@mirror/...`), so the password never reaches a log. The CLI
also redacts on output: `run.ts` (`withRedactedOutput`) takes the exact userinfo of
every argument (`credentialsIn`, exported) and replaces it with `***` in everything it
prints — commander's usage errors, which echo rejected values (a `--base-url` with a
query, a port typo, an unencoded `#`), and the unknown-command message for a URL typed
where the command goes — so a password with spaces, quotes, `#`, `?` or `/` is caught
as well as an ordinary one. `redactUrl` falls back to the same text-based cut
(`redactCredentials`, exported) for a value that doesn't parse as a URL.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `HaushaltValidationError`
(an input rejected before any request, `Invalid <name>: <reason>`), `HaushaltApiError`
(non-2xx, carries `status`/`detail`/`url`/`method`/`body`), `HaushaltNetworkError`
(transport failure/timeout), `HaushaltParseError` (bad JSON, or a 2xx body that is
not an object with `meta` and `detail` objects — `Unexpected response shape from
/internalapi/budgetData: expected a JSON object with meta and detail.`), all extending
`HaushaltError`. The CLI maps a `404` to exit code `4` and every other error,
usage errors included, to `1`; a `HaushaltValidationError` is printed as
`Error: <message>`, like a usage error.

**Input rules.** [`validate.ts`](src/client/validate.ts) holds the library's input
rules as pure, exported functions: a `Problem` returns the reason a value is
invalid, or `undefined`, and `assertValid(name, value, problem)` throws a
`HaushaltValidationError` with `Invalid <name>: <reason>`. The client checks its
inputs with them before any request; the CLI calls the same functions rather than
keeping its own copies, so the same input gives the same outcome on both sides.

**Enum value sets.** `AccountValues`, `QuotaValues`, `UnitValues` — const arrays
that double as runtime CLI choice validators and as TypeScript union types
(`Account`, `Quota`, `Unit`). `MIN_YEAR` (`2012`) is the earliest served year and
`maxYear()` (next year, UTC) the latest accepted one: each summer the portal
publishes the draft budget for the following year.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirects — mocked transport.
- **`client.test.ts`** — the budget-data URL/param mapping and optional-parameter pruning — mocked transport.
- **`cli.test.ts`** — command parsing, the expenses/income shortcuts, validation and exit codes — mocked client.
- **`validate.test.ts`** — `assertValid`, `HaushaltValidationError` and how `run()` reports it.
- **`parity.test.ts`** — the same input through the CLI and through the library on one recording mock transport (`parity()` in `test/helpers.ts`) must give the same outcome.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/bundeshaushalt-cli/> in English
and <https://maschinenlesbar-org.github.io/bundeshaushalt-cli/de/> in German — is built from
`site/` with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web
components and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the
TypeDoc API reference under `/api/`. Its content comes from this repository: the README intro
and quick start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`),
`Usage.md`, `GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill
examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are
`site/_config.yml` and `site/_data/project.yml` (the German intro and the access requirements);
the rest of `site/` is identical in every maschinenlesbar.org CLI, so change it in all of them
together. When the README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/bundeshaushalt-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

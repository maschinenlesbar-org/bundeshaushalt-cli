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
console.log(top.meta.year, top.children.length, "children");

const drill = await client.budgetData({ year: 2024, account: "expenses", id: "090168301" });

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
  maxRetries: 3,              // 429 / 503 are retried with linear backoff
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Methods

`client.budgetData({ year, account, quota?, unit?, id? })`. The `AccountValues` /
`QuotaValues` / `UnitValues` enums are exported for reference.

## Architecture

```
src/
  client/
    enums.ts     # Account / Quota / Unit value sets + MIN_YEAR
    types.ts     # BudgetData / BudgetElement / BudgetMeta + param object
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, JSON decoding, error mapping
    errors.ts    # HaushaltError / HaushaltApiError / HaushaltNetworkError / HaushaltParseError
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
- `account`/`quota`/`unit` are validated against their enums and the year is range-checked before any request.

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
retried automatically with linear backoff, up to `--max-retries`. `HaushaltApiError`
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

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `HaushaltApiError`
(non-2xx, carries `status`/`detail`/`url`/`method`/`body`), `HaushaltNetworkError`
(transport failure/timeout), `HaushaltParseError` (bad JSON), all extending
`HaushaltError`. The CLI maps a `404` to exit code `4`, usage errors to `2`,
and other errors to `1`.

**Enum value sets.** `AccountValues`, `QuotaValues`, `UnitValues` — const arrays
that double as runtime CLI choice validators and as TypeScript union types
(`Account`, `Quota`, `Unit`). `MIN_YEAR` (`2012`) is the earliest served year.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirects — mocked transport.
- **`client.test.ts`** — the budget-data URL/param mapping and optional-parameter pruning — mocked transport.
- **`cli.test.ts`** — command parsing, the expenses/income shortcuts, validation and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

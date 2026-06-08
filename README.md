# bundeshaushalt-cli

A TypeScript **API client** and **command-line interface** for the open
[Bundeshaushalt](https://bundeshaushalt.de/) budget-data API (`bundeshaushalt.de`)
— the **German federal budget**: expenses and income by budget item, functional
area or economic group, planned vs. realised.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed budget elements, metadata and the account/quota/unit enums.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the budget-data API needs no key; this client only reads.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
bundeshaushalt --help
```

---

## How the data is shaped

A query is a **year** + **account** (`expenses` / `income`). Optionally narrow by:

- **quota** — `target` (planned) or `actual` (realised),
- **unit** — `single` (budget item), `function` (functional area) or `group` (economic group),
- **id** — drill into one element (a budget number; `G-` prefix for groups, `F-` for functions).

The response carries the selected `detail`, its `children` (so you can walk the
tree by passing a child's `id` back in), `parents`, and `related` cross-references.

> **Stability / data coverage.** This client talks to an **undocumented, internal
> endpoint** of the portal (`/internalapi/budgetData` — note the `internalapi`
> path). It is **not** a published, stable public API: it can change shape,
> rate-limit, or disappear **without notice**. The data is served without
> authentication and currently covers years from `2012` onward (the exact upper
> range depends on what the portal has published). Treat this dependency as
> best-effort, especially for any production or commercial use.

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://bundeshaushalt.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |

Global options may appear **before or after** the command, e.g. both
`bundeshaushalt --compact expenses 2024` and `bundeshaushalt expenses 2024 --compact`
work (they are resolved with commander's `optsWithGlobals`).

### Commands

```text
budget <year> <account> [--quota target|actual] [--unit single|function|group] [--id <id>]
expenses <year> [--quota] [--unit] [--id]    shortcut for: budget <year> expenses
income   <year> [--quota] [--unit] [--id]    shortcut for: budget <year> income
```

(`<year>` is a four-digit year between `2012` and the current year, inclusive;
the upper bound is derived from the current year so it stays meaningful over time.)

### Examples

```bash
# Top-level federal expenses for 2024
bundeshaushalt expenses 2024

# Realised income, 2023
bundeshaushalt income 2023 --quota actual

# Expenses grouped by economic group
bundeshaushalt budget 2024 expenses --unit group

# Drill into one budget element by id
bundeshaushalt budget 2024 expenses --id 090168301
```

Exit codes: `0` success, `4` on a `404` from the API, `1` for any other error, non-zero for usage errors.

---

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

---

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
    io.ts        # injectable I/O seam (stdout/stderr/file)
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

---

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

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.

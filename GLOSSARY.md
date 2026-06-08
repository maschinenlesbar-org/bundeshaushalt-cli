# Glossary

A reference for the domain concepts and project-specific terms used throughout
`bundeshaushalt-cli`. The Bundeshaushalt domain is German; this glossary gives
the English term used in the CLI/API alongside the original German where one
exists.

> **Translation table.** The CLI/client uses the English terms; the portal and
> the official budget documents use the German ones:
>
> | German | English / API term |
> | --- | --- |
> | Bundeshaushalt | federal budget |
> | Ausgaben | expenses |
> | Einnahmen | income |
> | Soll | target (planned) |
> | Ist | actual (realised) |
> | Einzelplan | single / individual budget item |
> | Funktion | function (functional area) |
> | Gruppe | group (economic group) |
> | Titel | (budget) title / line item |
> | Haushaltsjahr | budget year |

---

## The domain

**Bundeshaushalt (federal budget).** The annual budget of the German federal
government — its planned and realised expenses and income, broken down by
ministry/budget item, functional area and economic group.

**bundeshaushalt.de.** The Federal Ministry of Finance's open data portal that
publishes the federal budget. This tool wraps the JSON endpoint that backs the
portal's interactive views.

**`/internalapi/budgetData`.** The single endpoint this client calls. It is an
**undocumented, internal** route of bundeshaushalt.de (note the `internalapi`
path segment): not a published, stable public API. It can change shape,
rate-limit, or disappear without notice, and is served without authentication.

---

## A budget query

A query is a **year** + **account**, optionally narrowed by **quota**, **unit**
and **id**. The client method is `client.budgetData({ year, account, quota?,
unit?, id? })`; the CLI surfaces it as `budget <year> <account>` plus the
`expenses` / `income` shortcuts.

**year (Haushaltsjahr).** A four-digit budget year. The API serves data from
**`2012`** (`MIN_YEAR`) onward; the CLI's upper bound is the current calendar
year (derived at runtime), since the portal only publishes up to the current
budget year. Required.

**account (`Account`).** Which side of the budget to query — one of:

- `expenses` (Ausgaben) — what the government spends.
- `income` (Einnahmen) — what the government takes in.

Required. The `expenses` and `income` CLI commands are shortcuts that preset it.

**quota (`Quota`).** Planned vs. realised figures — one of:

- `target` (Soll) — planned/budgeted figures. The API default.
- `actual` (Ist) — realised figures.

Optional (`--quota`).

**unit (`Unit`).** How budget elements are grouped — one of:

- `single` — by individual budget item (Einzelplan/Titel). The API default.
- `function` — by functional area (Funktion).
- `group` — by economic group (Gruppe).

Optional (`--unit`).

**id (budget number).** Drills into one element rather than returning the
top-level view. The value is a **budget number** (see below). Walk the tree by
taking a child's `id` from one response and passing it back as the next `--id`.
Optional.

---

## Result shape

**BudgetData.** The response envelope of `/internalapi/budgetData`. Carries
`meta`, the selected `detail`, its `children`, `parents` and `related`.

**BudgetMeta (`meta`).** Metadata describing the current view: the `account`,
`year`, `quota` and `unit` in effect, an optional `entity`, the current/maximum
drill-down depth (`levelCur` / `levelMax`), a `modifyDate` / `timestamp`, and
human-readable `tableLabel` / `selectionLabel` (e.g. "Einzelplan", "Alle
Einzelpläne").

**BudgetElement.** A single budget line, group or function. Key fields:

- `budgetNumber` — the element's budget number (see below).
- `id` — its addressable id (often the budget number, possibly prefixed).
- `label` — the human-readable name.
- `value` — the amount, **in euros**.
- `relativeValue` — this element's share of the whole (a fraction/percentage).
- `relativeToParentValue` — its share of its parent element.
- `tableLabel` / `selectionLabel` — the dimension and selection it belongs to.

**detail.** The currently selected element. NB: the wire field is **singular**
(`detail`), even though it represents the one focused element of the view.

**children.** The elements one level below `detail` — the breakdown you can
drill into by reusing a child's `id`.

**parents.** The ancestor chain(s) of the selected element, as arrays of
`LabeledElement` (id/label pairs) — the path back up to the top level.

**related.** Cross-references to the same element seen along other dimensions:
`agency`, `function` and `group`, each an array of `LabeledElement` rows.

**LabeledElement.** A minimal `{ id?, label? }` pair used in `parents` and
`related` to name an element without its full figures.

---

## Identifiers, units & codes

**Budget number (Haushaltsstelle).** The identifier of a budget element, carried
as `budgetNumber` and used as the `id` to drill in. Prefix conventions surfaced
by the client:

- **`G-`** prefix — a **group** (economic group / Gruppe).
- **`F-`** prefix — a **function** (functional area / Funktion).
- no prefix — a single budget item (Einzelplan/Titel), e.g. `090168301`.

**Einzelplan.** A top-level section of the budget, broadly one per federal
ministry/constitutional body. The `single` unit groups by this dimension.

**Funktion (function).** A functional/purpose classification of spending
(what the money is *for*, independent of which ministry spends it). The
`function` unit groups by this dimension.

**Gruppe (economic group).** An economic classification of a budget line (the
*kind* of expense/income — e.g. personnel, investment). The `group` unit groups
by this dimension.

**Euros.** All `value` figures are amounts in euros (EUR).

**relativeValue / relativeToParentValue.** Proportional figures: an element's
share of the overall total, and of its immediate parent, respectively.

---

## Search & API concepts

**No authentication.** The budget-data endpoint requires no API key or token;
this client performs **read-only** `GET` requests only.

**Query serialisation.** Parameters are serialised into the query string by a
small dependency-free builder (`buildQueryString`): `undefined`/`null` are
dropped, arrays become repeated keys, booleans become `"true"`/`"false"`, and
spaces are encoded as `%20`. Only `year` + `account` are always sent; `quota`,
`unit` and `id` are included only when set.

**Retries / transient errors.** The client retries `429` (rate limited) and
`503` responses automatically with linear backoff (`--max-retries`, default 2).
`HaushaltApiError.isRetryable` is `true` for exactly these statuses.

**Redirects.** Up to `maxRedirects` (default 5) `3xx` redirects are followed.
A redirect that would downgrade `https` → `http` is refused, and credential
headers (`authorization`, `x-api-key`, `cookie`) are stripped when a redirect
crosses origins.

**Response size cap (`maxResponseBytes`).** A hard limit on the response body
(default 100 MiB; `0` disables) that aborts the request if exceeded, guarding
against memory exhaustion from a hostile or buggy endpoint.

**RawResponse.** The engine's low-level result: `{ data: Buffer, contentType,
status }` — raw bytes, decoded to JSON only by `getJson`.

---

## Project / technical terms

**API client.** [`BundeshaushaltClient`](src/client/client.ts) — the typed
wrapper over the budget-data endpoint. Usable as a library independently of the
CLI. Exposes a single method, `budgetData(...)`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON and
maps errors. Sits between the client and the transport. `DEFAULT_BASE_URL` is
`https://bundeshaushalt.de`.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object. Lets the whole
CLI run in tests with a mocked client and captured output — no subprocess.

**Global options.** Cross-cutting CLI flags resolved with commander's
`optsWithGlobals` (so they may appear before or after the command):
`--base-url`, `--timeout`, `--user-agent`, `--max-retries`,
`--max-response-bytes`, `--compact`.

**Enum value sets.** `AccountValues`, `QuotaValues`, `UnitValues` — const arrays
that double as runtime CLI choice validators and as TypeScript union types
(`Account`, `Quota`, `Unit`). `MIN_YEAR` (`2012`) is the earliest served year.

**Error types.** [`errors.ts`](src/client/errors.ts): `HaushaltApiError`
(non-2xx, carries `status`/`detail`/`url`/`method`/`body`), `HaushaltNetworkError`
(transport failure/timeout/bad protocol), `HaushaltParseError` (bad JSON), all
extending `HaushaltError`. The CLI maps a `404` to exit code `4`, other errors
to `1`, and usage errors to a non-zero code.

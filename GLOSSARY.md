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
> | Einzelplan | budget section (top level of `single`) |
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
and **id**. The CLI surfaces it as `budget <year> <account>` plus the
`expenses` / `income` shortcuts.

**year (Haushaltsjahr).** A four-digit budget year. The API serves data from
**`2012`** (`MIN_YEAR`) onward; the CLI's upper bound is next year (derived at
runtime), because each summer the portal publishes the government's draft budget
(Regierungsentwurf) for the following year. Before that draft appears, next year
answers `404` (exit `4`). Required.

**account (`Account`).** Which side of the budget to query — one of:

- `expenses` (Ausgaben) — what the government spends.
- `income` (Einnahmen) — what the government takes in.

Required. The `expenses` and `income` CLI commands are shortcuts that preset it.

**quota (`Quota`).** Planned vs. realised figures — one of:

- `target` (Soll) — planned/budgeted figures. The API default.
- `actual` (Ist) — realised figures.

Optional (`--quota`).

**unit (`Unit`).** How budget elements are grouped — one of:

- `single` — by budget structure: Einzelplan → Kapitel → Titel. The API default.
- `function` — by functional area (Funktion).
- `group` — by economic group (Gruppe).

Optional (`--unit`).

**id (budget number).** Drills into one element rather than returning the
top-level view. Walk the tree by taking a child's `id` from one response and
passing it back as the next `--id`. Optional.

---

## Result shape

**BudgetData.** The response envelope of `/internalapi/budgetData`. Carries
`meta`, the selected `detail`, its `children`, `parents` and `related`.

**BudgetMeta (`meta`).** Metadata describing the current view: the `account`,
`year`, `quota` and `unit` in effect, an optional `entity`, the current/maximum
drill-down depth (`levelCur` / `levelMax`) and a `modifyDate` / `timestamp`.
`meta` carries no `tableLabel` / `selectionLabel`; those are on `detail`.

**BudgetElement.** A single budget line, group or function. Key fields:

- `budgetNumber` — the element's budget number as a masked display string
  (`"0901 683 01 - 165"`, `"14__ ___ __ - ___"`). It is **not** an id: passed to
  `--id` it gives a `404`. Absent on the top-level `detail`.
- `id` — the id to drill in with (`14`, `090168301`, `G-5`). Absent on the
  top-level `detail`.
- `label` — the human-readable name.
- `value` — the amount, **in euros**.
- `relativeValue` — this element's share of the whole budget, **in percent** on a
  0–100 scale (`36.84`, `100`), not a fraction.
- `relativeToParentValue` — its share of its parent element, also in percent.
- `tableLabel` / `selectionLabel` — on `detail` only: the dimension of its children and
  the selection they form (e.g. "Einzelplan", "Alle Einzelpläne"; "Titel" at a leaf).

**detail.** The currently selected element. NB: the wire field is **singular**
(`detail`), even though it represents the one focused element of the view.

**children.** The elements one level below `detail` — the breakdown you can
drill into by reusing a child's `id`. At a leaf (a Titel) the key is **absent**.

**parents.** One array of `LabeledElement` (id/label pairs) per level, from the
top down to the selected element's own level. Each array lists all elements of
that level (the siblings), not just the path. For `single`, the path entry is the
one whose `id` is a prefix of, or equal to, the selected id.

**related.** Cross-references to the same element seen along other dimensions,
present **only at a leaf** (absent above): `agency`, `function` and `group`, each
a flat list of `LabeledElement` rows — the element's path in that dimension, from
the top down.

**LabeledElement.** A minimal `{ id?, label? }` pair used in `parents` and
`related` to name an element without its full figures.

---

## Identifiers, units & codes

**Budget number (Haushaltsstelle).** The identifier of a budget element, used as
its `id` to drill in. `budgetNumber` shows it as a masked display string
(`"0901 683 01 - 165"`), which the API does not accept as an id. Prefix
conventions:

- **`G-`** prefix — a **group** (economic group / Gruppe).
- **`F-`** prefix — a **function** (functional area / Funktion).
- no prefix — an element of the `single` structure: an Einzelplan (`09`), a
  Kapitel (`0901`) or a Titel (`090168301`).

**Einzelplan.** A top-level section of the budget, broadly one per federal
ministry/constitutional body. The `single` unit groups by this dimension; below
it come Kapitel, then Titel.

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

## No authentication

The budget-data endpoint requires no API key or token; this client performs
**read-only** `GET` requests only.

---

## Exit codes

**Exit codes.** The CLI maps outcomes to process exit codes: `0` success;
`4` on `404` (not found: an unknown budget item id, a year without data, or —
with `--quota actual` — a year whose realised figures are not published yet,
which the CLI points out in a hint); `1` for any other error, including usage
and argument-validation errors (an unknown option, an invalid year).
`--help`/`--version` return `0`.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `BundeshaushaltClient`, the request engine, transport, retry/backoff, error
> types, query builder — now live in **[DEVELOPING.md](DEVELOPING.md)**.

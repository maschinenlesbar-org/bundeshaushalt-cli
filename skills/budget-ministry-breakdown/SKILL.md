---
name: budget-ministry-breakdown
description: >
  Break down the German federal budget for a year into a ranked, human-readable
  table — who gets the most money, what share, and (on request) a drill-down into
  one ministry. Trigger when the user asks "what does Germany spend money on?",
  "biggest items in the 2024 federal budget", "how much does the defence/health
  ministry get?", "break the Bundeshaushalt down by economic group / function",
  or wants the budget by ministry (Einzelplan), economic group (Gruppe) or
  functional area (Funktion). Uses the bundeshaushalt-cli.
version: 1.0.0
userInvocable: true
---

# Federal Budget Breakdown

Turn one `bundeshaushalt` query into a **ranked breakdown with euro amounts and shares**,
optionally drilled into a single ministry — instead of the raw JSON envelope the CLI emits.

## Tooling

This skill drives the `bundeshaushalt` command. **Before anything else, validate it is available** — run `command -v bundeshaushalt` (or `bundeshaushalt --version`). If it is not on your PATH, STOP and inform the user that the `bundeshaushalt` CLI (`@maschinenlesbar.org/bundeshaushalt-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the open, key-free budget-data portal (`bundeshaushalt.de`). Read-only, no account. Always pass `--compact` so the result is one line, easy to pipe into `jq`. The endpoint is an **undocumented internal portal API** — bump `--timeout 60000` / `--max-retries 4` if a call stalls or returns `429`.

## Step 1 — Resolve year, account, and grouping

| Decision | Maps to |
|---|---|
| What the government **spends** | `expenses` (default for most asks) |
| What it **takes in** (taxes etc.) | `income` |
| By ministry / top-level section | `--unit single` (default — Einzelplan) |
| By economic kind (personnel, investment…) | `--unit group` (ids are `G-…`) |
| By purpose / policy field | `--unit function` (ids are `F-…`) |
| Planned figures | `--quota target` (default — *Soll*) |
| Realised figures | `--quota actual` (*Ist*) — **only published with a lag; see traps** |

`<year>` is `2012`..current year. The CLI rejects out-of-range years **locally** with exit
`1` before any request.

## Step 2 — Fetch the breakdown

```bash
bundeshaushalt --compact expenses 2024                       # by ministry (default)
bundeshaushalt --compact budget 2024 expenses --unit group  # by economic group
bundeshaushalt --compact budget 2024 expenses --unit function
bundeshaushalt --compact income 2024                         # revenue side
```

The response is one object. The fields that matter:

| Field | Meaning |
|---|---|
| `detail.value` | The **headline total** for the whole view, in **euros** |
| `detail.label` | e.g. `Sollwerte des Haushaltsjahres 2024` |
| `detail.tableLabel` | The dimension of the children: `Einzelplan` for `single`, `Hauptgruppe` for `group`, `Hauptfunktion` for `function` at the top level; `Kapitel` / `Titel` / `Obergruppe` … when drilled. It is on `detail`, **not** `meta` (`meta` has no `tableLabel`, so `jq .meta.tableLabel` gives `null`) |
| `children[]` | The breakdown — one row per ministry / group / function |
| `children[].id` | The drill-in id (e.g. `11`, `G-6`, `F-2`) |
| `children[].label` | Human name, usually `<number> <name>` (e.g. `14 Bundesministerium der Verteidigung`) |
| `children[].value` | Amount in **euros** |
| `children[].relativeValue` | Share of the **whole budget** (a percent, e.g. `36.84`) |
| `children[].relativeToParentValue` | Share of the **parent** element (= relativeValue at top level) |

```bash
bundeshaushalt --compact expenses 2024 \
  | jq -r '.children[] | "\(.value)\t\(.relativeValue|round)%\t\(.label)"'
```

## Step 3 — Rank and format

- **Sort `children` by `value` descending.** The API usually returns them sorted already,
  but don't rely on it — sort yourself.
- Amounts are raw euros. Format for humans: `175675498000` → **€175.7 bn** (or €175,675 m).
  At leaf/Titel level amounts can be small — switch to millions/thousands as appropriate.
- Show the **share** from `relativeValue` (round to 1 decimal). It already sums to ~100% at
  the top level, so you don't compute it.
- Lead with the headline `detail.value` total, then the ranked rows. Cap a long list at the
  top ~10–15 and roll the rest into an "… and N more" / "rest" line with their summed value.

```
Federal expenses 2024 (planned / Soll) — total €476.8 bn

 1. €175.7 bn  36.8%  Bundesministerium für Arbeit und Soziales   (id 11)
 2.  €52.0 bn  10.9%  Bundesministerium der Verteidigung          (id 14)
 3.  €44.1 bn   9.3%  Bundesministerium für Digitales und Verkehr (id 12)
 4.  €39.6 bn   8.3%  Bundesschuld                                (id 32)
 …
```

## Step 4 — Drill into one element (on request)

To zoom into a ministry / group / function, pass its `id` from the children back as `--id`.
**Keep the same `--unit`** you used to get that id (a `G-…` id needs `--unit group`, an
`F-…` id needs `--unit function`; a plain numeric id is `single`).

```bash
bundeshaushalt --compact budget 2024 expenses --id 11           # Kapitel inside ministry 11
bundeshaushalt --compact budget 2024 expenses --id 1102         # Titel inside that Kapitel
bundeshaushalt --compact budget 2024 expenses --unit group --id G-6
```

The drill response carries:
- `detail` — the element you drilled into (its own value/label),
- `children` — the next level down (re-rank these the same way),
- `meta.levelCur` / `meta.levelMax` — depth. For `single` (`levelMax` 3): `0` whole budget
  (children are Einzelpläne) → `1` one Einzelplan, e.g. `--id 14` (`meta.entity` `Section`,
  children are Kapitel) → `2` one Kapitel, e.g. `--id 1405` (`Chapter`, children are Titel)
  → `3` one Titel, e.g. `--id 140555408` (`Title`, the leaf). There is **no Titelgruppe
  level**. `group` and `function` go one level deeper (`levelMax` 4).
- `parents` — one array of `{id,label}` per level, from the top down to the current one,
  each listing **all** elements of that level (the siblings), not just the path. For
  breadcrumbs pick the entry whose `id` is a prefix of the current id (`14` → `1405` →
  `140555408`),
- `related` — **only populated at the leaf level** (`levelCur === levelMax`): the same Titel
  seen as `agency` / `function` / `group` cross-references. Surface these when present —
  they let the user pivot the same line item across dimensions. `null` at higher levels.

When `levelCur === levelMax` you're at a leaf and `children` is `null` (not `[]`) — report
the single amount plus the `related` cross-references, don't claim "no breakdown available".

## Traps

- **Amounts are plain euros, no separators in the JSON.** Don't read `476807656000` as
  millions — it's €476.8 **billion**. Format consistently.
- **`actual` (Ist) lags.** The current year has **only `target`**, and the prior year's
  Ist appears only once its accounts are closed (2025's arrived in July 2026, per its
  `meta.modifyDate`); until then `--quota actual` returns HTTP `404` (exit `4`). That means
  "realised figures not published yet", *not* "nothing was spent". Fall back to `target`
  and say so. (For the plan-vs-actual comparison itself, use the **budget-plan-vs-actual**
  skill.)
- **A 404 (exit `4`) on `--id` = bad id for that year/account/unit combo.** Re-fetch a
  fresh list and pick a valid `id`; not every id exists in every year (e.g. Einzelplan `24`
  only from 2025).
- **`income` and `expenses` totals are equal** (the federal budget is balanced by
  construction) — don't present that as a surplus/deficit finding.
- Don't hand the user raw JSON unless asked; the value of this skill is the ranked,
  euro-formatted, share-annotated table.

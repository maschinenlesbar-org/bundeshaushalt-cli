---
name: budget-plan-vs-actual
description: >
  Compare planned (Soll/target) vs. realised (Ist/actual) figures of the German
  federal budget for a year and rank where the government over- or under-spent.
  Trigger when the user asks "did Germany spend what it planned in 2023?", "which
  ministry overspent / underspent?", "plan vs actual federal budget", "budget
  execution / Soll-Ist comparison", "how much of the defence budget was actually
  used?", or wants variance between budgeted and realised euros. Uses the
  bundeshaushalt-cli, fetching both quotas and computing the deltas.
compatibility: >
  Requires the `bundeshaushalt` CLI (npm package
  @maschinenlesbar.org/bundeshaushalt-cli) on PATH, installed by the user; the
  skill never installs it. Uses jq for JSON filtering. Network access to
  bundeshaushalt.de.
---

# Plan vs. Actual (Soll/Ist) Comparison

Fetch a year **twice** — once `target` (planned / *Soll*), once `actual` (realised / *Ist*)
— line them up by element, and rank where reality diverged from the plan. The CLI returns
one quota at a time; the whole job of this skill is the join + variance the CLI doesn't do.

## Tooling

This skill drives the `bundeshaushalt` command. **Before anything else, validate it is available** — run `command -v bundeshaushalt` (or `bundeshaushalt --version`). If it is not on your PATH, STOP and inform the user that the `bundeshaushalt` CLI (`@maschinenlesbar.org/bundeshaushalt-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

Data comes from the open, key-free portal (`bundeshaushalt.de`). Read-only, no account. Always `--compact`. It's an undocumented internal API — raise `--timeout 60000` / `--max-retries 4` on stalls or `429`.

## Step 0 — Pick a year that HAS actuals (the central trap)

**`actual` (Ist) data is published with a lag.** The current year has **only `target`**,
and the prior year's Ist appears only once its accounts are closed (2025's arrived in July
2026, per its `meta.modifyDate`) — until then `--quota actual` returns HTTP `404` (exit `4`).
Before comparing, confirm actuals exist:

```bash
bundeshaushalt --compact expenses 2024 --quota actual >/dev/null 2>&1; echo $?   # 0 = exists, 4 = not yet
```

If it exits `4`, tell the user that year's realised figures aren't published yet and offer
the **latest year that does** have actuals (walk back a year and re-check). Don't present a
plan-vs-actual for a year where actual = 404; there is nothing to compare against.

## Step 1 — Fetch both quotas, same year / account / unit

```bash
bundeshaushalt --compact expenses 2023 --quota target  > /tmp/bh-target.json
bundeshaushalt --compact expenses 2023 --quota actual  > /tmp/bh-actual.json
```

Use the **same `--unit`** for both (`single` ministries by default; `group` or `function`
work too). The fields that matter (per `children[]` row and on `detail`):

| Field | Meaning |
|---|---|
| `detail.value` | Headline total for that quota, in **euros** |
| `children[].id` | The **join key** — match target↔actual rows on this |
| `children[].label` | Human name (`14 Bundesministerium der Verteidigung`) |
| `children[].value` | Amount in euros for the fetched quota |

> **`actual` values carry cents** (e.g. `457663394853.41`); `target` values are round.
> Keep full precision when subtracting; only round for display.

## Step 2 — Join and compute variance

Match rows by `id`. For each element:

- `delta = actual − target` (euros). Positive = **over** plan, negative = **under**.
- `pct = delta / target` (guard `target === 0`). Express as e.g. `+4.2%` / `−11.0%`.

```bash
jq -n --slurpfile t /tmp/bh-target.json --slurpfile a /tmp/bh-actual.json '
  ($a[0].children | map({(.id): .value}) | add) as $am
  | $t[0].children
  | map(. + {actual: ($am[.id] // null)})
  | map(. + {delta: (if .actual==null then null else (.actual - .value) end)})
  | sort_by(.delta // 0)'
```

Handle the asymmetric cases:
- An `id` in **target but not actual** → planned but not (yet) executed / no realised line.
- An `id` in **actual but not target** → realised spending without a matching plan row.
  Call both out rather than silently dropping them.

## Step 3 — Rank and report

Lead with the **headline totals and overall execution rate**
(`total actual / total target`), then rank the elements by the variance the user cares about:

- biggest **overspend** (largest positive delta) and biggest **underspend** (largest
  negative delta) — show both ends, they're the interesting findings;
- or by **percentage** variance if they asked "which ministry deviated most relatively".

```
Federal expenses 2023 — plan vs. actual (Soll vs. Ist)
Planned €461.2 bn (incl. 1st supplementary budget) · Realised €457.7 bn
Executed 99.2% (−€3.5 bn under plan)

Biggest underspend (planned but not fully used):
  −€3.2 bn  −11.0%  60 Allgemeine Finanzverwaltung
  −€2.7 bn  −18.8%  09 Bundesministerium für Wirtschaft und Klimaschutz
Biggest overspend:
  +€5.5 bn   +3.3%  11 Bundesministerium für Arbeit und Soziales
  +€1.1 bn   +8.2%  06 Bundesministerium des Innern und für Heimat
```

These are the figures the API returned on 2026-09-15, shown for format only. Soll figures
get revised (2023's `target` view was last modified 15.07.2025, and its `detail.label`
says it includes the supplementary budget), so always compute from a fresh fetch and quote
`detail.label` for what the plan covers.

Rules:
- Format euros for humans (€…bn / €…m); show delta **and** percentage.
- "Under plan" is normal and not a scandal — present neutrally, it usually means
  appropriations weren't fully drawn.
- Note any rows that existed in only one quota.
- Offer to drill into any element (pass its `id` back with `--id`, same `--unit`/year, both
  quotas) for a chapter/Titel-level Soll-Ist — see **budget-ministry-breakdown** for drill
  mechanics.

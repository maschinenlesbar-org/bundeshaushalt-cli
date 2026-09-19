---
name: budget-trend
description: >
  Build a multi-year time series from the German federal budget — how total
  spending, a single ministry, an economic group or a functional area has grown
  or shrunk over the years. Trigger when the user asks "how has the defence
  budget changed since 2014?", "trend of federal spending 2012–2024", "has health
  spending gone up?", "year-over-year growth of the education ministry", or wants
  a budget figure tracked across years. Uses the bundeshaushalt-cli, querying each
  year and stitching the series together.
compatibility: >
  Requires the `bundeshaushalt` CLI (npm package
  @maschinenlesbar.org/bundeshaushalt-cli) on PATH, installed by the user; the
  skill never installs it. Uses jq for JSON filtering. Network access to
  bundeshaushalt.de.
---

# Federal Budget Trend (Time Series)

Query the same budget element across a **range of years** and assemble a single time series
with year-over-year and cumulative growth — the cross-year stitch the CLI (one year per
call) deliberately doesn't do.

## Tooling

This skill drives the `bundeshaushalt` command. **Before anything else, validate it is available** — run `command -v bundeshaushalt` (or `bundeshaushalt --version`). If it is not on your PATH, STOP and inform the user that the `bundeshaushalt` CLI (`@maschinenlesbar.org/bundeshaushalt-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

Data comes from the open, key-free portal (`bundeshaushalt.de`). Read-only, no account. Always `--compact`. Undocumented internal API — raise `--timeout 60000` / `--max-retries 4` on stalls or `429`. Be polite querying many years back-to-back; a small gap between calls avoids tripping rate limits.

## Step 1 — Fix what you're tracking and over which years

Decide three things and keep them **constant across every year**:

- **account**: `expenses` (default) or `income`.
- **what**: the whole budget (no `--id`), or one element by `--id` with the matching
  `--unit` (`single` numeric id, `G-…` group, `F-…` function).
- **quota**: `target` (planned) is the safe default for a trend, because **`actual` is only
  published with a lag** — see traps.

Year range is `2012`..current year (the CLI rejects out-of-range years locally). Default to
the full available span unless the user gives endpoints.

## Step 2 — Fetch each year, pull one number

For a **whole-budget** trend, read `detail.value` per year:

```bash
for y in $(seq 2012 2024); do
  v=$(bundeshaushalt --compact expenses "$y" | jq -r '.detail.value')
  printf '%s\t%s\n' "$y" "$v"
done
```

For a **single element** (e.g. defence = ministry `14`), drill with `--id` each year and
read `detail.value`:

```bash
for y in $(seq 2014 2024); do
  v=$(bundeshaushalt --compact budget "$y" expenses --id 14 | jq -r '.detail.value')
  printf '%s\t%s\n' "$y" "$v"
done
```

The number you want is **`detail.value`** (euros) for the element you fixed. (To pick the
element’s `id` from a label first, list one year and grab it — see
**budget-ministry-breakdown**.)

## Step 3 — Handle missing years gracefully

A year may legitimately have no figure for your element:

- **`--quota actual` for recent years → HTTP `404` (exit `4`)** = realised data not
  published yet. For a target-based trend you won't hit this; if the user insists on actuals,
  stop the series at the **last year that returns `0`** and say later years aren't published.
- **`--id` 404 for some years** = that element id didn't exist that year (e.g. Einzelplan
  `24`, Bundesministerium für Digitales und Staatsmodernisierung, exists only from 2025).
  Record the year as a gap rather than aborting the whole series.
- **Match by `id`, not by label.** Einzelplan numbers stay stable while ministry names change
  at every reorganisation: `12` is `Bundesministerium für Digitales und Verkehr` in 2024 and
  `Bundesministerium für Verkehr` from 2025; `30` is `Bundesministerium für Bildung und
  Forschung` in 2024 and `Bundesministerium für Forschung, Technologie und Raumfahrt` from
  2025. A label match would break the series at each rename. A rename usually means
  responsibilities moved, though (digital policy went from `12` to the new `24`, education
  from `30` to `17`), so when the label changes, flag that year as a break in comparability
  rather than presenting the jump as growth.
- Detect 404 by checking the exit code per call (`… ; if [ $? -eq 4 ]; then …`), not by
  parsing stdout.

## Step 4 — Compute and present the series

From the `(year, value)` pairs compute:
- **year-over-year** change: `(v[y] − v[y−1]) / v[y−1]`;
- **cumulative** change over the span: `(v[last] − v[first]) / v[first]`;
- optionally **CAGR** over the span for a clean headline growth rate.

Format euros for humans (€…bn) and present a compact table, newest insight first:

```
Federal expenses, planned (Soll), 2012 → 2024
  2012  €311.6 bn
  …
  2022  €495.8 bn   −13.4% YoY
  2023  €461.2 bn    −7.0% YoY
  2024  €476.8 bn    +3.4% YoY
Over the span: +53% total  (~3.6%/yr CAGR)
```

These are the figures the API returned on 2026-09-15, shown for format only — compute
from a fresh fetch, since Soll figures can be revised.

Rules:
- State the **quota** in the heading (`planned`/`realised`) — a target trend and an actual
  trend are different stories; never silently mix them in one series.
- Call out missing/unpublished years explicitly rather than drawing a line through a gap.
- Nominal euros, not inflation-adjusted — say so if the user is reasoning about real growth.
- A markdown table is the default; offer CSV/JSON or a chartable `(year,value)` list on
  request.

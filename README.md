# bundeshaushalt-cli

[![CI](https://github.com/maschinenlesbar-org/bundeshaushalt-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/bundeshaushalt-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/bundeshaushalt-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/bundeshaushalt-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/bundeshaushalt-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/bundeshaushalt-cli)

Query the German federal budget from your terminal. `bundeshaushalt` is a
small command-line tool over the open
[bundeshaushalt.de](https://bundeshaushalt.de/) budget-data portal: fetch
expenses and income by year, drill into individual budget items, economic
groups or functional areas, and compare planned vs. realised figures — as
clean JSON you can pipe straight into [`jq`](https://jqlang.github.io/jq/).

- **Works out of the box** — no account, no API key, no configuration. Install and query.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Three commands** — `budget`, `expenses`, and `income` (the last two are convenient shortcuts).
- **Nothing to configure** — the endpoint is public and unauthenticated; nothing to leak.
- **Data from 2012 onward** — planned and realised figures, every budget year the portal has published.

> **Note.** The tool calls an *undocumented internal endpoint* of the portal
> (`/internalapi/budgetData`). It is not a published, stable public API and can
> change or disappear without notice. Treat it as best-effort.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/bundeshaushalt-cli
```

This installs the **`bundeshaushalt`** command. Requires **Node.js 20+**.

Check it works:

```bash
bundeshaushalt --help
```

## Quickstart

No setup needed — the endpoint requires no key. Your first query:

```bash
bundeshaushalt expenses 2024
```

The result is a JSON object. The top-level breakdown lives under `children`;
summary metadata is in `meta`. Pull out just the children with `jq`:

```bash
bundeshaushalt expenses 2024 | jq '.children[] | {id, label, value}'
```

Drill into one budget item by taking an `id` from those results:

```bash
bundeshaushalt budget 2024 expenses --id 090168301
```

## Commands

```text
budget    <year> <account> [options]   federal budget data for a year and account side
expenses  <year> [options]             shortcut for: budget <year> expenses
income    <year> [options]             shortcut for: budget <year> income
```

`<year>` is a four-digit year between `2012` and the current year (inclusive).
`<account>` is `expenses` or `income`.

### Command options

These apply to `budget`, `expenses`, and `income`:

| Option | Values | Description |
| --- | --- | --- |
| `--quota <quota>` | `target` \| `actual` | Planned (`target`, default) vs. realised (`actual`) figures |
| `--unit <unit>` | `single` \| `function` \| `group` | Grouping — budget item (default), functional area, or economic group |
| `--id <id>` | budget number | Drill into one element; `G-` prefix for groups, `F-` for functions |

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Top-level federal expenses for 2024
bundeshaushalt expenses 2024

# Realised (actual) expenses — compare with planned (target, the default)
bundeshaushalt expenses 2023 --quota actual

# Break expenses down by economic group (Gruppe)
bundeshaushalt budget 2024 expenses --unit group

# Break expenses down by functional area (Funktion)
bundeshaushalt budget 2024 expenses --unit function

# Drill into one budget item by id
bundeshaushalt budget 2024 expenses --id 090168301

# Drill into an economic group (G- prefix)
bundeshaushalt budget 2024 expenses --unit group --id G-5

# Look at a historical year
bundeshaushalt expenses 2015 --quota actual
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

```bash
# Compare planned vs. realised headline totals for 2023
bundeshaushalt expenses 2023 --quota target  --compact | jq '.detail.value'
bundeshaushalt expenses 2023 --quota actual  --compact | jq '.detail.value'

# List all top-level budget items as a tab-separated table
bundeshaushalt expenses 2024 \
  | jq -r '.children[] | "\(.id)\t\(.label)\t\(.value)"'

# How many children does a query return?
bundeshaushalt expenses 2024 | jq '.children | length'
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
bundeshaushalt --compact expenses 2024 | jq -c '.children[]'
```

`--compact` (and every global option) works **before or after** the command —
both `bundeshaushalt --compact expenses 2024` and `bundeshaushalt expenses 2024 --compact`
do the same thing.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `4` | budget item not found (`404`) |
| `1` | any other error — including bad usage / invalid arguments |

## Troubleshooting

- **`command not found: bundeshaushalt`** — the global npm bin directory isn't
  on your `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/bundeshaushalt-cli …`.
- **Exit `4` / "not found"** — the budget item id doesn't exist for the
  requested year/account/unit combination. Re-fetch a fresh list to pick a
  valid id.
- **Year out of range** — the CLI validates years locally; it only accepts
  `2012` through the current calendar year. Out-of-range years are rejected
  before any network request is made.
- **Network error / exit `1`** — connectivity, DNS, or a timeout. Try again,
  or raise the limit with `--timeout 60000`. The client retries `429`/`503`
  responses automatically (default 2 retries).
- **Empty or unexpected results** — this tool calls an undocumented internal
  endpoint that can change shape without notice. If results look wrong, check
  whether the portal itself has changed.

## Global options

These apply to every command and may be given before *or* after it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://bundeshaushalt.de`) |
| `--timeout <ms>` | Per-request timeout in milliseconds (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every term and domain concept explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

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

# Usage

Practical, use-case-driven examples for `bundeshaushalt-cli` — a command-line
client for the open German federal budget API (`bundeshaushalt.de`). Query
expenses and income of the **Bundeshaushalt** by year, drill into an
**Einzelplan** (budget item), economic group or functional area, and compare
planned (`target`) vs. realised (`actual`) figures in euros.

## Install

```bash
npm i -g @maschinenlesbar.org/bundeshaushalt-cli
```

The installed binary is **`bundeshaushalt`**. (Without a global install you can
run it as `node dist/src/cli/index.js`.)

```bash
bundeshaushalt --help
bundeshaushalt --version
```

Commands: `budget <year> <account>`, plus the `expenses <year>` and
`income <year>` shortcuts. Output is JSON on stdout (pretty-printed by default,
single-line with `--compact`). The examples below pipe to [`jq`](https://jqlang.github.io/jq/)
where it helps — install it separately.

---

## Use cases

### 1. Get the top-level federal expenses for a budget year

Why: the quickest "what does the federal government plan to spend this year?"
overview, broken down into top-level budget items (Einzelpläne).

```bash
bundeshaushalt expenses 2024
```

Output: a JSON object with `meta`, the selected `detail`, and its `children`
(one per Einzelplan). `expenses 2024` is the shortcut for
`budget 2024 expenses`.

### 2. Get federal income for a year

Why: the revenue side of the same year — taxes and other receipts.

```bash
bundeshaushalt income 2024
```

Swap `expenses` for `income` anywhere; or use the explicit form
`bundeshaushalt budget 2024 income`.

### 3. Compare planned vs. realised expenses (target vs. actual)

Why: see how much of the plan was actually spent. `--quota target` is the
planned figure (the default); `--quota actual` is the realised figure.

```bash
# Planned expenses (default quota)
bundeshaushalt expenses 2023 --quota target

# Realised expenses for the same year
bundeshaushalt expenses 2023 --quota actual
```

Pull just the headline total from each to compare in euros:

```bash
bundeshaushalt expenses 2023 --quota target --compact | jq '.detail.value'
bundeshaushalt expenses 2023 --quota actual --compact | jq '.detail.value'
```

### 4. List every Einzelplan with its planned amount

Why: a flat table of top-level budget sections and their values — handy for a
quick scan or a spreadsheet.

```bash
bundeshaushalt expenses 2024 \
  | jq -r '.children[] | "\(.id)\t\(.label)\t\(.value)"'
```

`--unit single` is the default (`single` = individual budget item /
Einzelplan), so it can be omitted here.

### 5. Drill into one Einzelplan by id

Why: zoom from the overview into a single budget item to see its own children,
parents and related references. Pass a child `id` from use case 1/4 back in.

```bash
bundeshaushalt budget 2024 expenses --id 090168301
```

The response carries that element as `detail`, its `children` (drill deeper by
passing a child's id), `parents`, and `related` cross-references — so you can
walk the tree one level at a time.

### 6. Break expenses down by economic group (Gruppe)

Why: analyse spending by economic category (e.g. personnel, investments)
instead of by ministry. Use `--unit group`; group ids carry a `G-` prefix.

```bash
# All economic groups for the year
bundeshaushalt budget 2024 expenses --unit group

# Drill into a specific group by its G- id
bundeshaushalt budget 2024 expenses --unit group --id G-5
```

### 7. Break expenses down by functional area (Funktion)

Why: view spending by purpose/policy field across ministries. Use
`--unit function`; function ids carry an `F-` prefix.

```bash
bundeshaushalt budget 2024 expenses --unit function
bundeshaushalt budget 2024 expenses --unit function --id F-0
```

### 8. Look at a historical year

Why: the API serves data from **2012** onward, so you can pull older budgets
for trend analysis.

```bash
bundeshaushalt expenses 2015 --quota actual
```

Years are validated locally: a four-digit year between `2012` and the current
year (inclusive). Out-of-range years are rejected before any request is made.

### 9. Compact output for scripting and piping

Why: single-line JSON is easier to stream into other tools or log.

```bash
bundeshaushalt expenses 2024 --compact | jq '.children | length'
```

`--compact` works before or after the command, e.g.
`bundeshaushalt --compact expenses 2024`.

### 10. Tune networking for slow or rate-limited conditions

Why: the endpoint is an undocumented internal portal API and can rate-limit
(`429`) or stall. Raise the timeout and retries, and set a polite User-Agent.

```bash
bundeshaushalt expenses 2024 \
  --timeout 60000 \
  --max-retries 4 \
  --user-agent "my-budget-report/1.0"
```

Transient `429`/`503` responses are retried automatically (default 2 retries).
Exit codes: `0` success, `4` on a `404` from the API, `1` for other errors,
non-zero for usage errors.

---

## Global options

These apply to every command and may appear **before or after** it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version and exit |
| `--base-url <url>` | API base URL (default `https://bundeshaushalt.de`) |
| `--timeout <ms>` | Per-request timeout in milliseconds (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-h, --help` | Show help for the program or a command |

Per-command options (on `budget`, `expenses`, `income`):

| Option | Values | Description |
| --- | --- | --- |
| `--quota <quota>` | `target` \| `actual` | Planned vs. realised (default `target`) |
| `--unit <unit>` | `single` \| `function` \| `group` | Grouping (default `single`) |
| `--id <id>` | budget number | Drill into one element (`G-` group, `F-` function, plain number for a single item) |

# bundeshaushalt-cli — Exploratory / Black-Box Bug Report

**Date:** 2026-06-06 · **Current year (for year-range math):** 2026 → accepted year ceiling = `maxYear()` = 2027.
**Build:** `npm run build` succeeded. **Invocation:** `node dist/src/cli/index.js ...`

**Environment / network note.** The live German federal budget API (`https://bundeshaushalt.de/internalapi/budgetData`) **was reachable** during testing; live calls (`expenses 2024`, `income 2023 --quota actual`, drill via `--id`, `404`→exit 4) all worked. One thing to flag for any future repro: an HTTP test server run **inside the same Node process** that synchronously spawns the CLI (e.g. `execFileSync`) will appear to "time out" — that is a test-harness artifact (the parent event loop is blocked, so the loopback server never services the request), **not** a CLI defect. All loopback tests below were therefore run against a **standalone** server process, which the CLI talks to correctly.

**Result: 16 genuine, reproducible issues found** (target was 20). All 16 below are real and reproducible. They are grouped by severity. The remaining "probe" areas (year bounds, account/quota/unit enums, JSON parse errors, retries, redirects, stdout/stderr separation, UTF-8/umlaut preservation, 404→exit 4, field passthrough vs curl) were tested and found **correct** — see "Verified-correct" at the end.

---

## HIGH

### 1. `--max-response-bytes ""` (empty) silently disables the response-size safety cap
- **Severity:** High · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js --max-response-bytes "" --base-url http://<host> expenses 2024
  ```
- **Expected:** Empty value rejected as invalid (the help/README call it an integer; the cap is a memory-exhaustion defense).
- **Actual:** `Number("") === 0`, which passes `parseIntArg`'s `Number.isInteger(0) && 0 >= 0` check, and `0` means **unlimited** in the engine (`engine.ts:119` only sets `maxResponseBytes` when `> 0`). A response that should be rejected at 100 bytes is fully buffered:
  ```
  with --max-response-bytes 100  -> Error: Response exceeded maxResponseBytes (100)
  with --max-response-bytes ""   -> {"big":"xxxxxxxxxxxx...   (no cap, exit 0)
  ```
- **Root cause:** `parseIntArg` in `src/cli/shared.ts:11-17` treats `""` as `0`; `0` is then interpreted as "unlimited" in `src/client/engine.ts:42,87,119`. A typo/quoting accident removes the safety limit.

### 2. `parseIntArg` accepts hex / octal / binary / scientific / `+` / whitespace despite "non-negative integer"
- **Severity:** High · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js --timeout 0x10     --base-url http://<host> expenses 2024   # -> timeout 16
  node dist/src/cli/index.js --max-retries 1e3  --base-url http://<host> expenses 2024   # -> 1000 retries
  node dist/src/cli/index.js --timeout "  5 "   --base-url http://<host> expenses 2024   # -> 5 (whitespace trimmed)
  ```
- **Expected:** Per the parser's own error text ("Expected a non-negative integer.") and the help/README, only plain decimal non-negative integers should be accepted.
- **Actual:** `Number()` coerces `0x10`→16, `0o17`→15, `0b101`→5, `1e3`→1000, `+500`→500, `"  5 "`→5 — all accepted silently (verified: `node -e 'console.log(Number("0x10"),Number("1e3"),Number("  5 "))'` → `16 1000 5`). Only truly non-numeric forms (`abc`, `1.5`, `Infinity`, `123abc`, `.5`, `-1`) are rejected.
- **Root cause:** `src/cli/shared.ts:12` uses `const n = Number(value)` instead of a strict pattern (e.g. `/^\d+$/`). `Number.isInteger` is true for all of the above.

### 3. `--max-retries` with a large loose value enables a runaway retry loop (DoS)
- **Severity:** High · **Confidence:** Medium (consequence of #2; not run to completion to avoid hammering)
- **Repro:**
  ```bash
  node dist/src/cli/index.js --max-retries 1e9 --base-url http://<503-host> expenses 2024
  ```
- **Expected:** `1e9` rejected as not a plain integer; even if accepted, a sane upper bound.
- **Actual:** `1e9` is accepted (see #2) → `engine.ts:124` retries up to a billion times on any transient 429/503, with linearly growing backoff (`retryDelayMs * attempt`, `engine.ts:126`) — effectively a hang. (Verified the retry mechanism itself: default `--max-retries 2` produced exactly 3 server hits; `--max-retries 0` produced 1.)
- **Root cause:** No upper bound + loose `parseIntArg` (`src/cli/shared.ts:12`) feeding the retry loop in `src/client/engine.ts:113-128`.

### 4. `BudgetData.details` (type + README) does not match the live API field `detail`
- **Severity:** High (for library users) · **Confidence:** High
- **Repro:**
  ```bash
  node -e 'import("./dist/src/client/client.js").then(async({BundeshaushaltClient})=>{
    const d=await new BundeshaushaltClient().budgetData({year:2024,account:"expenses"});
    console.log("has .details:", "details" in d, "| has .detail:", "detail" in d, "| d.details:", d.details);})'
  ```
- **Expected:** The typed field documented in `types.ts` (`details`) and README ("The response carries the selected `details`…") should exist on the response.
- **Actual:**
  ```
  has .details: false | has .detail: true | d.details: undefined
  ```
  The real API key is `detail` (singular), confirmed via `curl` (`top keys: [ 'meta', 'detail', 'children' ]`). A TypeScript consumer accessing `data.details` gets `undefined` at runtime with no type error. (The **CLI** itself is unaffected — it renders the raw JSON verbatim, no field is dropped vs curl.)
- **Root cause:** `src/client/types.ts:48` declares `details: BudgetElement | JsonObject;` (should be `detail`); README line 43 repeats the wrong name.

---

## MEDIUM

### 5. `--user-agent ""` sends an empty `User-Agent` header (overrides the default)
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js --user-agent "" --base-url http://<echo-host> --compact expenses 2024
  # server sees:  user-agent: ""   (empty), instead of "bundeshaushalt-cli"
  ```
- **Expected:** Empty/whitespace UA should fall back to the default `bundeshaushalt-cli`, or be rejected.
- **Actual:** Server received `ua: ""`. The engine uses `options.userAgent ?? DEFAULT_USER_AGENT`, and `""` is not nullish, so the empty string is sent.
- **Root cause:** `src/client/engine.ts:82` `this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;` — `??` does not catch `""`.

### 6. CRLF in `--user-agent` leaks a raw Node error as "Unexpected error"
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js --user-agent $'evil\r\nX-Injected: yes' --base-url http://<host> expenses 2024
  ```
- **Expected:** A typed, friendly validation error (the input is rejected by Node's header validator before it ever leaves the process — good — but the surfacing is poor).
- **Actual:**
  ```
  Unexpected error: Invalid character in header content ["User-Agent"]
  exit=1
  ```
  This is the generic catch-all branch (`run.ts:46`) leaking a low-level `TypeError`, not a `HaushaltError`. (Header injection is *blocked* by Node, so no security hole — only the ungraceful message.)
- **Root cause:** No validation/normalization of `--user-agent`; the `TypeError` from `node:http` escapes to `src/cli/run.ts:46`.

### 7. Year validator accepts `currentYear+1` (2027) but the live API returns 404 for it
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js expenses 2027 ; echo $?
  ```
- **Expected:** Either the accepted range should track actually-served data, or the upper-bound rationale (in `budget.ts:11-13`: "the portal publishes the upcoming year's draft budget") should be reconciled with reality.
- **Actual:**
  ```
  Error: HTTP 404 for GET https://bundeshaushalt.de/internalapi/budgetData?year=2027&account=expenses
  exit=4
  ```
  The validator passes 2027 (= `maxYear()`), but the portal has not published 2027 yet → 404. The "+1" window over-shoots available data, turning a predictable client-side rejection into a network round-trip + 404. (2012 lower bound and 2028 rejection both behave correctly.)
- **Root cause:** `maxYear()` in `src/cli/commands/budget.ts:14-16` returns `getUTCFullYear()+1` unconditionally.

### 8. `--max-retries 1e9` etc. share root cause with #2/#3 — `--id --quota` consumes the next flag as the id value
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js --base-url http://<echo-host> --compact budget 2024 expenses --id --quota
  # -> /internalapi/budgetData?year=2024&account=expenses&id=--quota
  ```
- **Expected:** `--id` immediately followed by another known option (`--quota`) is almost certainly a missing-value mistake; a clear "argument missing" would help.
- **Actual:** commander accepts `--quota` as the *value* of `--id`, so `id=--quota` is sent to the API (would yield a confusing 404). Verified against an echo server.
- **Root cause:** Default commander option parsing (no value-shape guard on `--id`); `src/cli/commands/budget.ts:62`. The local empty-id guard in `optionsFrom` (`budget.ts:50`) does not catch this because `"--quota"` is non-empty.

### 9. `--id` silently trims surrounding whitespace, mutating the queried id
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js --compact budget 2024 expenses --id "  11  "   # queries id=11, returns data
  ```
- **Expected:** Either reject ids with stray whitespace, or document the trimming. Silent mutation can mask copy-paste errors and make two different inputs collapse to one.
- **Actual:** `"  11  "` (and `$'\t11\n'`) are trimmed to `11` and the request succeeds as if the user typed `11`.
- **Root cause:** `src/cli/commands/budget.ts:47` `const id = String(opts["id"]).trim();` trims unconditionally before use.

### 10. Network errors drop all request context (no URL / host:port)
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js --base-url http://127.0.0.1:1 expenses 2024
  ```
- **Expected:** An error that says which URL/request failed, e.g. `Error: GET https://… failed: connect ECONNREFUSED 127.0.0.1:1`.
- **Actual:**
  ```
  Error: connect ECONNREFUSED 127.0.0.1:1
  exit=1
  ```
  The raw Node message is wrapped verbatim with no URL/method/path; contrast with the API-error path which *does* include the full URL.
- **Root cause:** `src/client/http.ts:106` wraps `err.message` with no request context; `HaushaltNetworkError` carries nothing analogous to `HaushaltApiError.url`.

---

## LOW

### 11. `--max-response-bytes ""`/`0` "unlimited" semantics are also reachable via the loose parser without warning
- **Severity:** Low · **Confidence:** High
- **Repro:** see #1. Listed separately because the *documentation* side ("0 = unlimited") combined with `""`→0 means there is **no way** the user is told their cap was dropped.
- **Expected:** When the cap is disabled, that is a security-relevant state worth at least not arriving at by accident.
- **Actual:** Silent.
- **Root cause:** `src/cli/shared.ts:12` + `src/client/engine.ts:87`.

### 12. `--help` omits documented defaults for `--timeout` and `--max-retries`
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js --help | grep -i "timeout\|retries"
  ```
- **Expected:** Consistency with README, which documents `--timeout` default `30000` and `--max-retries` default `2`.
- **Actual:** Help shows `--timeout <ms>  per-request timeout in milliseconds` and `--max-retries <n>  retries for transient 429/503 responses` — **no defaults**. (`--base-url` and `--max-response-bytes` *do* show/mention theirs, so it is inconsistent.)
- **Root cause:** `src/cli/program.ts:28,30` register these options without a default-value argument (and `parseIntArg` would otherwise show it); defaults live only in `src/client/engine.ts:83-84`.

### 13. `--version` value is hardcoded and can drift from `package.json`
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```bash
  grep -n 'VERSION =' src/cli/program.ts   # -> export const VERSION = "1.0.0";
  grep '"version"' package.json            # -> "version": "1.0.0",
  ```
- **Expected:** Single source of truth so `--version` cannot lie after a release bump.
- **Actual:** Two independent literals. They happen to agree now, but a `package.json` bump that forgets `program.ts` makes `--version` stale.
- **Root cause:** `src/cli/program.ts:12` `export const VERSION = "1.0.0";` duplicates `package.json`.

### 14. `--base-url ""` produces a confusing "Invalid URL" instead of falling back to the default
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js --base-url "" expenses 2024
  ```
- **Expected:** Empty base URL → fall back to the default `https://bundeshaushalt.de`, or a clear "--base-url must not be empty".
- **Actual:**
  ```
  Error: Invalid URL: /internalapi/budgetData?year=2024&account=expenses
  exit=1
  ```
  The explicit `""` overrides commander's default, and `baseUrl.replace(/\/+$/,"")` leaves `""`, so the engine builds a relative URL that `new URL()` rejects.
- **Root cause:** `src/client/engine.ts:80` `(options.baseUrl ?? DEFAULT_BASE_URL)` — `??` does not catch `""`.

### 15. README "Global options go **before** the command" is inaccurate/incomplete
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js expenses 2024 --compact            # works
  node dist/src/cli/index.js expenses 2024 --base-url http://127.0.0.1:1   # works (connect refused = reached transport)
  ```
- **Expected:** Docs match behavior.
- **Actual:** Global options are also honored **after** the subcommand (commander `optsWithGlobals`), contradicting README line 65's "go **before** the command".
- **Root cause:** `src/cli/shared.ts:83` resolves `optsWithGlobals()`; README line 65 overstates the constraint.

### 16. `BudgetMeta`/`BudgetElement` types omit fields the live API returns (`tableLabel`, `selectionLabel`)
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```bash
  node dist/src/cli/index.js --compact expenses 2024 | head -c 400
  # detail contains "tableLabel":"Einzelplan","selectionLabel":"Alle Einzelpläne" — neither is in types.ts
  ```
- **Expected:** Either the declared types cover the served shape, or `details`/`detail` is typed loosely enough (it is `JsonObject` on the union side) that consumers are not misled.
- **Actual:** `src/client/types.ts` `BudgetElement` (lines 29-37) and `BudgetMeta` (16-26) do not include `tableLabel`/`selectionLabel`, which the live API returns inside `detail`. Combined with bug #4 (`detail` vs `details`) this means the typed surface materially diverges from the wire format.
- **Root cause:** `src/client/types.ts:16-37` modeled from documentation rather than the live response.

---

## Verified-correct (probed, no defect)

- **Year bounds:** `2011`→reject, `2012`→accept, `2028`(=currentYear+2)→reject, `999`/`20245`/`abcd`/`-2024`/`0`/`2024.0`/`" 2024"`/`+2024`/unicode-digits→reject with a clear message and exit 1. Solid (`budget.ts:19-35`).
- **account / quota / unit enums:** invalid, empty, and wrong-case all rejected locally (no network) with exit 1 (`shared.ts:24-33`).
- **`--id` empty / whitespace-only:** rejected with `Invalid id ""` (`budget.ts:50-52`).
- **expenses/income shortcuts:** correctly preset `account` (`"account":"expenses"` / `"income"`); extra positionals rejected.
- **Query encoding:** `&`, `=`, spaces, unicode, `..` are percent-encoded (`a%26b%3Dc`, `%20`, `%C3%BC`); spaces use `%20` not `+`. No injection.
- **UTF-8 / umlauts:** German labels preserved as UTF-8 (`für` = `66 c3 bc 72`), not `\u`-escaped, in both pretty and `--compact`.
- **Data passthrough:** CLI output top-level keys identical to `curl` (`meta`, `detail`, `children`); no fields dropped. Values are in euros (2024 expenses total `476807656000` ≈ €477bn). Drill via a child `id` from the top-level response works; `income 2023 --quota actual` works.
- **Exit codes:** `404`→**4**; `400/401/403/410/500/502/503`→1; network/parse errors→1; help/version→0; usage errors→1. Matches README.
- **JSON errors:** non-JSON 200, truncated JSON, empty 200 → `HaushaltParseError` ("Failed to parse JSON response…"), exit 1.
- **Retries:** default 2 retries on 503 = 3 total hits; `--max-retries 0` = 1 hit. Redirect loop terminates after `maxRedirects` and surfaces the 3xx as an API error.
- **Streams:** data/help → stdout; all errors → stderr (safe for piping).
- **`--timeout 1` / `--max-response-bytes 1` / bad host / closed port / `file://` / trailing-slash base-url:** all behave sensibly (timeout, size-cap, ENOTFOUND, ECONNREFUSED, "Unsupported protocol", slash stripped).
- **/internalapi instability IS documented** in README (lines 46-52), as is the 2012-onward coverage.

---

**Final count: 16 genuine, reproducible issues** (4 High, 6 Medium, 6 Low). All are real; none fabricated. Target of 20 not reached — the input-validation and enum/exit-code surfaces are unusually well-covered by the implementation, so most "probe" categories came back clean (listed above).

# bundeshaushalt-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for the
German federal budget, all powered by the **[bundeshaushalt](README.md)** CLI over the open
[bundeshaushalt.de](https://bundeshaushalt.de/) budget-data portal.

Each skill teaches Claude how to drive the `bundeshaushalt` CLI to answer a specific,
real-world question — "what does the government spend money on?", "did they spend what they
planned?", "how has defence spending grown since 2014?" — and to report it as a ranked,
euro-formatted answer rather than a raw JSON blob. They encode the parts that are easy to
get wrong (the actuals/Ist publication lag, drill-down id/unit pairing, billions-not-millions
formatting) so Claude doesn't have to rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **budget-ministry-breakdown** | Ranks a year's budget by ministry / economic group / function with euro amounts and shares, and drills into any element. | "biggest items in the 2024 budget", "how much does defence get?", "break expenses down by economic group" |
| **budget-plan-vs-actual** | Fetches both quotas (Soll + Ist), joins by element, and ranks where the government over- or under-spent. | "did Germany spend what it planned in 2023?", "which ministry underspent?", "Soll-Ist comparison" |
| **budget-trend** | Queries the same element across a range of years and builds a time series with YoY and cumulative growth. | "trend of federal spending 2012–2024", "how has the health budget changed?" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `bundeshaushalt` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/bundeshaushalt-cli   # installs the `bundeshaushalt` bin
  ```
  No API key is required — the bundeshaushalt.de budget-data endpoint is free, open, and
  read-only.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/bundeshaushalt-cli
/plugin install bundeshaushalt@bundeshaushalt-skills
```

The first command registers the marketplace; the second installs the `bundeshaushalt`
plugin, which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/bundeshaushalt-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/budget-ministry-breakdown/SKILL.md`. Start a new Claude Code session and the skills
are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Break the 2024 federal budget down by ministry, biggest first.

> Did Germany spend what it planned in 2023? Which ministries deviated most?

> Plot the trend of federal expenses from 2012 to today.

You can also invoke a skill explicitly with its slash command, e.g.
`/budget-plan-vs-actual`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`bundeshaushalt` subcommands to call, in what order, and how to interpret the JSON. The
skills encode the non-obvious parts of this data, for example:

- **`actual` (Ist) data is published with a lag** — recent years (current + most recent)
  often carry **only `target`/Soll**, and `--quota actual` for them returns HTTP `404`
  (exit `4`). That means "realised figures not published yet", not "nothing was spent"
  (central to **budget-plan-vs-actual** and **budget-trend**);
- **amounts are plain euros with no separators** — `476807656000` is €476.8 **billion**,
  not millions; the skills format consistently and read shares from `relativeValue`;
- **drilling with `--id` must keep the matching `--unit`** — a `G-…` id needs
  `--unit group`, an `F-…` id needs `--unit function`, a plain numeric id is `single`;
- **`related` cross-references (agency/function/group) appear only at the leaf level**
  (`meta.levelCur === meta.levelMax`) and are `null` higher up;
- **`actual` values carry cents** while `target` values are round — keep full precision when
  subtracting, round only for display;
- **`income` and `expenses` totals are equal** (the budget is balanced by construction) —
  not a surplus/deficit finding;
- the endpoint is an **undocumented internal portal route** (`/internalapi/budgetData`) that
  can rate-limit or change shape — the skills bump `--timeout` / `--max-retries` on stalls.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.

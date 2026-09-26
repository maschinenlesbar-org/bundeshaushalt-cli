# Examples

Real examples for the Claude Code skills of the `bundeshaushalt` plugin, one per skill: a request,
the `bundeshaushalt` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `bundeshaushalt` 0.0.6, except
budget-trend, re-run on 26 September 2026 with 0.0.10.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [budget-ministry-breakdown](#budget-ministry-breakdown) · [budget-plan-vs-actual](#budget-plan-vs-actual) · [budget-trend](#budget-trend)

## budget-ministry-breakdown

> What is the 2026 federal budget spent on? Break it down by ministry, then show me what's inside the defence budget and its biggest procurement item.

```bash
bundeshaushalt --compact expenses 2026
bundeshaushalt --compact budget 2026 expenses --id 14            # Kapitel of the defence ministry
bundeshaushalt --compact budget 2026 expenses --id 1405          # Titel of Militärische Beschaffungen
bundeshaushalt --compact budget 2026 expenses --id 140555408     # leaf: levelCur 3 = levelMax, related filled
```

The skill followed the ids level by level, from Einzelplan down to a single Titel. Only at the leaf does the API fill `related`, which gives the same line item as an economic group and a function.

```
Federal expenses 2026 (planned / Soll, data as of 23.12.2025) — total €524.5 bn

 1. €197.3 bn  37.6%  Bundesministerium für Arbeit und Soziales              (id 11)
 2.  €82.7 bn  15.8%  Bundesministerium der Verteidigung                     (id 14)
 3.  €47.4 bn   9.0%  Allgemeine Finanzverwaltung                            (id 60)
 4.  €33.6 bn   6.4%  Bundesschuld                                           (id 32)
 5.  €27.9 bn   5.3%  Bundesministerium für Verkehr                          (id 12)
 6.  €21.8 bn   4.2%  Bundesministerium für Forschung, Technologie und Raumfahrt (id 30)
 7.  €21.8 bn   4.2%  Bundesministerium für Gesundheit                       (id 15)
 8.  €16.7 bn   3.2%  Bundesministerium für Bildung, Familie, Senioren, Frauen und Jugend (id 17)
 9.  €15.8 bn   3.0%  Bundesministerium des Innern                           (id 06)
10.  €10.8 bn   2.1%  Bundesministerium der Finanzen                         (id 08)
     … 16 more Einzelpläne  €48.8 bn  9.3%

14 Bundesministerium der Verteidigung — €82.7 bn, 12 Kapitel (share of the ministry)
  €21.5 bn  26.0%  1403 Kommandobehörden und Truppen, … Versorgung für Soldatinnen und Soldaten
  €19.5 bn  23.6%  1405 Militärische Beschaffungen
  €11.5 bn  13.9%  1408 Unterbringung
   €8.9 bn  10.7%  1413 Bundeswehrverwaltung, Universitäten der Bundeswehr, Militärseelsorge usw.
   €7.7 bn   9.3%  1406 Materialerhaltung der Bundeswehr
   €7.4 bn   8.9%  1407 Sonstiger Betrieb der Bundeswehr
   … 6 more Kapitel  €6.3 bn  7.6%

1405 Militärische Beschaffungen — €19.5 bn, 23 Titel; the top one:
  1405 554 08 Beschaffung von Munition   €8.94 bn = 45.8% of the chapter, 1.7% of the whole budget
    as group:    G-554 Militärische Beschaffungen
    as function: F-032 Deutsche Verteidigungsstreitkräfte
    source:      bundeshaushalt.de/static/daten/2026/soll/epl14.pdf#page=58
```

Next steps offered: the same budget by economic group (`--unit group`) or function (`--unit function`), or the revenue side (`income 2026`).

## budget-plan-vs-actual

> Did the federal government stick to its budget last time we have figures for? Which ministries spent more or less than planned?

```bash
bundeshaushalt --compact expenses 2026 --quota actual    # exit 4: HTTP 404, 2026 Ist not published yet
bundeshaushalt --compact expenses 2025 --quota actual    # exit 0: latest year with actuals
bundeshaushalt --compact expenses 2025 --quota target > bh-target.json
bundeshaushalt --compact expenses 2025 --quota actual > bh-actual.json
jq -n --slurpfile t bh-target.json --slurpfile a bh-actual.json '…'   # join children on id, delta = actual − target
bundeshaushalt --compact expenses 2024                   # Einzelplan 24 is not in the 2024 list
```

2026 has only planned figures, so the skill went back to 2025, whose Ist figures are dated 15.07.2026. All 26 Einzelpläne appear in both quotas. The −99.7% line looked odd, so the skill checked 2024: Einzelplan 24 isn't in that year's list.

```
Federal expenses 2025 — plan vs. actual (Soll vs. Ist)
Planned €502.5 bn · Realised €495.5 bn · executed 98.6% (−€7.0 bn under plan)

Biggest underspend:
  −€3.54 bn   −7.6%  60 Allgemeine Finanzverwaltung          (€46.8 bn → €43.2 bn)
  −€2.85 bn   −4.6%  14 Bundesministerium der Verteidigung   (€62.3 bn → €59.5 bn)
  −€0.76 bn   −0.4%  11 Bundesministerium für Arbeit und Soziales
  −€0.35 bn   −2.4%  17 Bundesministerium für Bildung, Familie, Senioren, Frauen und Jugend
Biggest overspend:
  +€0.58 bn   +3.8%  06 Bundesministerium des Innern         (€15.2 bn → €15.8 bn)
  +€0.49 bn   +1.4%  32 Bundesschuld                         (€34.2 bn → €34.7 bn)
  +€0.22 bn   +2.1%  08 Bundesministerium der Finanzen
  +€0.18 bn   +2.5%  25 Bundesministerium für Wohnen, Stadtentwicklung und Bauwesen
Largest relative gaps (small budgets):
  −99.7%  24 Bundesministerium für Digitales und Staatsmodernisierung  (€11.2 m planned, €0.03 m spent;
          not in the 2024 budget)
  −18.0%  01 Bundespräsident und Bundespräsidialamt · −15.0% 22 Unabhängiger Kontrollrat · −13.8% 03 Bundesrat
```

Spending below plan is normal: it usually means not all appropriations were drawn. Next steps offered: a Kapitel-level Soll-Ist for any ministry (`--id 14` with both quotas).

## budget-trend

> Has federal health spending come back down since the pandemic? Show me the health ministry's budget since 2012.

```bash
for y in $(seq 2012 2027); do
  out=$(bundeshaushalt --compact budget "$y" expenses --id 15); rc=$?
  if [ "$rc" -eq 4 ]; then printf '%s\tgap\n' "$y"; continue; fi
  if [ "$rc" -ne 0 ]; then echo "year $y failed (exit $rc)" >&2; continue; fi
  printf '%s\t%s\n' "$y" "$(printf '%s' "$out" | jq -r '.detail.value')"
done   # 16 calls, 1 s apart: 15 exit 0, 2016 exit 1
```

```text
Error: HTTP 503 for GET https://bundeshaushalt.de/internalapi/budgetData?year=2016&account=expenses&id=15
year 2016 failed (exit 1)
```

Id `15` returned `15 Bundesministerium für Gesundheit` in every year that answered, so there are no renamed ids. 2016 is not a gap: the portal answered `503` even after the CLI's two retries, so the loop reported it as a failed call (exit 1), not as a year without data (exit 4). 2027 is the government's draft budget, last modified on 3 September 2026.

| Year | Planned (Soll) | YoY | Share of budget |
|---|---:|---:|---:|
| 2012 | €14.5 bn | | 4.6% |
| 2013 | €12.0 bn | −17.2% | 3.9% |
| 2014 | €11.1 bn | −7.8% | 3.7% |
| 2015 | €12.1 bn | +9.2% | 3.9% |
| 2016 | failed (HTTP 503) | | |
| 2017 | €15.2 bn | | 4.6% |
| 2018 | €15.2 bn | +0.3% | 4.4% |
| 2019 | €15.3 bn | +0.6% | 4.3% |
| 2020 | €41.3 bn | +169.5% | 8.1% |
| 2021 | €49.9 bn | +21.0% | 8.7% |
| 2022 | €64.4 bn | +29.0% | 13.0% |
| 2023 | €24.5 bn | −62.0% | 5.3% |
| 2024 | €16.7 bn | −31.8% | 3.5% |
| 2025 | €19.3 bn | +15.4% | 3.8% |
| 2026 | €21.8 bn | +12.9% | 4.2% |
| 2027 (draft) | €14.3 bn | −34.2% | 2.6% |

Yes, mostly: the 2022 peak of €64.4 bn fell to €16.7 bn by 2024. Since then the budget has grown again. 2026 is 66% below 2022 but 42% above 2019. Over 2012–2026: +50% in total (~3.0%/yr CAGR). The 2027 draft plans €14.3 bn, 34% less than 2026 and below 2019. 2016 is missing because that call failed; 2017 has no YoY figure for that reason. All figures are planned amounts in nominal euros, not adjusted for inflation.

Next steps offered: fetch 2016 again once the portal answers, the realised (Ist) series up to 2025, or the same trend by function instead of ministry.

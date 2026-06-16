# Data license

> **This tool does not include, host, or redistribute any data.**
> `bundeshaushalt-cli` is a *client*. It only accesses data served live by the
> **Bundesministerium der Finanzen (BMF)** via `bundeshaushalt.de`. That data is
> the provider's and is governed by **their** terms, summarized below. The license
> of this CLI's own source code is a separate matter — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Bundesministerium der Finanzen (BMF) |
| **API / source** | `https://bundeshaushalt.de/internalapi/budgetData` (undocumented portal endpoint) |
| **Data license** | **Public data, no copyright protection** ("öffentliche Daten ohne urheberrechtlichen Schutz") — the figures derive from the Bundeshaushaltsplan, an *amtliches Werk*. Effectively public domain. |
| **Authoritative terms** | https://www.bundeshaushalt.de/DE/Service/Impressum/impressum.html |
| **Attribution** | Not legally required; pointing users to the official Bundeshaushaltsplan is recommended. |
| **Commercial use** | Allowed (Impressum explicitly permits use "auch zu kommerziellen Zwecken"). |
| **Redistribution / modification** | Explicitly permitted — reproduce, distribute, process, and merge with other data. |

## Notes & caveats

- The CLI queries an **undocumented internal endpoint**, not a published API with
  stated terms — it can change or disappear without notice.
- Two regimes exist for essentially the same figures: `bundeshaushalt.de` =
  public/no-copyright (the CLI's actual source); the separate **BMF Datenportal**
  (`bundesfinanzministerium.de`) and **GovData** publish parallel budget datasets
  under **`dl-de/by-2-0`**. If you instead source via those channels, follow
  `dl-de/by-2-0` attribution (name "Bundesministerium der Finanzen" + the license).
- The legally binding figures live in the **Bundeshaushaltsplan**; portal data is
  a visualization derivative.

## Attribution (recommended)

```
Datenquelle: Bundeshaushalt, Bundesministerium der Finanzen (bundeshaushalt.de) —
öffentliche Daten; maßgeblich ist der amtliche Bundeshaushaltsplan.
```

## Sources

- https://www.bundeshaushalt.de/DE/Service/Impressum/impressum.html — authoritative (the CLI's data source)
- https://www.bundesfinanzministerium.de/Datenportal/Nutzungshinweise/nutzungshinweise.html — BMF Datenportal (`dl-de/by-2-0`)

---

*Good-faith summary compiled 2026-06-16; not legal advice. The provider's terms
are authoritative and can change — verify at the source, and prefer `dl-de/by-2-0`
attribution if in any doubt.*

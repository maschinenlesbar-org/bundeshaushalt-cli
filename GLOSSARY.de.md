# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`bundeshaushalt-cli` verwendet werden. Die Domäne Bundeshaushalt ist deutsch; dieses
Glossar nennt den englischen Begriff aus CLI und API neben dem deutschen Original, sofern
es einen gibt.

> **Übersetzungstabelle.** CLI und Client verwenden die englischen Begriffe, das Portal und
> die amtlichen Haushaltsdokumente die deutschen:
>
> | Deutsch | Englisch / API-Begriff |
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

## Die Domäne

**Bundeshaushalt.** Der jährliche Haushalt der Bundesregierung – ihre geplanten und
tatsächlichen Ausgaben und Einnahmen, aufgeschlüsselt nach Ministerium bzw. Einzelplan,
Funktion und ökonomischer Gruppe.

**bundeshaushalt.de.** Das offene Datenportal des Bundesministeriums der Finanzen, das den
Bundeshaushalt veröffentlicht. Dieses Tool kapselt den JSON-Endpoint, der hinter den
interaktiven Ansichten des Portals steht.

**`/internalapi/budgetData`.** Der einzige Endpoint, den dieser Client aufruft. Es ist eine
**undokumentierte, interne** Route von bundeshaushalt.de (erkennbar am Pfadsegment
`internalapi`) und keine veröffentlichte, stabile öffentliche API. Aufbau, Ratenbegrenzung
oder Verfügbarkeit können sich ohne Ankündigung ändern; sie wird ohne Authentifizierung
ausgeliefert.

---

## Eine Haushaltsabfrage

Eine Abfrage besteht aus **year** + **account**, optional eingegrenzt durch **quota**, **unit**
und **id**. Die CLI bietet sie als `budget <year> <account>` sowie über die Kurzbefehle
`expenses` / `income` an.

**year (Haushaltsjahr).** Ein vierstelliges Haushaltsjahr. Die API liefert Daten ab
**`2012`** (`MIN_YEAR`); die Obergrenze der CLI ist das aktuelle Kalenderjahr (zur Laufzeit
ermittelt), da das Portal nur bis zum aktuellen Haushaltsjahr veröffentlicht. Pflichtangabe.

**account (`Account`).** Welche Seite des Haushalts abgefragt wird – einer der Werte:

- `expenses` (Ausgaben) – was der Bund ausgibt.
- `income` (Einnahmen) – was der Bund einnimmt.

Pflichtangabe. Die CLI-Befehle `expenses` und `income` sind Kurzbefehle, die den Wert vorbelegen.

**quota (`Quota`).** Geplante oder tatsächliche Zahlen – einer der Werte:

- `target` (Soll) – geplante bzw. veranschlagte Zahlen. Standard der API.
- `actual` (Ist) – tatsächliche Zahlen.

Optional (`--quota`).

**unit (`Unit`).** Wie Haushaltselemente gruppiert werden – einer der Werte:

- `single` – nach Haushaltsgliederung: Einzelplan → Kapitel → Titel. Standard der API.
- `function` – nach Funktion.
- `group` – nach ökonomischer Gruppe.

Optional (`--unit`).

**id (Haushaltsstelle).** Steigt in ein einzelnes Element ab, statt die oberste Ansicht zu
liefern. Den Baum durchlaufen Sie, indem Sie die `id` eines Kindelements aus einer Antwort
als nächstes `--id` übergeben. Optional.

---

## Aufbau der Antwort

**BudgetData.** Die Antwortstruktur von `/internalapi/budgetData`. Enthält
`meta`, das ausgewählte `detail`, dessen `children`, `parents` und `related`.

**BudgetMeta (`meta`).** Metadaten zur aktuellen Ansicht: die geltenden Werte für `account`,
`year`, `quota` und `unit`, ein optionales `entity`, die aktuelle und maximale
Aufschlüsselungstiefe (`levelCur` / `levelMax`) sowie ein `modifyDate` / `timestamp`.
`meta` enthält kein `tableLabel` / `selectionLabel`; diese stehen in `detail`.

**BudgetElement.** Eine einzelne Haushaltszeile, Gruppe oder Funktion. Wichtige Felder:

- `budgetNumber` – die Haushaltsstelle des Elements (siehe unten).
- `id` – seine adressierbare ID (oft die Haushaltsstelle, eventuell mit Präfix).
- `label` – der lesbare Name.
- `value` – der Betrag, **in Euro**.
- `relativeValue` – der Anteil dieses Elements am Ganzen (ein Bruchteil bzw. Prozentwert).
- `relativeToParentValue` – sein Anteil am übergeordneten Element.
- `tableLabel` / `selectionLabel` – nur in `detail`: die Dimension seiner Kindelemente und
  die Auswahl, die sie bilden (z. B. „Einzelplan“, „Alle Einzelpläne“; „Titel“ auf der
  untersten Ebene).

**detail.** Das aktuell ausgewählte Element. Hinweis: Das Feld in der Antwort steht im
**Singular** (`detail`), obwohl es das eine fokussierte Element der Ansicht darstellt.

**children.** Die Elemente eine Ebene unter `detail` – die Aufschlüsselung, in die Sie
mit der `id` eines Kindelements weiter absteigen können.

**parents.** Ein Array von `LabeledElement` (Paare aus ID und Bezeichnung) je Ebene, von
oben bis zur Ebene des ausgewählten Elements. Jedes Array enthält alle Elemente dieser Ebene
(die Geschwister), nicht nur den Pfad. Bei `single` ist der Pfad-Eintrag derjenige, dessen
`id` ein Präfix der ausgewählten ID ist oder ihr entspricht.

**related.** Querverweise auf dasselbe Element aus Sicht anderer Dimensionen:
`agency`, `function` und `group`, jeweils ein Array von `LabeledElement`-Zeilen.

**LabeledElement.** Ein minimales Paar `{ id?, label? }`, das in `parents` und
`related` ein Element benennt, ohne seine vollständigen Zahlen.

---

## Kennungen, Einheiten & Codes

**Haushaltsstelle.** Die Kennung eines Haushaltselements, geführt als `budgetNumber` und
als `id` zum Absteigen verwendet. Konventionen für Präfixe:

- Präfix **`G-`** – eine **Gruppe** (ökonomische Gruppe).
- Präfix **`F-`** – eine **Funktion**.
- kein Präfix – ein Element der `single`-Gliederung: ein Einzelplan (`09`), ein Kapitel
  (`0901`) oder ein Titel (`090168301`).

**Einzelplan.** Ein Abschnitt der obersten Ebene des Haushalts, im Wesentlichen einer je
Bundesministerium bzw. Verfassungsorgan. Die Einheit `single` gruppiert nach dieser Dimension;
darunter folgen Kapitel, dann Titel.

**Funktion (function).** Eine funktionale Gliederung der Ausgaben nach Zweck (*wofür* das
Geld ausgegeben wird, unabhängig davon, welches Ministerium es ausgibt). Die Einheit
`function` gruppiert nach dieser Dimension.

**Gruppe.** Eine ökonomische Gliederung einer Haushaltszeile (die *Art* der Ausgabe oder
Einnahme – z. B. Personal, Investitionen). Die Einheit `group` gruppiert nach dieser
Dimension.

**Euro.** Alle `value`-Angaben sind Beträge in Euro (EUR).

**relativeValue / relativeToParentValue.** Anteilswerte: der Anteil eines Elements an der
Gesamtsumme bzw. an seinem unmittelbar übergeordneten Element.

---

## Keine Authentifizierung

Der Endpoint für Haushaltsdaten benötigt weder API-Schlüssel noch Token; dieser Client
führt ausschließlich **lesende** `GET`-Anfragen aus.

---

## Exit-Codes

**Exit-Codes.** Die CLI bildet Ergebnisse auf Prozess-Exit-Codes ab: `0` bei Erfolg;
`4` bei `404` (Haushaltsposten nicht gefunden); `1` bei allen anderen Fehlern, auch bei
Aufruf- und Argumentvalidierungsfehlern (unbekannte Option, ungültiges Jahr).
`--help`/`--version` liefern `0`.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `BundeshaushaltClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder – stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)**.

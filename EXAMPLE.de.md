# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `bundeshaushalt`, eines pro Skill: eine
Anfrage, die `bundeshaushalt`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `bundeshaushalt` 0.0.6 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [budget-ministry-breakdown](#budget-ministry-breakdown) · [budget-plan-vs-actual](#budget-plan-vs-actual) · [budget-trend](#budget-trend)

## budget-ministry-breakdown

> Wofür gibt der Bund 2026 sein Geld aus? Bitte nach Ministerien aufschlüsseln, dann den Verteidigungshaushalt und dort den größten Beschaffungsposten zeigen.

```bash
bundeshaushalt --compact expenses 2026
bundeshaushalt --compact budget 2026 expenses --id 14            # Kapitel des Verteidigungsministeriums
bundeshaushalt --compact budget 2026 expenses --id 1405          # Titel von Militärische Beschaffungen
bundeshaushalt --compact budget 2026 expenses --id 140555408     # Blatt: levelCur 3 = levelMax, related gefüllt
```

Der Skill ist den ids Ebene für Ebene gefolgt, vom Einzelplan bis zu einem einzelnen Titel. Erst auf der untersten Ebene liefert die API `related`. Darüber lässt sich derselbe Posten als Gruppe und als Funktion aufrufen.

```
Bundesausgaben 2026 (Soll, Datenstand 23.12.2025) – gesamt 524,5 Mrd. €

 1. 197,3 Mrd. €  37,6 %  Bundesministerium für Arbeit und Soziales              (id 11)
 2.  82,7 Mrd. €  15,8 %  Bundesministerium der Verteidigung                     (id 14)
 3.  47,4 Mrd. €   9,0 %  Allgemeine Finanzverwaltung                            (id 60)
 4.  33,6 Mrd. €   6,4 %  Bundesschuld                                           (id 32)
 5.  27,9 Mrd. €   5,3 %  Bundesministerium für Verkehr                          (id 12)
 6.  21,8 Mrd. €   4,2 %  Bundesministerium für Forschung, Technologie und Raumfahrt (id 30)
 7.  21,8 Mrd. €   4,2 %  Bundesministerium für Gesundheit                       (id 15)
 8.  16,7 Mrd. €   3,2 %  Bundesministerium für Bildung, Familie, Senioren, Frauen und Jugend (id 17)
 9.  15,8 Mrd. €   3,0 %  Bundesministerium des Innern                           (id 06)
10.  10,8 Mrd. €   2,1 %  Bundesministerium der Finanzen                         (id 08)
     … 16 weitere Einzelpläne  48,8 Mrd. €  9,3 %

14 Bundesministerium der Verteidigung – 82,7 Mrd. €, 12 Kapitel (Anteil am Ministerium)
  21,5 Mrd. €  26,0 %  1403 Kommandobehörden und Truppen, … Versorgung für Soldatinnen und Soldaten
  19,5 Mrd. €  23,6 %  1405 Militärische Beschaffungen
  11,5 Mrd. €  13,9 %  1408 Unterbringung
   8,9 Mrd. €  10,7 %  1413 Bundeswehrverwaltung, Universitäten der Bundeswehr, Militärseelsorge usw.
   7,7 Mrd. €   9,3 %  1406 Materialerhaltung der Bundeswehr
   7,4 Mrd. €   8,9 %  1407 Sonstiger Betrieb der Bundeswehr
   … 6 weitere Kapitel  6,3 Mrd. €  7,6 %

1405 Militärische Beschaffungen – 19,5 Mrd. €, 23 Titel; der größte:
  1405 554 08 Beschaffung von Munition   8,94 Mrd. € = 45,8 % des Kapitels, 1,7 % des Gesamthaushalts
    als Gruppe:    G-554 Militärische Beschaffungen
    als Funktion:  F-032 Deutsche Verteidigungsstreitkräfte
    Quelle:        bundeshaushalt.de/static/daten/2026/soll/epl14.pdf#page=58
```

Als Nächstes angeboten: derselbe Haushalt nach Gruppen (`--unit group`) oder Funktionen (`--unit function`) oder die Einnahmenseite (`income 2026`).

## budget-plan-vs-actual

> Hat sich der Bund im letzten Jahr mit vorliegenden Zahlen an seinen Haushalt gehalten? Welche Ministerien haben mehr oder weniger ausgegeben als geplant?

```bash
bundeshaushalt --compact expenses 2026 --quota actual    # Exit 4: HTTP 404, Ist 2026 noch nicht veröffentlicht
bundeshaushalt --compact expenses 2025 --quota actual    # Exit 0: jüngstes Jahr mit Ist-Werten
bundeshaushalt --compact expenses 2025 --quota target > bh-target.json
bundeshaushalt --compact expenses 2025 --quota actual > bh-actual.json
jq -n --slurpfile t bh-target.json --slurpfile a bh-actual.json '…'   # children über id verbinden, delta = actual − target
bundeshaushalt --compact expenses 2024                   # Einzelplan 24 fehlt in der Liste für 2024
```

Für 2026 gibt es nur Soll-Werte, deshalb ging der Skill auf 2025 zurück. Die Ist-Werte dafür haben den Stand 15.07.2026. Alle 26 Einzelpläne kommen in beiden Quoten vor. Die Abweichung von −99,7 % fiel auf, deshalb hat der Skill 2024 geprüft: Einzelplan 24 steht nicht in der Liste dieses Jahres.

```
Bundesausgaben 2025 – Soll und Ist
Soll 502,5 Mrd. € · Ist 495,5 Mrd. € · Ausschöpfung 98,6 % (7,0 Mrd. € unter Plan)

Größte Unterschreitung:
  −3,54 Mrd. €   −7,6 %  60 Allgemeine Finanzverwaltung          (46,8 → 43,2 Mrd. €)
  −2,85 Mrd. €   −4,6 %  14 Bundesministerium der Verteidigung   (62,3 → 59,5 Mrd. €)
  −0,76 Mrd. €   −0,4 %  11 Bundesministerium für Arbeit und Soziales
  −0,35 Mrd. €   −2,4 %  17 Bundesministerium für Bildung, Familie, Senioren, Frauen und Jugend
Größte Überschreitung:
  +0,58 Mrd. €   +3,8 %  06 Bundesministerium des Innern         (15,2 → 15,8 Mrd. €)
  +0,49 Mrd. €   +1,4 %  32 Bundesschuld                         (34,2 → 34,7 Mrd. €)
  +0,22 Mrd. €   +2,1 %  08 Bundesministerium der Finanzen
  +0,18 Mrd. €   +2,5 %  25 Bundesministerium für Wohnen, Stadtentwicklung und Bauwesen
Größte relative Abweichungen (kleine Etats):
  −99,7 %  24 Bundesministerium für Digitales und Staatsmodernisierung  (11,2 Mio. € Soll, 0,03 Mio. € Ist;
           im Haushalt 2024 nicht enthalten)
  −18,0 %  01 Bundespräsident und Bundespräsidialamt · −15,0 % 22 Unabhängiger Kontrollrat · −13,8 % 03 Bundesrat
```

Ausgaben unter Plan sind normal: Meist wurden nicht alle Mittel abgerufen. Als Nächstes angeboten: ein Soll-Ist-Vergleich auf Kapitelebene für ein Ministerium (`--id 14` mit beiden Quoten).

## budget-trend

> Sind die Gesundheitsausgaben des Bundes nach der Pandemie wieder gesunken? Bitte den Etat des Gesundheitsministeriums seit 2012.

```bash
for y in $(seq 2012 2026); do bundeshaushalt --compact budget "$y" expenses --id 15 | jq -r '.detail.value'; done   # 15 Aufrufe, alle Exit 0
```

Die id `15` lieferte in jedem Jahr `15 Bundesministerium für Gesundheit`. Die Reihe hat also keine Lücken und keine umbenannten ids.

| Jahr | Soll | ggü. Vorjahr | Anteil am Haushalt |
|---|---:|---:|---:|
| 2012 | 14,5 Mrd. € | | 4,6 % |
| 2013 | 12,0 Mrd. € | −17,2 % | 3,9 % |
| 2014 | 11,1 Mrd. € | −7,8 % | 3,7 % |
| 2015 | 12,1 Mrd. € | +9,2 % | 3,9 % |
| 2016 | 14,6 Mrd. € | +20,8 % | 4,6 % |
| 2017 | 15,2 Mrd. € | +4,0 % | 4,6 % |
| 2018 | 15,2 Mrd. € | +0,3 % | 4,4 % |
| 2019 | 15,3 Mrd. € | +0,6 % | 4,3 % |
| 2020 | 41,3 Mrd. € | +169,5 % | 8,1 % |
| 2021 | 49,9 Mrd. € | +21,0 % | 8,7 % |
| 2022 | 64,4 Mrd. € | +29,0 % | 13,0 % |
| 2023 | 24,5 Mrd. € | −62,0 % | 5,3 % |
| 2024 | 16,7 Mrd. € | −31,8 % | 3,5 % |
| 2025 | 19,3 Mrd. € | +15,4 % | 3,8 % |
| 2026 | 21,8 Mrd. € | +12,9 % | 4,2 % |

Großenteils ja: Vom Höchststand 2022 (64,4 Mrd. €) fiel der Etat bis 2024 auf 16,7 Mrd. €. Seitdem wächst er wieder. 2026 liegt er 66 % unter 2022, aber 42 % über 2019. Von 2012 bis 2026 stieg er insgesamt um 50 % (rund 3,0 % pro Jahr). Alle Werte sind Soll-Werte in nominalen Euro, nicht inflationsbereinigt.

Als Nächstes angeboten: die Ist-Reihe bis 2025 oder derselbe Trend nach Funktion statt nach Ministerium.

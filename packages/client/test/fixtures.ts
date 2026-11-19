// Recorded budgetData answers (bundeshaushalt.de, 2026-11-19), cut down to a few children, and a
// mock of the portal over them: the operations' tests and the MCP server's tests use both.

import type { HttpResponse } from "../src/http.js";
import type { Account, Quota, Unit } from "../src/enums.js";
import type { BudgetData, LabeledElement } from "../src/types.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";

/** One view as the portal sends it: `children` as [id, label, euros], shares computed from `total`. */
export function view(spec: {
  year: number;
  account?: Account;
  quota?: Quota;
  unit?: Unit;
  id?: string;
  label: string;
  value: number;
  total?: number;
  childrenAre?: string;
  children?: [string, string, number][];
  level?: number;
  levelMax?: number;
  parents?: LabeledElement[][];
  related?: BudgetData["related"];
  pdf?: string[];
}): BudgetData {
  const total = spec.total ?? spec.value;
  const share = (value: number, of: number) => (of === 0 ? 0 : (value / of) * 100);
  return {
    meta: {
      year: spec.year,
      account: spec.account ?? "expenses",
      quota: spec.quota ?? "target",
      unit: spec.unit ?? "single",
      entity: spec.id === undefined ? "Budget" : "Section",
      levelCur: spec.level ?? (spec.id === undefined ? 0 : 1),
      levelMax: spec.levelMax ?? 3,
      modifyDate: "28.03.2024",
    },
    detail: {
      ...(spec.id === undefined ? {} : { id: spec.id }),
      label: spec.label,
      value: spec.value,
      relativeValue: share(spec.value, total),
      relativeToParentValue: 100,
      ...(spec.childrenAre === undefined ? {} : { tableLabel: spec.childrenAre }),
      ...(spec.pdf === undefined ? {} : { pdf: spec.pdf }),
    },
    ...(spec.children === undefined
      ? {}
      : { children: spec.children.map(([id, label, value]) => ({ id, label, value, relativeValue: share(value, total), relativeToParentValue: share(value, spec.value) })) }),
    ...(spec.parents === undefined ? {} : { parents: spec.parents }),
    ...(spec.related === undefined ? {} : { related: spec.related }),
  };
}

/** Expenses 2024, planned, by Einzelplan: four of the 25, not in the API's order. */
export const expenses2024 = view({
  year: 2024,
  label: "Sollwerte des Haushaltsjahres 2024",
  value: 476807656000,
  childrenAre: "Einzelplan",
  children: [
    ["14", "14 Bundesministerium der Verteidigung", 51951938000],
    ["11", "11 Bundesministerium für Arbeit und Soziales", 175675498000],
    ["32", "32 Bundesschuld", 39571791000],
    ["12", "12 Bundesministerium für Digitales und Verkehr", 44145217000],
  ],
});

/** Expenses 2024, realised (Ist, with cents): 12 and 32 as recorded, 14 under plan, 11 over, 60 only here. */
export const expenses2024Actual = view({
  year: 2024,
  quota: "actual",
  label: "Istwerte des Haushaltsjahres 2024",
  value: 474753727609.58,
  childrenAre: "Einzelplan",
  children: [
    ["11", "11 Bundesministerium für Arbeit und Soziales", 181573418713.62],
    ["14", "14 Bundesministerium der Verteidigung", 50287144857.59],
    ["12", "12 Bundesministerium für Digitales und Verkehr", 45259478281.89],
    ["60", "60 Allgemeine Finanzverwaltung", 1000000.41],
  ],
});

const TOP_2024: LabeledElement[] = [{ id: null, label: "Sollwerte des Haushaltsjahres 2024" }];
const EINZELPLAENE_2024: LabeledElement[] = [
  { id: "11", label: "11 Bundesministerium für Arbeit und Soziales" },
  { id: "14", label: "14 Bundesministerium der Verteidigung" },
  { id: "12", label: "12 Bundesministerium für Digitales und Verkehr" },
];

/** Einzelplan 14 in 2024, planned: three of its Kapitel. */
export const ministry14 = view({
  year: 2024,
  id: "14",
  label: "14 Bundesministerium der Verteidigung",
  value: 51951938000,
  total: 476807656000,
  childrenAre: "Kapitel",
  children: [
    ["1408", "1408 Unterbringung", 7729144000],
    ["1403", "1403 Kommandobehörden und Truppen", 18845110000],
    ["1405", "1405 Militärische Beschaffungen", 2746193000],
  ],
  parents: [TOP_2024, EINZELPLAENE_2024],
});

/** A Titel (a leaf): no children, the PDF page, the same line in the other groupings. */
export const titel140555408 = view({
  year: 2024,
  id: "140555408",
  label: "1405 554 08 Beschaffung von Munition",
  value: 467225000,
  total: 476807656000,
  level: 3,
  pdf: ["https://www.bundeshaushalt.de/static/daten/2024/soll/epl14.pdf#page=56"],
  parents: [
    TOP_2024,
    EINZELPLAENE_2024,
    [{ id: "1403", label: "1403 Kommandobehörden und Truppen" }, { id: "1405", label: "1405 Militärische Beschaffungen" }],
    [{ id: "140555410", label: "1405 554 10 Beschaffung von Feldzeug" }, { id: "140555408", label: "1405 554 08 Beschaffung von Munition" }],
  ],
  related: {
    agency: [{ id: "14", label: "14 Bundesministerium der Verteidigung" }, { id: "1405", label: "1405 Militärische Beschaffungen" }],
    group: [{ id: "G-5", label: "5 Sächliche Verwaltungsausgaben" }, { id: "G-55", label: "55 Militärische Beschaffungen" }, { id: "G-554", label: "554 Militärische Beschaffungen" }],
    function: [{ id: "F-0", label: "0 Allgemeine Dienste" }, { id: "F-03", label: "03 Verteidigung (nur Bund)" }],
  },
});

/** The key the portal mock files a view under: year/account/quota/unit/id, as the request sends them. */
export function viewKey(year: number, account: Account = "expenses", quota: Quota = "target", unit: Unit = "single", id = ""): string {
  return `${year}/${account}/${quota}/${unit}/${id}`;
}

/** The key of a view, from its meta and detail. */
function keyOf(data: BudgetData): string {
  const id = typeof data.detail["id"] === "string" ? data.detail["id"] : "";
  return viewKey(data.meta.year, data.meta.account, data.meta.quota, data.meta.unit, id);
}

/** A view the portal answers with an empty element (HTTP 200, `detail: {}`), as for `G-1` on the expenses side. */
export const EMPTY_ELEMENT = { meta: {}, detail: {} };

/**
 * The portal over `views` (each filed under its own year, account, quota, unit and id) and
 * `extra` answers by key (an empty element, an error status): any other budgetData request is a
 * 404, as the portal answers an unpublished year or an unknown id.
 */
export function portal(views: BudgetData[], extra: Record<string, unknown | HttpResponse> = {}): MockTransport {
  const byKey = new Map<string, unknown>(views.map((v) => [keyOf(v), v]));
  for (const [key, answer] of Object.entries(extra)) byKey.set(key, answer);
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/internalapi/budgetData")) return jsonResponse({ error: "not found" }, 404);
    const q = url.searchParams;
    const key = viewKey(Number(q.get("year")), (q.get("account") ?? "expenses") as Account, (q.get("quota") ?? "target") as Quota, (q.get("unit") ?? "single") as Unit, q.get("id") ?? "");
    const answer = byKey.get(key);
    if (answer === undefined) return jsonResponse({ status: 404, message: "Not Found" }, 404);
    if (isResponse(answer)) return answer;
    return jsonResponse(answer);
  });
}

function isResponse(value: unknown): value is HttpResponse {
  return typeof value === "object" && value !== null && "status" in value && "body" in value && Buffer.isBuffer((value as HttpResponse).body);
}

/** Einzelplan 12 per year, as a trend reads it: renamed in 2025, as the portal does. */
export function ministry12(year: number, value: number): BudgetData {
  return view({ year, id: "12", label: year >= 2025 ? "12 Bundesministerium für Verkehr" : "12 Bundesministerium für Digitales und Verkehr", value, total: 476807656000 });
}

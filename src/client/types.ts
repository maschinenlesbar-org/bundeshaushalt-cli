// Domain types for the Bundeshaushalt (German federal budget) API
// (bundeshaushalt.de).

import type { Account, Quota, Unit } from "./enums.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Metadata describing the current view. */
export interface BudgetMeta {
  account: Account;
  year: number;
  quota: Quota;
  unit: Unit;
  entity?: string;
  levelCur?: number;
  levelMax?: number;
  modifyDate?: string;
  timestamp?: number;
  /**
   * Not sent in `meta` by the live API; the dimension label is on
   * `detail.tableLabel`.
   */
  tableLabel?: string;
  /** Not sent in `meta` by the live API; see `detail.selectionLabel`. */
  selectionLabel?: string;
}

/** A single budget element (a line, group or function). */
export interface BudgetElement {
  budgetNumber: string;
  id?: string;
  label: string;
  /** Value in euros. */
  value: number;
  relativeValue: number;
  relativeToParentValue: number;
  /**
   * On `detail` only: the dimension of the element's children (e.g. "Einzelplan"
   * for the whole budget, "Kapitel" inside an Einzelplan, "Titel" at a leaf).
   */
  tableLabel?: string;
  /** On `detail` only: the selection the children form (e.g. "Alle Einzelpläne"). */
  selectionLabel?: string;
}

/** An id/label pair used in `parents` and `related`. */
export interface LabeledElement {
  id?: string;
  label?: string;
}

/** Response of `/internalapi/budgetData`. */
export interface BudgetData {
  meta: BudgetMeta;
  /** The selected element. NB: the wire field is `detail` (singular). */
  detail: BudgetElement | JsonObject;
  children: (BudgetElement | JsonObject)[];
  parents?: LabeledElement[][];
  related?: {
    agency?: LabeledElement[][];
    function?: LabeledElement[][];
    group?: LabeledElement[][];
  };
}

/** Parameters for `/internalapi/budgetData`. */
export interface BudgetParams {
  /** Four-digit year (>= 2012). */
  year: number;
  account: Account;
  quota?: Quota;
  unit?: Unit;
  /** Budget number id; `G-` prefix for groups, `F-` for functions. */
  id?: string;
}

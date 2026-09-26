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
  /**
   * The masked budget number (`"0901 683 01 - 165"`, `"14__ ___ __ - ___"`) — a
   * display value, not an id you can query with. Absent on the top-level `detail`.
   */
  budgetNumber?: string;
  /** The id to drill in with (`"14"`, `"090168301"`, `"G-5"`). Absent on the top-level `detail`. */
  id?: string;
  label: string;
  /** Value in euros. */
  value: number;
  /** Share of the whole budget, in percent (0–100). */
  relativeValue: number;
  /** Share of the parent element, in percent (0–100). */
  relativeToParentValue: number;
  /** On a leaf (Titel) `detail` only: links to the Haushaltsplan PDF pages. */
  pdf?: string[];
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
  /** `null` for the whole-budget root in `parents`. */
  id?: string | null;
  label?: string;
}

/** Response of `/internalapi/budgetData`. */
export interface BudgetData {
  meta: BudgetMeta;
  /** The selected element. NB: the wire field is `detail` (singular). */
  detail: BudgetElement | JsonObject;
  /** The elements one level down. Absent at a leaf (a Titel). */
  children?: (BudgetElement | JsonObject)[];
  /**
   * Below the top level: one list per level above the selection, each holding that
   * level's elements (the selected ancestor among its siblings).
   */
  parents?: LabeledElement[][];
  /**
   * At a leaf only: the element's path in each of the other groupings, from the
   * top down (a flat breadcrumb list per grouping).
   */
  related?: {
    agency?: LabeledElement[];
    function?: LabeledElement[];
    group?: LabeledElement[];
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

// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of
// the budget portal over recorded budgetData answers (the client's test fixtures), and the
// client's transport helpers. The generic harness (a connection, a config, a log recorder, the
// HTTP server) is harness.ts.

export * from "@maschinenlesbar.org/bundeshaushalt-client/test/helpers";
export {
  EMPTY_ELEMENT,
  expenses2024,
  expenses2024Actual,
  ministry12,
  ministry14,
  portal,
  titel140555408,
  view,
  viewKey,
} from "@maschinenlesbar.org/bundeshaushalt-client/test/fixtures";

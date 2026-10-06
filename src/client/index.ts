// Public entry point for the API client library.

export { BundeshaushaltClient, validateBudgetParams } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  validateBaseUrl,
  assertHeaderValue,
  DEFAULT_USER_AGENT,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  HaushaltError,
  HaushaltApiError,
  HaushaltNetworkError,
  HaushaltParseError,
  HaushaltValidationError,
  redactUrl,
  credentialsIn,
  redactCredentials,
} from "./errors.js";
export { assertValid, baseUrlProblem, headerValueProblem, idProblem, idUnitProblem, yearProblem } from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./enums.js";
export * from "./types.js";

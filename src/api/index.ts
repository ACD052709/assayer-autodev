export { createApiRouter, type ApiDependencies, type ApiRouterOptions } from "./router.js";
export { ApiError, jsonResponse, handleApiError, finalizeResponse, type ApiErrorBody } from "./errors.js";
export type { AuthConfig, ApiCaller, CallerRole, RoutePolicy } from "./auth/index.js";
export {
  MAX_JSON_BODY_BYTES,
  MAX_BOOTSTRAP_BLOB_BYTES,
  decodeBootstrapBase64,
} from "./security/index.js";

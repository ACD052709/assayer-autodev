import { ApiError } from "../errors.js";
import type { ApiCaller } from "./types.js";
import { SERVICE_TOKEN_CALLER } from "./types.js";

export interface AuthConfig {
  /** Worker secret binding; must be set before protected routes are enabled in deployment. */
  readonly serviceToken: string | undefined;
  /** When true, generic internal error messages are returned to clients. */
  readonly production: boolean;
}

const BEARER_PREFIX = "Bearer ";

export function assertAuthConfigured(config: AuthConfig): void {
  const token = config.serviceToken?.trim();
  if (token === undefined || token.length === 0) {
    throw new ApiError(
      503,
      "auth_misconfigured",
      "Service authentication is not configured",
    );
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < aBytes.length; i++) {
    mismatch |= aBytes[i]! ^ bBytes[i]!;
  }
  return mismatch === 0;
}

export function parseBearerToken(authorizationHeader: string | null): string | null {
  if (authorizationHeader === null || authorizationHeader.length === 0) {
    return null;
  }
  if (!authorizationHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    return null;
  }
  if (authorizationHeader.slice(BEARER_PREFIX.length).includes(" ")) {
    return null;
  }
  return token;
}

export function authenticateBearer(request: Request, config: AuthConfig): ApiCaller {
  assertAuthConfigured(config);
  const presented = parseBearerToken(request.headers.get("authorization"));
  if (presented === null) {
    throw new ApiError(401, "unauthorized", "Missing or malformed Authorization header");
  }
  const expected = config.serviceToken!.trim();
  if (!timingSafeEqual(presented, expected)) {
    throw new ApiError(401, "unauthorized", "Invalid credentials");
  }
  return SERVICE_TOKEN_CALLER;
}

export function logServerError(context: string, error: unknown): void {
  if (error instanceof ApiError) {
    return;
  }
  void error;
  console.error(`[assayer-autodev] ${context}: internal error`);
}

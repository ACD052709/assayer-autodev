import { ApiError } from "../errors.js";
import type { ApiCaller, CallerRole } from "./types.js";
import { isKnownRole } from "./types.js";

export type RouteAuthMode = "public" | "protected";

export interface RoutePolicy {
  readonly auth: RouteAuthMode;
  /** Roles permitted once per-role tokens are introduced. V1 service token maps to admin. */
  readonly roles: readonly CallerRole[];
}

export const PUBLIC_ROUTE_POLICY: RoutePolicy = { auth: "public", roles: [] };

export function assertKnownRole(role: string): CallerRole {
  if (!isKnownRole(role)) {
    throw new ApiError(403, "forbidden", "Unknown caller role");
  }
  return role;
}

export function assertCallerPermitted(caller: ApiCaller, policy: RoutePolicy): void {
  if (policy.auth === "public") {
    return;
  }
  assertKnownRole(caller.role);
  if (!policy.roles.includes(caller.role)) {
    throw new ApiError(403, "forbidden", "Caller role is not permitted for this route");
  }
}

export function policyFor(roles: readonly CallerRole[]): RoutePolicy {
  return { auth: "protected", roles };
}

/** Shared read access for authenticated control-plane clients. */
export const READ_POLICY = policyFor(["master", "worker", "verifier", "admin"]);

export const MASTER_WRITE_POLICY = policyFor(["master", "admin"]);
export const WORKER_WRITE_POLICY = policyFor(["worker", "admin"]);
export const VERIFIER_WRITE_POLICY = policyFor(["verifier", "admin"]);
export const INBOX_WRITE_POLICY = policyFor(["master", "worker", "verifier", "admin"]);

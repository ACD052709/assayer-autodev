/** Caller roles for route authorization policy (V1 uses a single service token mapped to admin). */
export type CallerRole = "master" | "worker" | "verifier" | "admin";

export const CALLER_ROLES: readonly CallerRole[] = ["master", "worker", "verifier", "admin"];

export interface ApiCaller {
  readonly role: CallerRole;
}

/** Temporary V1 identity assigned to authenticated service-token callers. */
export const SERVICE_TOKEN_CALLER: ApiCaller = { role: "admin" };

export function isKnownRole(value: string): value is CallerRole {
  return (CALLER_ROLES as readonly string[]).includes(value);
}

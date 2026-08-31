import type { EntityId, ISOTimestamp } from "../domain/index.js";

/**
 * Heartbeats are not persisted as individual WORKER_RUN_HEARTBEAT events.
 * `lastHeartbeatAt` on the worker_run row is the durable heartbeat record.
 */
export const HEARTBEAT_EVENTS_PERSISTED = false;

/** Conservative default: 2 minutes. Heartbeats should arrive well before expiry. */
export const DEFAULT_LEASE_DURATION_MS = 120_000;

export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_ATTEMPTS_LIMIT = 8;

const TOKEN_BYTES = 32;

export function generateLeaseToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function hashLeaseToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

export function leaseExpiryIso(now: ISOTimestamp, durationMs = DEFAULT_LEASE_DURATION_MS): ISOTimestamp {
  return new Date(Date.parse(now) + durationMs).toISOString();
}

export function isLeaseExpired(expiresAt: ISOTimestamp | undefined, now: ISOTimestamp): boolean {
  if (expiresAt === undefined) {
    return true;
  }
  return expiresAt <= now;
}

export type OwnerId = EntityId;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

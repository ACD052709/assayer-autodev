/** Shared identifiers and temporal metadata used across the domain. */

export type EntityId = string;

export type ISOTimestamp = string;

export interface Timestamps {
  readonly createdAt: ISOTimestamp;
  readonly updatedAt: ISOTimestamp;
}

export interface Provenance {
  readonly projectId: EntityId;
  readonly taskId?: EntityId;
  readonly workerRunId?: EntityId;
  readonly verifierRunId?: EntityId;
  readonly gitRevisionId?: EntityId;
  readonly deploymentId?: EntityId;
}

export interface StatusRecord<TStatus extends string> {
  readonly status: TStatus;
  readonly statusChangedAt: ISOTimestamp;
}

export type ProjectStatus = "active" | "paused" | "archived";

export type VerificationOutcome = "PASS" | "FAIL" | "INCONCLUSIVE";

export type PermissionDecision = "allow" | "deny" | "escalate";

export function nowIso(): ISOTimestamp {
  return new Date().toISOString();
}

export function createTimestamps(at?: ISOTimestamp): Timestamps {
  const ts = at ?? nowIso();
  return { createdAt: ts, updatedAt: ts };
}

export function touchTimestamps(existing: Timestamps, at?: ISOTimestamp): Timestamps {
  return { createdAt: existing.createdAt, updatedAt: at ?? nowIso() };
}

export function withStatus<TStatus extends string>(
  status: TStatus,
  at?: ISOTimestamp,
): StatusRecord<TStatus> {
  return { status, statusChangedAt: at ?? nowIso() };
}

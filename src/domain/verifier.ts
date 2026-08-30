import type { EntityId, ISOTimestamp, Provenance, StatusRecord, Timestamps, VerificationOutcome } from "./common.js";

export type VerifierRunStatus = "pending" | "running" | "completed" | "failed";

export interface VerifierRun extends Timestamps, StatusRecord<VerifierRunStatus>, Provenance {
  readonly id: EntityId;
  readonly taskId: EntityId;
  readonly outcome?: VerificationOutcome;
  readonly startedAt?: ISOTimestamp;
  readonly completedAt?: ISOTimestamp;
  readonly summary?: string;
  readonly evidenceIds: readonly EntityId[];
}

export interface CreateVerifierRunInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
}

export interface CompleteVerifierRunInput {
  readonly verifierRunId: EntityId;
  readonly outcome: VerificationOutcome;
  readonly summary?: string;
  readonly evidenceIds?: readonly EntityId[];
}

import type { EntityId, ISOTimestamp, Provenance, Timestamps } from "./common.js";

export type CodeCandidateStatus =
  | "pending_verification"
  | "promotion_eligible"
  | "promoted"
  | "rejected";

export type PromotionRunStatus = "pending" | "running" | "succeeded" | "failed";

export interface CodeCandidate extends Timestamps, Provenance {
  readonly id: EntityId;
  readonly taskId: EntityId;
  readonly workerRunId: EntityId;
  readonly sourceRepository: string;
  readonly sourceRef?: string;
  /** Previous candidate whose patch is already included in this cumulative candidate. */
  readonly parentCandidateId?: EntityId;
  readonly baseCommitSha: string;
  readonly changedFiles: readonly string[];
  readonly patchChecksumSha256: string;
  readonly patchContentRef: string;
  readonly testCommand: string;
  readonly testExitCode: number;
  readonly status: CodeCandidateStatus;
  readonly verifierRunId?: EntityId;
  /** Original task whose acceptance gate approved this candidate (repair candidates may have a different taskId). */
  readonly acceptedTaskId?: EntityId;
  readonly promotionRunId?: EntityId;
  readonly resultingCommitSha?: string;
  readonly promotedAt?: ISOTimestamp;
}

export interface PromotionRun extends Timestamps, Provenance {
  readonly id: EntityId;
  readonly codeCandidateId: EntityId;
  readonly taskId: EntityId;
  readonly workerRunId: EntityId;
  readonly verifierRunId: EntityId;
  readonly destinationRepository: string;
  readonly destinationRef: string;
  readonly baseCommitSha: string;
  readonly status: PromotionRunStatus;
  readonly resultingCommitSha?: string;
  readonly errorMessage?: string;
  readonly completedAt?: ISOTimestamp;
}

export interface CreateCodeCandidateInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly workerRunId: EntityId;
  readonly sourceRepository: string;
  readonly sourceRef?: string;
  /** Previous candidate whose patch is already included in this cumulative candidate. */
  readonly parentCandidateId?: EntityId;
  readonly baseCommitSha: string;
  readonly changedFiles: readonly string[];
  readonly patchChecksumSha256: string;
  readonly patchContentRef: string;
  readonly testCommand: string;
  readonly testExitCode: number;
}

export interface MarkCodeCandidatePromotionEligibleInput {
  readonly codeCandidateId: EntityId;
  readonly verifierRunId: EntityId;
  readonly acceptedTaskId?: EntityId;
}

export interface CompleteCodeCandidatePromotionInput {
  readonly codeCandidateId: EntityId;
  readonly promotionRunId: EntityId;
  readonly resultingCommitSha: string;
}

export interface CreatePromotionRunInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly codeCandidateId: EntityId;
  readonly taskId: EntityId;
  readonly workerRunId: EntityId;
  readonly verifierRunId: EntityId;
  readonly destinationRepository: string;
  readonly destinationRef: string;
  readonly baseCommitSha: string;
}

export interface CompletePromotionRunInput {
  readonly promotionRunId: EntityId;
  readonly status: Extract<PromotionRunStatus, "succeeded" | "failed">;
  readonly resultingCommitSha?: string;
  readonly errorMessage?: string;
}

export function codeCandidateIdForWorkerRun(taskId: EntityId, workerRunId: EntityId): EntityId {
  return `cand-${taskId}-${workerRunId}`;
}

export function promotionRunIdForCandidate(codeCandidateId: EntityId): EntityId {
  return `prom-${codeCandidateId}`;
}

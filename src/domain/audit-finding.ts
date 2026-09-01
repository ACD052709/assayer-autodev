import type { EntityId, ISOTimestamp, Timestamps } from "./common.js";

export type AuditRuleCode =
  | "STUCK_WORKER"
  | "REPEATED_TASK_FAILURE"
  | "RETRY_LOOP"
  | "DUPLICATE_ACTIVE_WORK"
  | "MISSING_REPORT"
  | "VERIFIER_MISMATCH"
  | "BUDGET_ANOMALY"
  | "REPEATED_IDENTICAL_FAILURE";

export type AuditFindingSeverity = "low" | "medium" | "high" | "critical";

export type AuditFindingStatus = "active" | "resolved";

/** Candidate finding produced by deterministic rule evaluation before persistence. */
export interface DetectedAuditFinding {
  readonly findingKey: string;
  readonly projectId: EntityId;
  readonly ruleCode: AuditRuleCode;
  readonly severity: AuditFindingSeverity;
  readonly summary: string;
  readonly details: Record<string, unknown>;
  readonly taskId?: EntityId;
  readonly workerRunId?: EntityId;
  readonly verifierRunId?: EntityId;
}

export interface AuditFinding extends Timestamps {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly findingKey: string;
  readonly ruleCode: AuditRuleCode;
  readonly severity: AuditFindingSeverity;
  readonly status: AuditFindingStatus;
  readonly summary: string;
  readonly details: Record<string, unknown>;
  readonly taskId?: EntityId;
  readonly workerRunId?: EntityId;
  readonly verifierRunId?: EntityId;
  readonly firstObservedAt: ISOTimestamp;
  readonly lastObservedAt: ISOTimestamp;
  readonly resolvedAt?: ISOTimestamp;
}

export interface ListAuditFindingsFilter {
  readonly status?: AuditFindingStatus | "all";
}

export interface SyncAuditFindingsInput {
  readonly projectId: EntityId;
  readonly detected: readonly DetectedAuditFinding[];
  readonly now: ISOTimestamp;
}

export interface SyncAuditFindingsResult {
  readonly findings: readonly AuditFinding[];
  readonly activeCount: number;
  readonly resolvedCount: number;
  readonly newlyCreated: number;
  readonly reactivated: number;
}

export function auditFindingIdFromKey(findingKey: string): EntityId {
  const sanitized = findingKey.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = sanitized.length > 0 ? sanitized : "finding";
  return `af-${base.slice(0, 120)}`;
}

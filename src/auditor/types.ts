import type { EntityId, ISOTimestamp } from "../domain/common.js";
import type { AuditFinding, DetectedAuditFinding } from "../domain/audit-finding.js";
import type { BudgetLedger } from "../domain/budget.js";
import type { Task } from "../domain/task.js";
import type { TestResult } from "../domain/test.js";
import type { VerifierRun } from "../domain/verifier.js";
import type { WorkerReport, WorkerRun } from "../domain/worker.js";
import type { AuditThresholds } from "./thresholds.js";

export interface AuditInput {
  readonly projectId: EntityId;
  readonly tasks: readonly Task[];
  readonly workerRuns: readonly WorkerRun[];
  readonly workerReportsByRunId: ReadonlyMap<EntityId, WorkerReport>;
  readonly verifierRuns: readonly VerifierRun[];
  readonly testResults: readonly TestResult[];
  readonly budgetLedger?: BudgetLedger;
  readonly expiredRunningWorkerRuns: readonly WorkerRun[];
}

export interface RunProjectAuditOptions {
  readonly now?: ISOTimestamp;
  readonly thresholds?: AuditThresholds;
}

export interface AuditRunResult {
  readonly projectId: EntityId;
  readonly evaluatedAt: ISOTimestamp;
  readonly detected: readonly DetectedAuditFinding[];
  readonly findings: readonly AuditFinding[];
  readonly activeCount: number;
  readonly resolvedCount: number;
}

import type { EntityId, ISOTimestamp } from "../domain/common.js";
import type { Blocker } from "../domain/master-ai.js";
import type { MasterState } from "../domain/master.js";
import type { Project } from "../domain/project.js";
import type { Task } from "../domain/task.js";
import type { TestCase, TestResult } from "../domain/test.js";
import type { VerifierRun } from "../domain/verifier.js";
import type { WorkerRun } from "../domain/worker.js";
import type { OrchestrationThresholds } from "./thresholds.js";

export type OrchestrationPhase =
  | "planning"
  | "awaiting_work"
  | "waiting_for_budget"
  | "worker_active"
  | "awaiting_verification"
  | "verifier_running"
  | "repair_required"
  | "blocked"
  | "failed"
  | "finished";

export type OrchestrationActionKind =
  | "dispatch"
  | "budget_wait"
  | "run_verifier"
  | "schedule_verifier"
  | "accept_verified_task"
  | "schedule_promotion"
  | "create_repair_task"
  | "repair_exhausted"
  | "accept_repair_task"
  | "master_reevaluation"
  | "audit";

export interface OrchestrationAction {
  readonly kind: OrchestrationActionKind;
  readonly summary: string;
  readonly taskId?: EntityId;
  readonly workerRunId?: EntityId;
  readonly verifierRunId?: EntityId;
  readonly promotionRunId?: EntityId;
  readonly details?: Record<string, unknown>;
}

export interface OrchestrationInput {
  readonly projectId: EntityId;
  readonly project: Project;
  readonly masterState: MasterState;
  readonly tasks: readonly Task[];
  readonly workerRuns: readonly WorkerRun[];
  readonly verifierRuns: readonly VerifierRun[];
  readonly testCases: readonly TestCase[];
  readonly testResults: readonly TestResult[];
  readonly blockers: readonly Blocker[];
}

export interface RunOrchestrationCycleOptions {
  readonly now?: ISOTimestamp;
  readonly thresholds?: OrchestrationThresholds;
  readonly runMasterReevaluation?: boolean;
  readonly runAudit?: boolean;
  readonly haltOnCriticalAudit?: boolean;
}

export interface OrchestrationCycleResult {
  readonly projectId: EntityId;
  readonly evaluatedAt: ISOTimestamp;
  readonly phase: OrchestrationPhase;
  readonly actions: readonly OrchestrationAction[];
  readonly auditActiveCount?: number;
  readonly masterRunId?: EntityId;
  readonly halted: boolean;
  readonly haltReason?: string;
}

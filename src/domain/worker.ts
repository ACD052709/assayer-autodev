import type { EntityId, ISOTimestamp, Provenance, StatusRecord, Timestamps } from "./common.js";
import type { Task, TaskStatus } from "./task.js";

export type WorkerKind = "cursor_acp" | "playwright" | "verifier" | "generic";

export type WorkerRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export const TERMINAL_WORKER_RUN_STATUSES: ReadonlySet<WorkerRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export function isTerminalWorkerRunStatus(status: WorkerRunStatus): boolean {
  return TERMINAL_WORKER_RUN_STATUSES.has(status);
}

export interface WorkerRun extends Timestamps, StatusRecord<WorkerRunStatus>, Provenance {
  readonly id: EntityId;
  readonly workerKind: WorkerKind;
  readonly iteration: number;
  readonly startedAt?: ISOTimestamp;
  readonly completedAt?: ISOTimestamp;
  readonly errorMessage?: string;
}

export type WorkerEventType =
  | "started"
  | "log"
  | "artifact"
  | "progress"
  | "error"
  | "completed";

export interface WorkerEvent extends Timestamps, Provenance {
  readonly id: EntityId;
  readonly workerRunId: EntityId;
  readonly eventType: WorkerEventType;
  readonly message: string;
  readonly payload?: Record<string, unknown>;
}

export interface WorkerReport extends Timestamps, Provenance {
  readonly id: EntityId;
  readonly workerRunId: EntityId;
  readonly summary: string;
  readonly outcome: "success" | "failure" | "partial";
  readonly metrics?: Record<string, number>;
}

export interface CreateWorkerRunInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly workerKind: WorkerKind;
  readonly iteration?: number;
}

export interface CreateWorkerEventInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly workerRunId: EntityId;
  readonly eventType: WorkerEventType;
  readonly message: string;
  readonly payload?: Record<string, unknown>;
}

export interface CreateWorkerReportInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly workerRunId: EntityId;
  readonly summary: string;
  readonly outcome: WorkerReport["outcome"];
  readonly metrics?: Record<string, number>;
}

export interface AssignTaskToWorkerRunInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly workerKind: WorkerKind;
  readonly iteration?: number;
}

/** Result of assigning a worker_run to a task. `created` is false when the task was already assigned. */
export interface TaskWorkerAssignment {
  readonly task: Task;
  readonly workerRun: WorkerRun;
  readonly created: boolean;
}

export interface ApplyWorkerRunTaskTransitionInput {
  readonly workerRunId: EntityId;
  readonly fromRunStatuses: readonly WorkerRunStatus[];
  readonly toRunStatus: WorkerRunStatus;
  readonly fromTaskStatuses: readonly TaskStatus[];
  readonly toTaskStatus: TaskStatus;
  readonly errorMessage?: string;
}

export type WorkerRunTaskTransitionResult =
  | {
      readonly ok: true;
      readonly applied: boolean;
      readonly task: Task;
      readonly workerRun: WorkerRun;
    }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "inconsistent" | "illegal_transition";
    };

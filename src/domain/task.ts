import type { EntityId, ISOTimestamp, Provenance, StatusRecord, Timestamps } from "./common.js";

/** Explicit task lifecycle states for orchestration and dependency resolution. */
export type TaskStatus =
  | "pending"
  | "ready"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "awaiting_verification"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskKind =
  | "planning"
  | "implementation"
  | "verification"
  | "deployment"
  | "acceptance";

export interface TaskDependency {
  readonly taskId: EntityId;
  readonly dependsOnTaskId: EntityId;
  readonly createdAt: ISOTimestamp;
}

export interface Task extends Timestamps, StatusRecord<TaskStatus>, Provenance {
  readonly id: EntityId;
  readonly title: string;
  readonly description: string;
  readonly kind: TaskKind;
  readonly dependencyIds: readonly EntityId[];
  readonly assignedWorkerRunId?: EntityId;
  readonly blockedReason?: string;
}

export interface CreateTaskInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly title: string;
  readonly description: string;
  readonly kind: TaskKind;
  readonly dependencyIds?: readonly EntityId[];
}

export interface CreateTaskDependencyInput {
  readonly taskId: EntityId;
  readonly dependsOnTaskId: EntityId;
}

export function taskProvenance(projectId: EntityId, taskId: EntityId): Provenance {
  return { projectId, taskId };
}

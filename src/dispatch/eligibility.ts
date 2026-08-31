import type { EntityId } from "../domain/index.js";
import {
  isTerminalTaskStatus,
  type Task,
  type TaskDependency,
  type TaskStatus,
} from "../domain/index.js";

/** Tasks the dispatcher may pick. Assigned/in-progress/blocked/terminal are excluded. */
export const DISPATCH_ELIGIBLE_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "ready"]);

/** Status written onto a task when a worker_run is assigned. Workers later move it to in_progress. */
export const DISPATCH_ASSIGNED_STATUS: TaskStatus = "assigned";

/**
 * Product "completed" for a worker run is persisted as `succeeded`.
 * The WorkerRun schema has no `completed` status.
 */
export const WORKER_RUN_COMPLETED_STATUS = "succeeded" as const;

export const DEFAULT_MAX_ASSIGNMENTS = 8;
export const MAX_ASSIGNMENTS_LIMIT = 32;

export const DISPATCH_WORKER_KIND = "generic" as const;

export function isEligibleDispatchStatus(status: TaskStatus): boolean {
  return DISPATCH_ELIGIBLE_STATUSES.has(status);
}

export function uniqueEntityIds(ids: readonly EntityId[]): EntityId[] {
  return [...new Set(ids)];
}

export function dependencyIdsForTask(
  task: Task,
  tableDeps: readonly TaskDependency[],
): readonly EntityId[] {
  return uniqueEntityIds([
    ...task.dependencyIds,
    ...tableDeps.filter((dep) => dep.taskId === task.id).map((dep) => dep.dependsOnTaskId),
  ]);
}

/**
 * A dependency is satisfied only when the depended-on task exists in the same project
 * and is `completed`. Missing, cross-project, and incomplete dependencies block dispatch.
 */
export function areDependenciesSatisfied(
  task: Task,
  dependencyIds: readonly EntityId[],
  tasksById: ReadonlyMap<EntityId, Task>,
): boolean {
  for (const depId of dependencyIds) {
    const dep = tasksById.get(depId);
    if (dep === undefined) {
      return false;
    }
    if (dep.projectId !== task.projectId) {
      return false;
    }
    if (dep.status !== "completed") {
      return false;
    }
  }
  return true;
}

export function isTaskEligibleForDispatch(
  task: Task,
  dependencyIds: readonly EntityId[],
  tasksById: ReadonlyMap<EntityId, Task>,
): boolean {
  if (isTerminalTaskStatus(task.status)) {
    return false;
  }
  if (!isEligibleDispatchStatus(task.status)) {
    return false;
  }
  if (task.assignedWorkerRunId !== undefined) {
    return false;
  }
  return areDependenciesSatisfied(task, dependencyIds, tasksById);
}

/** Deterministic order: createdAt ascending, then id ascending. */
export function compareTasksForDispatch(a: Task, b: Task): number {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  if (byTime !== 0) {
    return byTime;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Greedy selection in dispatch order. A task is skipped when any of its dependencies
 * is also in the current batch (those deps are not completed yet).
 */
export function selectIndependentEligibleTasks(
  eligibleSorted: readonly Task[],
  depsByTaskId: ReadonlyMap<EntityId, readonly EntityId[]>,
  maxAssignments: number,
): Task[] {
  const selected: Task[] = [];
  const selectedIds = new Set<EntityId>();
  for (const task of eligibleSorted) {
    if (selected.length >= maxAssignments) {
      break;
    }
    const deps = depsByTaskId.get(task.id) ?? [];
    if (deps.some((id) => selectedIds.has(id))) {
      continue;
    }
    selected.push(task);
    selectedIds.add(task.id);
  }
  return selected;
}

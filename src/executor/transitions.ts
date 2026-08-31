import type { TaskStatus } from "../domain/index.js";
import {
  isTerminalWorkerRunStatus,
  type WorkerRunStatus,
} from "../domain/index.js";

/**
 * Allowed worker_run transitions. Terminal states have no outgoing edges.
 *
 * queued   → running | cancelled
 * running  → succeeded | failed | cancelled
 * succeeded/failed/cancelled/timed_out → (none)
 */
export const ALLOWED_WORKER_RUN_TRANSITIONS: Readonly<
  Record<WorkerRunStatus, readonly WorkerRunStatus[]>
> = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function isAllowedWorkerRunTransition(
  from: WorkerRunStatus,
  to: WorkerRunStatus,
): boolean {
  return ALLOWED_WORKER_RUN_TRANSITIONS[from].includes(to);
}

export function taskStatusForClaim(): { from: readonly TaskStatus[]; to: TaskStatus } {
  return { from: ["assigned"], to: "in_progress" };
}

export function taskStatusForSuccess(): { from: readonly TaskStatus[]; to: TaskStatus } {
  return { from: ["in_progress"], to: "awaiting_verification" };
}

export function taskStatusForFailure(): { from: readonly TaskStatus[]; to: TaskStatus } {
  return { from: ["in_progress"], to: "failed" };
}

export function taskStatusForCancel(fromRun: WorkerRunStatus): {
  from: readonly TaskStatus[];
  to: TaskStatus;
} {
  if (fromRun === "queued") {
    return { from: ["assigned"], to: "cancelled" };
  }
  return { from: ["in_progress"], to: "cancelled" };
}

export function assertTransitionAllowed(from: WorkerRunStatus, to: WorkerRunStatus): boolean {
  if (isTerminalWorkerRunStatus(from) && from !== to) {
    return false;
  }
  return isAllowedWorkerRunTransition(from, to);
}

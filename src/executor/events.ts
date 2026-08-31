import type { WorkerEventType } from "../domain/index.js";

/**
 * Authoritative lifecycle names stored in event payload.lifecycle.
 * Claim and start are the same atomic transition (queued → running, startedAt set once),
 * so WORKER_RUN_CLAIMED is not emitted separately — claim writes WORKER_RUN_STARTED.
 */
export const LIFECYCLE_EVENTS = {
  STARTED: "WORKER_RUN_STARTED",
  SUCCEEDED: "WORKER_RUN_SUCCEEDED",
  FAILED: "WORKER_RUN_FAILED",
  CANCELLED: "WORKER_RUN_CANCELLED",
} as const;

export type WorkerRunLifecycleEventName = (typeof LIFECYCLE_EVENTS)[keyof typeof LIFECYCLE_EVENTS];

export function workerEventTypeForLifecycle(name: WorkerRunLifecycleEventName): WorkerEventType {
  switch (name) {
    case LIFECYCLE_EVENTS.STARTED:
      return "started";
    case LIFECYCLE_EVENTS.SUCCEEDED:
    case LIFECYCLE_EVENTS.CANCELLED:
      return "completed";
    case LIFECYCLE_EVENTS.FAILED:
      return "error";
  }
}

export function lifecycleEventId(workerRunId: string, name: WorkerRunLifecycleEventName): string {
  const suffix =
    name === LIFECYCLE_EVENTS.STARTED
      ? "started"
      : name === LIFECYCLE_EVENTS.SUCCEEDED
        ? "succeeded"
        : name === LIFECYCLE_EVENTS.FAILED
          ? "failed"
          : "cancelled";
  return `wevt-${suffix}-${workerRunId}`;
}

export function workerReportIdForRun(workerRunId: string): string {
  return `wrep-${workerRunId}`;
}

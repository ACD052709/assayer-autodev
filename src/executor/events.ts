import type { WorkerEventType } from "../domain/index.js";

/**
 * Authoritative lifecycle names stored in event payload.lifecycle.
 * Claim and start are the same atomic transition (queued → running, startedAt set once),
 * so WORKER_RUN_CLAIMED is not emitted separately — claim writes WORKER_RUN_STARTED.
 * Heartbeats are not written as events; lastHeartbeatAt is the durable record.
 */
export const LIFECYCLE_EVENTS = {
  STARTED: "WORKER_RUN_STARTED",
  SUCCEEDED: "WORKER_RUN_SUCCEEDED",
  FAILED: "WORKER_RUN_FAILED",
  CANCELLED: "WORKER_RUN_CANCELLED",
  TIMED_OUT: "WORKER_RUN_TIMED_OUT",
  RETRY_CREATED: "WORKER_RUN_RETRY_CREATED",
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
    case LIFECYCLE_EVENTS.TIMED_OUT:
      return "error";
    case LIFECYCLE_EVENTS.RETRY_CREATED:
      return "progress";
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
          : name === LIFECYCLE_EVENTS.CANCELLED
            ? "cancelled"
            : name === LIFECYCLE_EVENTS.TIMED_OUT
              ? "timed-out"
              : "retry";
  return `wevt-${suffix}-${workerRunId}`;
}

export function workerReportIdForRun(workerRunId: string): string {
  return `wrep-${workerRunId}`;
}

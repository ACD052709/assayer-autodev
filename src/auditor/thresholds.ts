/** Policy thresholds for deterministic audit rules. Override in tests via run options. */
export interface AuditThresholds {
  /** Minimum failed/timed_out worker runs on a task before REPEATED_TASK_FAILURE fires. */
  readonly repeatedTaskFailureMin: number;
  /** Minimum worker runs on a task without success before RETRY_LOOP fires. */
  readonly retryLoopMinRuns: number;
  /** Minimum runs sharing the same normalized failure before REPEATED_IDENTICAL_FAILURE fires. */
  readonly repeatedIdenticalFailureMin: number;
  /** Queued worker runs older than this are flagged as STUCK_WORKER. */
  readonly queuedStuckMs: number;
  /** Remaining hard budget below this fraction of hard limit triggers approaching BUDGET_ANOMALY. */
  readonly budgetApproachingRemainingRatio: number;
}

export const DEFAULT_AUDIT_THRESHOLDS: AuditThresholds = {
  repeatedTaskFailureMin: 2,
  retryLoopMinRuns: 3,
  repeatedIdenticalFailureMin: 2,
  queuedStuckMs: 300_000,
  budgetApproachingRemainingRatio: 0.1,
};

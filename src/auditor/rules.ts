import type { ISOTimestamp } from "../domain/common.js";
import type { DetectedAuditFinding } from "../domain/audit-finding.js";
import { listBudgetResourceViews } from "../domain/budget.js";
import { isTerminalTaskStatus } from "../domain/task.js";
import type { WorkerRunStatus } from "../domain/worker.js";
import { isTerminalWorkerRunStatus } from "../domain/worker.js";
import type { AuditThresholds } from "./thresholds.js";
import { DEFAULT_AUDIT_THRESHOLDS } from "./thresholds.js";
import type { AuditInput } from "./types.js";

const ACTIVE_WORKER_STATUSES: ReadonlySet<WorkerRunStatus> = new Set(["queued", "running"]);
const FAILURE_WORKER_STATUSES: ReadonlySet<WorkerRunStatus> = new Set(["failed", "timed_out"]);

function isActiveWorkerStatus(status: WorkerRunStatus): boolean {
  return ACTIVE_WORKER_STATUSES.has(status);
}

function isFailureWorkerStatus(status: WorkerRunStatus): boolean {
  return FAILURE_WORKER_STATUSES.has(status);
}

function msSince(iso: ISOTimestamp, now: ISOTimestamp): number {
  return Date.parse(now) - Date.parse(iso);
}

function normalizeFailureMessage(message: string | undefined): string | undefined {
  if (message === undefined || message.trim() === "") {
    return undefined;
  }
  return message.trim().toLowerCase().replace(/\s+/g, " ");
}

function pushFinding(
  findings: DetectedAuditFinding[],
  finding: DetectedAuditFinding,
): void {
  findings.push(finding);
}

function evaluateStuckWorker(
  input: AuditInput,
  now: ISOTimestamp,
  thresholds: AuditThresholds,
  findings: DetectedAuditFinding[],
): void {
  for (const run of input.expiredRunningWorkerRuns) {
    pushFinding(findings, {
      findingKey: `STUCK_WORKER|${run.id}`,
      projectId: input.projectId,
      ruleCode: "STUCK_WORKER",
      severity: "high",
      summary: `Worker run ${run.id} is running with an expired lease`,
      details: {
        workerRunId: run.id,
        taskId: run.taskId,
        status: run.status,
        leaseExpiresAt: run.leaseExpiresAt,
        lastHeartbeatAt: run.lastHeartbeatAt,
        observedAt: now,
      },
      ...(run.taskId !== undefined ? { taskId: run.taskId } : {}),
      workerRunId: run.id,
    });
  }

  for (const run of input.workerRuns) {
    if (run.status !== "queued") {
      continue;
    }
    const ageMs = msSince(run.statusChangedAt, now);
    if (ageMs <= thresholds.queuedStuckMs) {
      continue;
    }
    pushFinding(findings, {
      findingKey: `STUCK_WORKER|${run.id}`,
      projectId: input.projectId,
      ruleCode: "STUCK_WORKER",
      severity: "medium",
      summary: `Worker run ${run.id} has remained queued beyond the stuck threshold`,
      details: {
        workerRunId: run.id,
        taskId: run.taskId,
        status: run.status,
        statusChangedAt: run.statusChangedAt,
        queuedAgeMs: ageMs,
        thresholdMs: thresholds.queuedStuckMs,
        observedAt: now,
      },
      ...(run.taskId !== undefined ? { taskId: run.taskId } : {}),
      workerRunId: run.id,
    });
  }
}

function evaluateRepeatedTaskFailure(
  input: AuditInput,
  thresholds: AuditThresholds,
  findings: DetectedAuditFinding[],
): void {
  const runsByTask = groupWorkerRunsByTask(input);

  for (const [taskId, runs] of runsByTask) {
    const failureCount = runs.filter((run) => isFailureWorkerStatus(run.status)).length;
    if (failureCount < thresholds.repeatedTaskFailureMin) {
      continue;
    }
    pushFinding(findings, {
      findingKey: `REPEATED_TASK_FAILURE|${taskId}`,
      projectId: input.projectId,
      ruleCode: "REPEATED_TASK_FAILURE",
      severity: "high",
      summary: `Task ${taskId} has ${failureCount} failed worker runs`,
      details: {
        taskId,
        failureCount,
        threshold: thresholds.repeatedTaskFailureMin,
        failedRunIds: runs.filter((run) => isFailureWorkerStatus(run.status)).map((run) => run.id),
      },
      taskId,
    });
  }
}

function evaluateRetryLoop(
  input: AuditInput,
  thresholds: AuditThresholds,
  findings: DetectedAuditFinding[],
): void {
  const runsByTask = groupWorkerRunsByTask(input);

  for (const [taskId, runs] of runsByTask) {
    const task = input.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined || isTerminalTaskStatus(task.status)) {
      continue;
    }
    const hasSuccess = runs.some((run) => run.status === "succeeded");
    if (hasSuccess || runs.length < thresholds.retryLoopMinRuns) {
      continue;
    }
    pushFinding(findings, {
      findingKey: `RETRY_LOOP|${taskId}`,
      projectId: input.projectId,
      ruleCode: "RETRY_LOOP",
      severity: "high",
      summary: `Task ${taskId} has ${runs.length} worker runs without successful progress`,
      details: {
        taskId,
        runCount: runs.length,
        threshold: thresholds.retryLoopMinRuns,
        runIds: runs.map((run) => run.id),
        taskStatus: task.status,
      },
      taskId,
    });
  }
}

function evaluateDuplicateActiveWork(input: AuditInput, findings: DetectedAuditFinding[]): void {
  const activeByTask = new Map<string, typeof input.workerRuns>();

  for (const run of input.workerRuns) {
    if (!isActiveWorkerStatus(run.status) || run.taskId === undefined) {
      continue;
    }
    const existing = activeByTask.get(run.taskId) ?? [];
    activeByTask.set(run.taskId, [...existing, run]);
  }

  for (const [taskId, runs] of activeByTask) {
    if (runs.length <= 1) {
      continue;
    }
    pushFinding(findings, {
      findingKey: `DUPLICATE_ACTIVE_WORK|${taskId}`,
      projectId: input.projectId,
      ruleCode: "DUPLICATE_ACTIVE_WORK",
      severity: "critical",
      summary: `Task ${taskId} has ${runs.length} active worker runs`,
      details: {
        taskId,
        activeRunIds: runs.map((run) => run.id),
        statuses: runs.map((run) => ({ id: run.id, status: run.status })),
      },
      taskId,
    });
  }
}

function evaluateMissingReport(input: AuditInput, findings: DetectedAuditFinding[]): void {
  for (const run of input.workerRuns) {
    if (!isTerminalWorkerRunStatus(run.status)) {
      continue;
    }
    if (input.workerReportsByRunId.has(run.id)) {
      continue;
    }
    pushFinding(findings, {
      findingKey: `MISSING_REPORT|worker|${run.id}`,
      projectId: input.projectId,
      ruleCode: "MISSING_REPORT",
      severity: "high",
      summary: `Worker run ${run.id} reached ${run.status} without a worker report`,
      details: {
        subject: "worker",
        workerRunId: run.id,
        taskId: run.taskId,
        terminalStatus: run.status,
      },
      ...(run.taskId !== undefined ? { taskId: run.taskId } : {}),
      workerRunId: run.id,
    });
  }

  for (const verifierRun of input.verifierRuns) {
    if (verifierRun.status !== "completed") {
      continue;
    }
    const hasResult = input.testResults.some(
      (result) => result.verifierRunId === verifierRun.id,
    );
    if (hasResult) {
      continue;
    }
    pushFinding(findings, {
      findingKey: `MISSING_REPORT|verifier|${verifierRun.id}`,
      projectId: input.projectId,
      ruleCode: "MISSING_REPORT",
      severity: "high",
      summary: `Verifier run ${verifierRun.id} completed without test results`,
      details: {
        subject: "verifier",
        verifierRunId: verifierRun.id,
        taskId: verifierRun.taskId,
        verifierStatus: verifierRun.status,
        outcome: verifierRun.outcome,
      },
      taskId: verifierRun.taskId,
      verifierRunId: verifierRun.id,
    });
  }
}

function evaluateVerifierMismatch(input: AuditInput, findings: DetectedAuditFinding[]): void {
  for (const verifierRun of input.verifierRuns) {
    if (verifierRun.status !== "completed" || verifierRun.outcome === undefined) {
      continue;
    }
    const task = input.tasks.find((candidate) => candidate.id === verifierRun.taskId);
    if (task === undefined) {
      continue;
    }

    if (verifierRun.outcome === "PASS" && task.status === "failed") {
      pushFinding(findings, {
        findingKey: `VERIFIER_MISMATCH|${verifierRun.id}|pass_vs_failed_task`,
        projectId: input.projectId,
        ruleCode: "VERIFIER_MISMATCH",
        severity: "high",
        summary: `Verifier ${verifierRun.id} passed but task ${task.id} is failed`,
        details: {
          verifierRunId: verifierRun.id,
          taskId: task.id,
          verifierOutcome: verifierRun.outcome,
          taskStatus: task.status,
          reason: "pass_vs_failed_task",
        },
        taskId: task.id,
        verifierRunId: verifierRun.id,
      });
    }

    if (verifierRun.outcome === "FAIL" && task.status === "completed") {
      pushFinding(findings, {
        findingKey: `VERIFIER_MISMATCH|${verifierRun.id}|fail_vs_completed_task`,
        projectId: input.projectId,
        ruleCode: "VERIFIER_MISMATCH",
        severity: "high",
        summary: `Verifier ${verifierRun.id} failed but task ${task.id} is completed`,
        details: {
          verifierRunId: verifierRun.id,
          taskId: task.id,
          verifierOutcome: verifierRun.outcome,
          taskStatus: task.status,
          reason: "fail_vs_completed_task",
        },
        taskId: task.id,
        verifierRunId: verifierRun.id,
      });
    }

    const results = input.testResults.filter((result) => result.verifierRunId === verifierRun.id);
    for (const result of results) {
      if (result.outcome === verifierRun.outcome) {
        continue;
      }
      pushFinding(findings, {
        findingKey: `VERIFIER_MISMATCH|${verifierRun.id}|result_${result.id}`,
        projectId: input.projectId,
        ruleCode: "VERIFIER_MISMATCH",
        severity: "high",
        summary: `Verifier ${verifierRun.id} outcome disagrees with test result ${result.id}`,
        details: {
          verifierRunId: verifierRun.id,
          testResultId: result.id,
          verifierOutcome: verifierRun.outcome,
          testResultOutcome: result.outcome,
          reason: "verifier_vs_test_result",
        },
        taskId: verifierRun.taskId,
        verifierRunId: verifierRun.id,
      });
    }
  }
}

function evaluateBudgetAnomaly(input: AuditInput, thresholds: AuditThresholds, findings: DetectedAuditFinding[]): void {
  if (input.budgetLedger === undefined) {
    return;
  }

  for (const view of listBudgetResourceViews(input.budgetLedger)) {
    const check = input.budgetLedger.limits.length > 0
      ? checkBudgetView(view)
      : undefined;
    if (check === undefined) {
      continue;
    }

    if (check.kind === "hard_exceeded") {
      pushFinding(findings, {
        findingKey: `BUDGET_ANOMALY|${view.resourceType}|hard_exceeded`,
        projectId: input.projectId,
        ruleCode: "BUDGET_ANOMALY",
        severity: "high",
        summary: `${view.resourceType} budget hard limit exceeded`,
        details: {
          resourceType: view.resourceType,
          kind: "hard_exceeded",
          hardLimit: view.hardLimit,
          consumedAmount: view.consumedAmount,
          remainingHardLimit: view.remainingHardLimit,
        },
      });
      continue;
    }

    if (check.kind === "soft_exceeded") {
      pushFinding(findings, {
        findingKey: `BUDGET_ANOMALY|${view.resourceType}|soft_exceeded`,
        projectId: input.projectId,
        ruleCode: "BUDGET_ANOMALY",
        severity: "medium",
        summary: `${view.resourceType} budget soft limit exceeded`,
        details: {
          resourceType: view.resourceType,
          kind: "soft_exceeded",
          softLimit: view.softLimit,
          consumedAmount: view.consumedAmount,
        },
      });
      continue;
    }

    const remainingRatio = view.hardLimit > 0 ? view.remainingHardLimit / view.hardLimit : 1;
    if (remainingRatio <= thresholds.budgetApproachingRemainingRatio) {
      pushFinding(findings, {
        findingKey: `BUDGET_ANOMALY|${view.resourceType}|approaching`,
        projectId: input.projectId,
        ruleCode: "BUDGET_ANOMALY",
        severity: "low",
        summary: `${view.resourceType} budget is approaching the hard limit`,
        details: {
          resourceType: view.resourceType,
          kind: "approaching",
          hardLimit: view.hardLimit,
          consumedAmount: view.consumedAmount,
          remainingHardLimit: view.remainingHardLimit,
          remainingRatio,
          thresholdRatio: thresholds.budgetApproachingRemainingRatio,
        },
      });
    }
  }
}

function checkBudgetView(view: {
  hardLimit: number;
  softLimit?: number;
  consumedAmount: number;
  remainingHardLimit: number;
}): { kind: "hard_exceeded" | "soft_exceeded" | "approaching" } | undefined {
  if (view.consumedAmount >= view.hardLimit) {
    return { kind: "hard_exceeded" };
  }
  if (view.softLimit !== undefined && view.consumedAmount >= view.softLimit) {
    return { kind: "soft_exceeded" };
  }
  return undefined;
}

function evaluateRepeatedIdenticalFailure(
  input: AuditInput,
  thresholds: AuditThresholds,
  findings: DetectedAuditFinding[],
): void {
  const runsByTask = groupWorkerRunsByTask(input);

  for (const [taskId, runs] of runsByTask) {
    const failedRuns = runs.filter((run) => isFailureWorkerStatus(run.status));
    const byMessage = new Map<string, string[]>();

    for (const run of failedRuns) {
      const normalized = normalizeFailureMessage(run.errorMessage);
      if (normalized === undefined) {
        continue;
      }
      const existing = byMessage.get(normalized) ?? [];
      byMessage.set(normalized, [...existing, run.id]);
    }

    for (const [normalizedMessage, runIds] of byMessage) {
      if (runIds.length < thresholds.repeatedIdenticalFailureMin) {
        continue;
      }
      pushFinding(findings, {
        findingKey: `REPEATED_IDENTICAL_FAILURE|${taskId}|${normalizedMessage}`,
        projectId: input.projectId,
        ruleCode: "REPEATED_IDENTICAL_FAILURE",
        severity: "medium",
        summary: `Task ${taskId} failed ${runIds.length} times with the same error`,
        details: {
          taskId,
          normalizedMessage,
          runIds,
          threshold: thresholds.repeatedIdenticalFailureMin,
        },
        taskId,
      });
    }
  }
}

function groupWorkerRunsByTask(input: AuditInput): Map<string, AuditInput["workerRuns"]> {
  const runsByTask = new Map<string, AuditInput["workerRuns"]>();
  for (const run of input.workerRuns) {
    if (run.taskId === undefined) {
      continue;
    }
    const existing = runsByTask.get(run.taskId) ?? [];
    runsByTask.set(run.taskId, [...existing, run]);
  }
  return runsByTask;
}

export function evaluateAuditRules(
  input: AuditInput,
  now: ISOTimestamp,
  thresholds: AuditThresholds = DEFAULT_AUDIT_THRESHOLDS,
): DetectedAuditFinding[] {
  const findings: DetectedAuditFinding[] = [];
  evaluateStuckWorker(input, now, thresholds, findings);
  evaluateRepeatedTaskFailure(input, thresholds, findings);
  evaluateRetryLoop(input, thresholds, findings);
  evaluateDuplicateActiveWork(input, findings);
  evaluateMissingReport(input, findings);
  evaluateVerifierMismatch(input, findings);
  evaluateBudgetAnomaly(input, thresholds, findings);
  evaluateRepeatedIdenticalFailure(input, thresholds, findings);
  return findings;
}

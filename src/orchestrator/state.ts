import type { EntityId } from "../domain/common.js";
import { isTerminalTaskStatus } from "../domain/task.js";
import type { Task } from "../domain/task.js";
import type { VerifierRun } from "../domain/verifier.js";
import type { AsyncStateStore } from "../state/async-store.js";
import { parseRepairTaskContext } from "./repair-context.js";
import type { OrchestrationInput, OrchestrationPhase } from "./types.js";

export async function loadOrchestrationInput(
  store: AsyncStateStore,
  projectId: EntityId,
): Promise<OrchestrationInput> {
  const project = await store.getProject(projectId);
  if (project === undefined) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const [
    masterState,
    tasks,
    workerRuns,
    verifierRuns,
    testCases,
    testResults,
    blockers,
  ] = await Promise.all([
    store.getOrCreateMasterState(projectId),
    store.listTasksByProject(projectId),
    store.listWorkerRunsByProject(projectId),
    store.listVerifierRunsByProject(projectId),
    store.listTestCasesByProject(projectId),
    store.listTestResultsByProject(projectId),
    store.listBlockersByProject(projectId),
  ]);

  return {
    projectId,
    project,
    masterState,
    tasks,
    workerRuns,
    verifierRuns,
    testCases,
    testResults,
    blockers,
  };
}

export function deriveOrchestrationPhase(input: OrchestrationInput): OrchestrationPhase {
  if (input.masterState.status === "completed") {
    return "finished";
  }

  const openBlockers = input.blockers.filter((blocker) => blocker.status === "open");
  const nonTerminalTasks = input.tasks.filter((task) => !isTerminalTaskStatus(task.status));

  if (nonTerminalTasks.length === 0 && openBlockers.length === 0) {
    return input.masterState.status === "planning" ? "planning" : "awaiting_work";
  }

  if (
    nonTerminalTasks.every((task) => task.status === "failed" || task.status === "cancelled") &&
    openBlockers.length > 0
  ) {
    return "blocked";
  }

  if (nonTerminalTasks.length > 0 && nonTerminalTasks.every((task) => isTerminalTaskStatus(task.status))) {
    return openBlockers.length > 0 ? "blocked" : "failed";
  }

  const activeWorkerRuns = input.workerRuns.filter(
    (run) => run.status === "queued" || run.status === "running",
  );
  if (activeWorkerRuns.length > 0) {
    return "worker_active";
  }

  const pendingRepair = input.tasks.some(
    (task) =>
      parseRepairTaskContext(task.description) !== undefined &&
      (task.status === "pending" || task.status === "ready" || task.status === "assigned"),
  );
  if (pendingRepair) {
    return "repair_required";
  }

  const awaitingVerification = input.tasks.filter((task) => task.status === "awaiting_verification");
  if (awaitingVerification.length > 0) {
    const verifierRunning = awaitingVerification.some((task) =>
      input.verifierRuns.some(
        (run) =>
          run.taskId === task.id &&
          (run.status === "pending" || run.status === "running"),
      ),
    );
    if (verifierRunning) {
      return "verifier_running";
    }
    return "awaiting_verification";
  }

  const hasEligibleWork = input.tasks.some(
    (task) =>
      (task.status === "pending" || task.status === "ready") && task.assignedWorkerRunId === undefined,
  );
  if (hasEligibleWork) {
    return "awaiting_work";
  }

  if (openBlockers.length > 0) {
    return "blocked";
  }

  if (input.masterState.status === "planning") {
    return "planning";
  }

  return "awaiting_work";
}

export function testCaseIdForTask(taskId: EntityId): EntityId {
  return `tc-verify-${taskId}`;
}

export function verifierRunIdForAttempt(
  taskId: EntityId,
  workerRunId: EntityId,
  attempt: number,
): EntityId {
  return attempt === 0 ? `ver-${taskId}-${workerRunId}` : `ver-${taskId}-${workerRunId}-r${attempt}`;
}

export function repairTaskId(originalTaskId: EntityId, attempt: number): EntityId {
  return `task-repair-${originalTaskId}-${attempt}`;
}

export function countRepairTasksForOriginal(
  tasks: readonly Task[],
  originalTaskId: EntityId,
): number {
  return tasks.filter((task) => parseRepairTaskContext(task.description)?.originalTaskId === originalTaskId)
    .length;
}

export function countCompletedVerifierAttempts(
  verifierRuns: readonly VerifierRun[],
  taskId: EntityId,
  workerRunId: EntityId,
): number {
  const prefix = `ver-${taskId}-${workerRunId}`;
  return verifierRuns.filter(
    (run) =>
      run.taskId === taskId &&
      run.status === "completed" &&
      (run.id === prefix || run.id.startsWith(`${prefix}-r`)),
  ).length;
}

export function latestCompletedVerifierRun(
  verifierRuns: readonly VerifierRun[],
  taskId: EntityId,
  workerRunId: EntityId,
): VerifierRun | undefined {
  const prefix = `ver-${taskId}-${workerRunId}`;
  return [...verifierRuns]
    .filter(
      (run) =>
        run.taskId === taskId &&
        run.status === "completed" &&
        (run.id === prefix || run.id.startsWith(`${prefix}-r`)),
    )
    .sort((a, b) => b.completedAt?.localeCompare(a.completedAt ?? "") ?? b.id.localeCompare(a.id))[0];
}

export function hasPendingVerifierRun(
  verifierRuns: readonly VerifierRun[],
  taskId: EntityId,
): boolean {
  return verifierRuns.some(
    (run) =>
      run.taskId === taskId && (run.status === "pending" || run.status === "running"),
  );
}

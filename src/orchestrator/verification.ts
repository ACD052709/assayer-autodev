import type { EntityId } from "../domain/common.js";
import type { Task } from "../domain/task.js";
import type { AsyncStateStore } from "../state/async-store.js";
import type { IdFactory } from "../master/ids.js";
import { verifyTaskResult } from "../executor/task-verification.js";
import {
  countCompletedVerifierAttempts,
  hasPendingVerifierRun,
  latestCompletedVerifierRun,
  testCaseIdForTask,
} from "./state.js";
import type { OrchestrationInput } from "./types.js";
import type { VerifierAdapter } from "./verifier-adapter.js";
import { buildVerificationRunInput } from "./verifier-adapter.js";
import { parseRepairTaskContext } from "./repair-context.js";
import { markCandidateEligibleOnAccept } from "./promotion.js";

export async function ensureVerificationTestCase(
  store: AsyncStateStore,
  input: OrchestrationInput,
  task: Task,
): Promise<EntityId> {
  const testCaseId = testCaseIdForTask(task.id);
  const existing = input.testCases.find((testCase) => testCase.id === testCaseId) ?? await store.getTestCase(testCaseId);
  if (existing === undefined) {
    throw new Error(`Missing deterministic browser verification specification for task ${task.id}`);
  }
  if (existing.kind !== "browser" || existing.status !== "active" || existing.browserSpecJson === undefined) {
    throw new Error(`Browser verification test case ${testCaseId} is not fully configured`);
  }
  return testCaseId;
}

async function resolveCandidateForVerification(
  store: AsyncStateStore,
  task: Task,
  latestOutcome: string | undefined,
): Promise<import("../domain/code-candidate.js").CodeCandidate | undefined> {
  if (task.assignedWorkerRunId === undefined) return undefined;
  if (latestOutcome !== "FAIL") {
    return await store.getCodeCandidateByWorkerRun(task.id, task.assignedWorkerRunId);
  }

  const tasks = await store.listTasksByProject(task.projectId);
  const repairs = tasks
    .map((candidateTask) => ({ task: candidateTask, context: parseRepairTaskContext(candidateTask.description) }))
    .filter((item) => item.context?.originalTaskId === task.id && item.task.status === "completed")
    .sort((a, b) => (b.context?.attempt ?? 0) - (a.context?.attempt ?? 0));
  for (const repair of repairs) {
    if (repair.task.assignedWorkerRunId === undefined) continue;
    const candidate = await store.getCodeCandidateByWorkerRun(repair.task.id, repair.task.assignedWorkerRunId);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

export async function maybeRunTaskVerification(
  store: AsyncStateStore,
  _idFactory: IdFactory,
  verifierAdapter: VerifierAdapter,
  input: OrchestrationInput,
  task: Task,
): Promise<{ verifierRunId: EntityId; outcome: string } | undefined> {
  if (parseRepairTaskContext(task.description) !== undefined) {
    return undefined;
  }

  const currentTask = await store.getTask(task.id);
  if (
    currentTask === undefined ||
    currentTask.status !== "awaiting_verification" ||
    currentTask.assignedWorkerRunId === undefined
  ) {
    return undefined;
  }

  const workerRun = await store.getWorkerRun(currentTask.assignedWorkerRunId);
  if (workerRun === undefined || workerRun.status !== "succeeded") {
    return undefined;
  }

  const verifierRuns = await store.listVerifierRunsByProject(currentTask.projectId);
  if (hasPendingVerifierRun(verifierRuns, currentTask.id)) {
    return undefined;
  }

  const latest = latestCompletedVerifierRun(
    verifierRuns,
    currentTask.id,
    workerRun.id,
  );
  if (latest?.outcome === "PASS") {
    return undefined;
  }

  if (latest?.outcome === "FAIL") {
    const tasks = await store.listTasksByProject(currentTask.projectId);
    const repairCompleted = tasks.some((candidate) => {
      const repairContext = parseRepairTaskContext(candidate.description);
      return (
        repairContext?.originalTaskId === currentTask.id && candidate.status === "completed"
      );
    });
    if (!repairCompleted) {
      return undefined;
    }
  }

  const codeCandidate = await resolveCandidateForVerification(store, currentTask, latest?.outcome);
  if (codeCandidate === undefined) {
    return undefined;
  }

  const completedAttempts = countCompletedVerifierAttempts(
    verifierRuns,
    currentTask.id,
    workerRun.id,
  );
  const attempt = completedAttempts;
  const runInput = buildVerificationRunInput(
    currentTask.projectId,
    currentTask.id,
    workerRun.id,
    codeCandidate.id,
    attempt,
  );
  const existingRun = await store.getVerifierRun(runInput.verifierRunId);
  if (existingRun !== undefined) {
    return undefined;
  }

  await ensureVerificationTestCase(store, input, currentTask);
  const result = await verifierAdapter.runVerification(runInput);
  if (result.scheduled === true) {
    return { verifierRunId: result.verifierRunId, outcome: "scheduled" };
  }
  return {
    verifierRunId: result.verifierRunId,
    outcome: result.outcome ?? "INCONCLUSIVE",
  };
}

export async function maybeAcceptVerifiedTask(
  store: AsyncStateStore,
  _input: OrchestrationInput,
  task: Task,
): Promise<{ taskId: EntityId; verifierRunId: EntityId } | undefined> {
  const currentTask = await store.getTask(task.id);
  if (
    currentTask === undefined ||
    currentTask.status !== "awaiting_verification" ||
    currentTask.assignedWorkerRunId === undefined
  ) {
    return undefined;
  }

  const verifierRuns = await store.listVerifierRunsByProject(currentTask.projectId);
  const testResults = await store.listTestResultsByProject(currentTask.projectId);
  const latest = latestCompletedVerifierRun(
    verifierRuns,
    currentTask.id,
    currentTask.assignedWorkerRunId,
  );
  if (latest === undefined || latest.outcome !== "PASS") {
    return undefined;
  }

  const requiredTestCaseId = testCaseIdForTask(currentTask.id);
  const passResults = testResults.filter(
    (result) =>
      result.taskId === currentTask.id &&
      result.verifierRunId === latest.id &&
      result.testCaseId === requiredTestCaseId &&
      result.outcome === "PASS",
  );
  if (passResults.length === 0) {
    return undefined;
  }

  const evidence = (await store.listEvidenceByTask(currentTask.id)).filter(
    (item) => item.verifierRunId === latest.id,
  );
  if (evidence.length === 0) {
    return undefined;
  }

  await verifyTaskResult(
    currentTask.id,
    { decision: "accept", summary: `Independent verification passed (${latest.id})` },
    { store },
  );
  await markCandidateEligibleOnAccept(store, currentTask, latest.id);
  return { taskId: currentTask.id, verifierRunId: latest.id };
}

export async function maybeAcceptCompletedRepairTask(
  store: AsyncStateStore,
  _input: OrchestrationInput,
  task: Task,
): Promise<{ taskId: EntityId; originalTaskId: EntityId } | undefined> {
  const repairContext = parseRepairTaskContext(task.description);
  if (repairContext === undefined || task.status !== "awaiting_verification") {
    return undefined;
  }

  if (task.assignedWorkerRunId === undefined) {
    return undefined;
  }
  const workerRun = await store.getWorkerRun(task.assignedWorkerRunId);
  if (workerRun === undefined || workerRun.status !== "succeeded") {
    return undefined;
  }

  await verifyTaskResult(
    task.id,
    { decision: "accept", summary: "Repair implementation slice accepted" },
    { store },
  );
  return { taskId: task.id, originalTaskId: repairContext.originalTaskId };
}

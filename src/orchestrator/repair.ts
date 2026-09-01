import type { EntityId } from "../domain/common.js";
import type { Task } from "../domain/task.js";
import type { AsyncStateStore } from "../state/async-store.js";
import type { IdFactory } from "../master/ids.js";
import { verifyTaskResult } from "../executor/task-verification.js";
import {
  countRepairTasksForOriginal,
  latestCompletedVerifierRun,
  repairTaskId,
} from "./state.js";
import {
  encodeRepairTaskDescription,
  parseRepairTaskContext,
} from "./repair-context.js";
import type { OrchestrationThresholds } from "./thresholds.js";
import type { OrchestrationInput } from "./types.js";

export async function maybeCreateRepairTask(
  store: AsyncStateStore,
  idFactory: IdFactory,
  input: OrchestrationInput,
  task: Task,
  thresholds: OrchestrationThresholds,
): Promise<{ repairTaskId: EntityId; originalTaskId: EntityId } | undefined> {
  const currentTask = await store.getTask(task.id);
  if (
    currentTask === undefined ||
    currentTask.status !== "awaiting_verification" ||
    currentTask.assignedWorkerRunId === undefined
  ) {
    return undefined;
  }

  const verifierRuns = await store.listVerifierRunsByProject(currentTask.projectId);
  const tasks = await store.listTasksByProject(currentTask.projectId);
  const latest = latestCompletedVerifierRun(
    verifierRuns,
    currentTask.id,
    currentTask.assignedWorkerRunId,
  );
  if (latest === undefined || latest.outcome !== "FAIL") {
    return undefined;
  }

  const repairCount = countRepairTasksForOriginal(tasks, currentTask.id);
  if (repairCount >= thresholds.maxRepairAttemptsPerTask) {
    return undefined;
  }

  const nextAttempt = repairCount + 1;
  const id = repairTaskId(currentTask.id, nextAttempt);
  if (tasks.some((candidate) => candidate.id === id)) {
    return undefined;
  }

  const failureSummary = latest.summary ?? "Independent verification failed";
  const description = encodeRepairTaskDescription(
    `Repair verification failure for task ${currentTask.id}: ${failureSummary}`,
    {
      originalTaskId: currentTask.id,
      verifierRunId: latest.id,
      attempt: nextAttempt,
      failureSummary,
      ...(latest.codeCandidateId !== undefined ? { parentCandidateId: latest.codeCandidateId } : {}),
    },
  );

  await store.createTask({
    id,
    projectId: input.projectId,
    title: `Repair: ${currentTask.title}`,
    description,
    kind: "implementation",
  });

  await store.enqueueMasterInboxItem({
    id: idFactory.next("in"),
    projectId: input.projectId,
    kind: "task_update",
    subject: "Repair task created after verification failure",
    body: `Created ${id} for ${currentTask.id} after verifier ${latest.id} failed`,
    relatedEntityId: currentTask.id,
  });

  return { repairTaskId: id, originalTaskId: currentTask.id };
}

export async function maybeHandleRepairExhaustion(
  store: AsyncStateStore,
  idFactory: IdFactory,
  input: OrchestrationInput,
  task: Task,
  thresholds: OrchestrationThresholds,
): Promise<{ taskId: EntityId; blockerId: EntityId } | undefined> {
  const currentTask = await store.getTask(task.id);
  if (
    currentTask === undefined ||
    currentTask.status !== "awaiting_verification" ||
    currentTask.assignedWorkerRunId === undefined
  ) {
    return undefined;
  }

  const verifierRuns = await store.listVerifierRunsByProject(currentTask.projectId);
  const tasks = await store.listTasksByProject(currentTask.projectId);
  const blockers = await store.listBlockersByProject(currentTask.projectId);
  const latest = latestCompletedVerifierRun(
    verifierRuns,
    currentTask.id,
    currentTask.assignedWorkerRunId,
  );
  if (latest === undefined || latest.outcome !== "FAIL") {
    return undefined;
  }

  const repairCount = countRepairTasksForOriginal(tasks, currentTask.id);
  if (repairCount < thresholds.maxRepairAttemptsPerTask) {
    return undefined;
  }

  const blockerId = idFactory.next("blk");
  const openBlocker = blockers.some(
    (blocker) => blocker.status === "open" && blocker.relatedEntityId === currentTask.id,
  );
  if (!openBlocker) {
    await store.createBlocker({
      id: blockerId,
      projectId: input.projectId,
      kind: "verification",
      summary: `Repair attempts exhausted for task ${currentTask.id}`,
      details: `Verifier ${latest.id} failed after ${repairCount} repair task(s)`,
      relatedEntityId: currentTask.id,
    });
  }

  const pendingRepair = tasks.some((candidate) => {
    const context = parseRepairTaskContext(candidate.description);
    return (
      context?.originalTaskId === currentTask.id &&
      candidate.status !== "completed" &&
      candidate.status !== "cancelled"
    );
  });
  if (pendingRepair) {
    return undefined;
  }

  await verifyTaskResult(
    currentTask.id,
    {
      decision: "reject",
      summary: `Verification repair limit reached (${thresholds.maxRepairAttemptsPerTask})`,
    },
    { store },
  );

  return {
    taskId: currentTask.id,
    blockerId: openBlocker
      ? (blockers.find((b) => b.relatedEntityId === currentTask.id)?.id ?? blockerId)
      : blockerId,
  };
}

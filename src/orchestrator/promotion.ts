import type { EntityId } from "../domain/common.js";
import type { Task } from "../domain/task.js";
import { promotionRunIdForCandidate } from "../domain/code-candidate.js";
import type { AsyncStateStore } from "../state/async-store.js";
import type { OrchestrationInput } from "./types.js";
import { latestCompletedVerifierRun } from "./state.js";
import { resolvePromotionDestination } from "../domain/promotion-target.js";
import type { PromotionLaunchBridge } from "./promotion-launch-bridge.js";

export async function markCandidateEligibleOnAccept(
  store: AsyncStateStore,
  task: Task,
  verifierRunId: EntityId,
): Promise<EntityId | undefined> {
  const verifierRun = await store.getVerifierRun(verifierRunId);
  if (
    verifierRun === undefined ||
    verifierRun.taskId !== task.id ||
    verifierRun.outcome !== "PASS" ||
    verifierRun.codeCandidateId === undefined
  ) {
    return undefined;
  }
  const candidate = await store.getCodeCandidate(verifierRun.codeCandidateId);
  if (candidate === undefined || candidate.projectId !== task.projectId) {
    return undefined;
  }
  await store.markCodeCandidatePromotionEligible({
    codeCandidateId: candidate.id,
    verifierRunId,
    acceptedTaskId: task.id,
  });
  return candidate.id;
}

export async function maybeSchedulePromotion(
  store: AsyncStateStore,
  input: OrchestrationInput,
  task: Task,
  launchBridge: PromotionLaunchBridge,
): Promise<{ promotionRunId: EntityId; codeCandidateId: EntityId } | undefined> {
  const currentTask = await store.getTask(task.id);
  if (currentTask === undefined || currentTask.status !== "completed") {
    return undefined;
  }
  if (currentTask.assignedWorkerRunId === undefined) {
    return undefined;
  }

  const verifierRuns = await store.listVerifierRunsByProject(currentTask.projectId);
  const latest = latestCompletedVerifierRun(
    verifierRuns,
    currentTask.id,
    currentTask.assignedWorkerRunId,
  );
  if (latest === undefined || latest.outcome !== "PASS" || latest.codeCandidateId === undefined) {
    return undefined;
  }
  const candidate = await store.getCodeCandidate(latest.codeCandidateId);
  if (
    candidate === undefined ||
    candidate.status !== "promotion_eligible" ||
    candidate.verifierRunId !== latest.id ||
    candidate.acceptedTaskId !== currentTask.id
  ) {
    return undefined;
  }

  const existingRun = await store.getPromotionRunByCandidate(candidate.id);
  if (existingRun !== undefined) {
    return undefined;
  }

  const destination = resolvePromotionDestination({
    project: input.project,
    taskId: currentTask.id,
  });
  const promotionRunId = promotionRunIdForCandidate(candidate.id);
  await store.createPromotionRun({
    id: promotionRunId,
    projectId: currentTask.projectId,
    codeCandidateId: candidate.id,
    taskId: currentTask.id,
    workerRunId: candidate.workerRunId,
    verifierRunId: candidate.verifierRunId,
    destinationRepository: destination.repository,
    destinationRef: destination.ref,
    baseCommitSha: candidate.baseCommitSha,
  });

  const launch = await launchBridge.launch({
    promotionRunId,
    projectId: currentTask.projectId,
    codeCandidateId: candidate.id,
    taskId: currentTask.id,
    workerRunId: candidate.workerRunId,
    verifierRunId: candidate.verifierRunId,
    destinationRepository: destination.repository,
    destinationRef: destination.ref,
    baseCommitSha: candidate.baseCommitSha,
  });

  if (!launch.launched) {
    await store.completePromotionRun({
      promotionRunId,
      status: "failed",
      errorMessage: launch.errorMessage ?? launch.reason ?? "Promotion launch failed",
    });
    return { promotionRunId, codeCandidateId: candidate.id };
  }

  return { promotionRunId, codeCandidateId: candidate.id };
}

export function hasPendingPromotionRun(
  promotionRuns: readonly import("../domain/code-candidate.js").PromotionRun[],
  taskId: EntityId,
): boolean {
  return promotionRuns.some(
    (run) => run.taskId === taskId && (run.status === "pending" || run.status === "running"),
  );
}

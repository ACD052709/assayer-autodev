import type { Blocker, Requirement } from "../domain/index.js";
import type { WorkerRun } from "../domain/index.js";
import type { WorkerTaskPacket } from "../domain/index.js";
import type { AsyncStateStore } from "../state/async-store.js";

function isApplicableRequirement(requirement: Requirement): boolean {
  return requirement.status === "approved";
}

function isRelevantBlocker(blocker: Blocker, taskId: string, workerRunId: string): boolean {
  if (blocker.status !== "open") {
    return false;
  }
  if (blocker.relatedEntityId === undefined) {
    return true;
  }
  return blocker.relatedEntityId === taskId || blocker.relatedEntityId === workerRunId;
}

export async function buildWorkerTaskPacket(
  store: AsyncStateStore,
  workerRun: WorkerRun,
): Promise<WorkerTaskPacket> {
  if (workerRun.taskId === undefined) {
    throw new Error("Worker run is missing taskId");
  }
  const task = await store.getTask(workerRun.taskId);
  if (task === undefined) {
    throw new Error(`Task not found: ${workerRun.taskId}`);
  }
  if (task.projectId !== workerRun.projectId) {
    throw new Error("Worker run and task project mismatch");
  }

  const project = await store.getProject(workerRun.projectId);
  if (project === undefined) {
    throw new Error(`Project not found: ${workerRun.projectId}`);
  }

  const requirements = (await store.listRequirementsByProject(workerRun.projectId)).filter(
    isApplicableRequirement,
  );
  const contract = await store.getLatestReleaseContract(workerRun.projectId);
  const acceptanceCriteria =
    contract === undefined
      ? []
      : (await store.listAcceptanceCriteriaByProject(workerRun.projectId)).filter(
          (criterion) => criterion.releaseContractId === contract.id,
        );
  const blockers = (await store.listBlockersByProject(workerRun.projectId)).filter((blocker) =>
    isRelevantBlocker(blocker, task.id, workerRun.id),
  );

  return {
    workerRunId: workerRun.id,
    taskId: task.id,
    projectId: workerRun.projectId,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      kind: task.kind,
      status: task.status,
    },
    requirements,
    ...(contract !== undefined ? { releaseContract: contract } : {}),
    acceptanceCriteria,
    blockers,
    doNotModifyConstraints: [...project.doNotModifyConstraints],
    ...(project.targetRepository !== undefined ? { targetRepository: project.targetRepository } : {}),
    ...(project.targetRef !== undefined ? { targetRef: project.targetRef } : {}),
    execution: {
      workerKind: workerRun.workerKind,
      iteration: workerRun.iteration,
      status: workerRun.status,
      ...(workerRun.ownerId !== undefined ? { ownerId: workerRun.ownerId } : {}),
    },
  };
}

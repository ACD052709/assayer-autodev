import type { EntityId, ISOTimestamp } from "../domain/common.js";
import type { WorkerReport } from "../domain/worker.js";
import type { AsyncStateStore } from "../state/async-store.js";
import type { StateStore } from "../state/store.js";
import type { AuditInput } from "./types.js";

export function loadAuditInput(store: StateStore, projectId: EntityId, now: ISOTimestamp): AuditInput {
  const workerRuns = store.listWorkerRunsByProject(projectId);
  const workerReportsByRunId = buildWorkerReportIndex(store, workerRuns);
  const budgetLedger = store.getBudgetLedger(projectId);

  return {
    projectId,
    tasks: store.listTasksByProject(projectId),
    workerRuns,
    workerReportsByRunId,
    verifierRuns: store.listVerifierRunsByProject(projectId),
    testResults: store.listTestResultsByProject(projectId),
    ...(budgetLedger !== undefined ? { budgetLedger } : {}),
    expiredRunningWorkerRuns: store.listExpiredRunningWorkerRuns(projectId, now),
  };
}

export async function loadAuditInputAsync(
  store: AsyncStateStore,
  projectId: EntityId,
  now: ISOTimestamp,
): Promise<AuditInput> {
  const workerRuns = await store.listWorkerRunsByProject(projectId);
  const workerReportsByRunId = new Map<EntityId, WorkerReport>();
  for (const run of workerRuns) {
    const report = await store.getWorkerReportByWorkerRunId(run.id);
    if (report !== undefined) {
      workerReportsByRunId.set(run.id, report);
    }
  }

  const [tasks, verifierRuns, testResults, budgetLedger, expiredRunningWorkerRuns] = await Promise.all([
    store.listTasksByProject(projectId),
    store.listVerifierRunsByProject(projectId),
    store.listTestResultsByProject(projectId),
    store.getBudgetLedger(projectId),
    store.listExpiredRunningWorkerRuns(projectId, now),
  ]);

  return {
    projectId,
    tasks,
    workerRuns,
    workerReportsByRunId,
    verifierRuns,
    testResults,
    ...(budgetLedger !== undefined ? { budgetLedger } : {}),
    expiredRunningWorkerRuns,
  };
}

function buildWorkerReportIndex(
  store: StateStore,
  workerRuns: AuditInput["workerRuns"],
): Map<EntityId, WorkerReport> {
  const workerReportsByRunId = new Map<EntityId, WorkerReport>();
  for (const run of workerRuns) {
    const report = store.getWorkerReportByWorkerRunId(run.id);
    if (report !== undefined) {
      workerReportsByRunId.set(run.id, report);
    }
  }
  return workerReportsByRunId;
}

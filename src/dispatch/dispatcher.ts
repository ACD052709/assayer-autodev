import type {
  CreateWorkerReportInput,
  EntityId,
  MasterInboxItem,
  TaskWorkerAssignment,
  WorkerKind,
  WorkerReport,
} from "../domain/index.js";
import type { IdFactory } from "../master/ids.js";
import { createRandomIdFactory } from "../master/ids.js";
import type { AsyncStateStore } from "../state/async-store.js";
import {
  compareTasksForDispatch,
  DEFAULT_MAX_ASSIGNMENTS,
  dependencyIdsForTask,
  DISPATCH_WORKER_KIND,
  isTaskEligibleForDispatch,
  MAX_ASSIGNMENTS_LIMIT,
  selectIndependentEligibleTasks,
} from "./eligibility.js";
import { DispatchValidationError, WorkerReportValidationError } from "./errors.js";

export interface WorkerDispatcherOptions {
  readonly store: AsyncStateStore;
  readonly idFactory?: IdFactory;
  readonly workerKind?: WorkerKind;
}

export interface DispatchRequest {
  readonly maxAssignments?: number;
}

export interface DispatchResult {
  readonly assignments: readonly TaskWorkerAssignment[];
}

export interface PersistWorkerReportResult {
  readonly report: WorkerReport;
  readonly inboxItem: MasterInboxItem;
  readonly created: boolean;
}

export function normalizeMaxAssignments(value: number | undefined): number {
  const n = value ?? DEFAULT_MAX_ASSIGNMENTS;
  if (!Number.isInteger(n) || n < 1 || n > MAX_ASSIGNMENTS_LIMIT) {
    throw new DispatchValidationError(
      "maxAssignments",
      `Must be an integer between 1 and ${MAX_ASSIGNMENTS_LIMIT}`,
    );
  }
  return n;
}

function workerReportInboxBody(report: WorkerReport, workerRunStatus: string): string {
  return JSON.stringify({
    projectId: report.projectId,
    taskId: report.taskId,
    workerRunId: report.workerRunId,
    reportId: report.id,
    outcome: report.outcome,
    workerRunStatus,
  });
}

function findWorkerReportInbox(
  items: readonly MasterInboxItem[],
  reportId: EntityId,
): MasterInboxItem | undefined {
  return items.find((item) => item.kind === "worker_report" && item.relatedEntityId === reportId);
}

/**
 * Control-plane task dispatcher. Selects eligible tasks, creates one worker_run each,
 * and assigns that run on the task. Does not execute work and does not invent Master tasks.
 */
export class WorkerDispatcher {
  private readonly store: AsyncStateStore;
  private readonly ids: IdFactory;
  private readonly workerKind: WorkerKind;

  constructor(options: WorkerDispatcherOptions) {
    this.store = options.store;
    this.ids = options.idFactory ?? createRandomIdFactory();
    this.workerKind = options.workerKind ?? DISPATCH_WORKER_KIND;
  }

  async dispatch(projectId: EntityId, request: DispatchRequest = {}): Promise<DispatchResult> {
    const maxAssignments = normalizeMaxAssignments(request.maxAssignments);
    const tasks = await this.store.listTasksByProject(projectId);
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const depsByTaskId = new Map<EntityId, readonly EntityId[]>();

    for (const task of tasks) {
      const tableDeps = await this.store.listTaskDependencies(task.id);
      depsByTaskId.set(task.id, dependencyIdsForTask(task, tableDeps));
    }

    const eligible = tasks
      .filter((task) => isTaskEligibleForDispatch(task, depsByTaskId.get(task.id) ?? [], tasksById))
      .sort(compareTasksForDispatch);
    const selected = selectIndependentEligibleTasks(eligible, depsByTaskId, maxAssignments);

    const assignments: TaskWorkerAssignment[] = [];
    const claimedTaskIds = new Set<EntityId>();

    for (const task of selected) {
      if (claimedTaskIds.has(task.id)) {
        continue;
      }
      const assignment = await this.store.assignTaskToWorkerRun({
        id: this.ids.next("wrun"),
        projectId,
        taskId: task.id,
        workerKind: this.workerKind,
      });
      if (assignment === undefined) {
        continue;
      }
      claimedTaskIds.add(assignment.task.id);
      assignments.push(assignment);
    }

    return { assignments };
  }

  /**
   * Persist a worker report and enqueue a Master inbox notification.
   * Does not mutate task status or blockers. Duplicate id or workerRunId is idempotent.
   */
  async persistWorkerReport(input: CreateWorkerReportInput): Promise<PersistWorkerReportResult> {
    const workerRun = await this.store.getWorkerRun(input.workerRunId);
    if (workerRun === undefined) {
      throw new WorkerReportValidationError("not_found", `Worker run not found: ${input.workerRunId}`);
    }
    const task = await this.store.getTask(input.taskId);
    if (task === undefined) {
      throw new WorkerReportValidationError("not_found", `Task not found: ${input.taskId}`);
    }
    if (workerRun.projectId !== input.projectId || task.projectId !== input.projectId) {
      throw new WorkerReportValidationError("mismatch", "Report projectId does not match worker run and task");
    }
    if (workerRun.taskId !== input.taskId || task.id !== input.taskId) {
      throw new WorkerReportValidationError("mismatch", "Report taskId does not match worker run");
    }

    const existingById = await this.store.getWorkerReport(input.id);
    const existingByRun = await this.store.getWorkerReportByWorkerRunId(input.workerRunId);

    if (existingById !== undefined) {
      if (existingById.workerRunId !== input.workerRunId || existingById.projectId !== input.projectId) {
        throw new WorkerReportValidationError("conflict", `Worker report already exists: ${input.id}`);
      }
      const inboxItem = await this.ensureWorkerReportInbox(existingById, workerRun.status);
      return { report: existingById, inboxItem, created: false };
    }

    if (existingByRun !== undefined) {
      const inboxItem = await this.ensureWorkerReportInbox(existingByRun, workerRun.status);
      return { report: existingByRun, inboxItem, created: false };
    }

    const report = await this.store.createWorkerReport(input);
    const inboxItem = await this.ensureWorkerReportInbox(report, workerRun.status);
    return { report, inboxItem, created: true };
  }

  private async ensureWorkerReportInbox(
    report: WorkerReport,
    workerRunStatus: string,
  ): Promise<MasterInboxItem> {
    const inbox = await this.store.listMasterInbox(report.projectId);
    const existing = findWorkerReportInbox(inbox, report.id);
    if (existing !== undefined) {
      return existing;
    }
    return this.store.enqueueMasterInboxItem({
      id: this.ids.next("in"),
      projectId: report.projectId,
      kind: "worker_report",
      subject: `Worker report: ${report.outcome}`,
      body: workerReportInboxBody(report, workerRunStatus),
      relatedEntityId: report.id,
    });
  }
}

export function createWorkerDispatcher(options: WorkerDispatcherOptions): WorkerDispatcher {
  return new WorkerDispatcher(options);
}

/** @deprecated Use WorkerDispatcher. Alias for the task-selection entry point. */
export { WorkerDispatcher as TaskDispatcher };

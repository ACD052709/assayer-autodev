import type {
  EntityId,
  MasterInboxItem,
  Task,
  WorkerEvent,
  WorkerReport,
  WorkerRun,
} from "../domain/index.js";
import type { IdFactory } from "../master/ids.js";
import { createRandomIdFactory } from "../master/ids.js";
import type { AsyncStateStore } from "../state/async-store.js";
import type { PersistWorkerReportResult, WorkerDispatcher } from "../dispatch/index.js";
import { createWorkerDispatcher } from "../dispatch/index.js";
import {
  LIFECYCLE_EVENTS,
  lifecycleEventId,
  workerEventTypeForLifecycle,
  workerReportIdForRun,
  type WorkerRunLifecycleEventName,
} from "./events.js";
import { WorkerRunLifecycleError } from "./errors.js";
import {
  taskStatusForCancel,
  taskStatusForClaim,
  taskStatusForFailure,
  taskStatusForSuccess,
} from "./transitions.js";

export type StructuredOutcome = Readonly<Record<string, string | number | boolean>>;

export interface WorkerRunLifecycleOptions {
  readonly store: AsyncStateStore;
  readonly idFactory?: IdFactory;
  readonly dispatcher?: WorkerDispatcher;
}

export interface SucceedWorkerRunInput {
  readonly summary: string;
  readonly structuredOutcome?: StructuredOutcome;
}

export interface FailWorkerRunInput {
  readonly errorCode: string;
  readonly summary: string;
}

export interface CancelWorkerRunInput {
  readonly reason: string;
}

export interface ClaimWorkerRunResult {
  readonly workerRun: WorkerRun;
  readonly task: Task;
  readonly event: WorkerEvent;
  readonly claimed: boolean;
}

export interface CompleteWorkerRunResult {
  readonly workerRun: WorkerRun;
  readonly task: Task;
  readonly event: WorkerEvent;
  readonly report: WorkerReport;
  readonly inboxItem: MasterInboxItem;
  readonly applied: boolean;
}

export interface CancelWorkerRunResult {
  readonly workerRun: WorkerRun;
  readonly task: Task;
  readonly event: WorkerEvent;
  readonly applied: boolean;
}

const MAX_SUMMARY_CHARS = 2000;
const MAX_STRUCTURED_KEYS = 16;
const STRUCTURED_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export function sanitizeSummary(value: string, field = "summary"): string {
  const trimmed = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
  if (trimmed.length === 0) {
    throw new WorkerRunLifecycleError("validation", `Invalid ${field}`);
  }
  return trimmed.length > MAX_SUMMARY_CHARS ? trimmed.slice(0, MAX_SUMMARY_CHARS) : trimmed;
}

export function sanitizeErrorCode(value: string): string {
  const trimmed = value.trim();
  if (!ERROR_CODE_PATTERN.test(trimmed)) {
    throw new WorkerRunLifecycleError(
      "validation",
      "errorCode must be a short token (letters, digits, '.', '_', '-')",
    );
  }
  return trimmed;
}

export function constrainStructuredOutcome(value: StructuredOutcome): StructuredOutcome {
  const entries = Object.entries(value);
  if (entries.length > MAX_STRUCTURED_KEYS) {
    throw new WorkerRunLifecycleError("validation", "structuredOutcome has too many keys");
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, entry] of entries) {
    if (!STRUCTURED_KEY_PATTERN.test(key)) {
      throw new WorkerRunLifecycleError("validation", `Invalid structuredOutcome key: ${key}`);
    }
    if (typeof entry === "string") {
      if (entry.length > 256) {
        throw new WorkerRunLifecycleError("validation", `structuredOutcome.${key} is too long`);
      }
      result[key] = entry;
      continue;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      result[key] = entry;
      continue;
    }
    if (typeof entry === "boolean") {
      result[key] = entry;
      continue;
    }
    throw new WorkerRunLifecycleError("validation", `structuredOutcome.${key} must be string, number, or boolean`);
  }
  return result;
}

function metricsFromStructuredOutcome(
  outcome: StructuredOutcome | undefined,
): Record<string, number> | undefined {
  if (outcome === undefined) {
    return undefined;
  }
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(outcome)) {
    if (typeof value === "number") {
      metrics[key] = value;
    }
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function throwForTransition(reason: "not_found" | "inconsistent" | "illegal_transition"): never {
  if (reason === "not_found") {
    throw new WorkerRunLifecycleError("not_found", "Worker run or task not found");
  }
  if (reason === "inconsistent") {
    throw new WorkerRunLifecycleError(
      "inconsistent",
      "Worker run and task assignment are inconsistent",
    );
  }
  throw new WorkerRunLifecycleError("illegal_transition", "Illegal worker-run transition");
}

/**
 * Control-plane worker-run lifecycle. Claims, completes, and cancels runs.
 * Does not execute coding work.
 */
export class WorkerRunLifecycle {
  private readonly store: AsyncStateStore;
  private readonly reports: WorkerDispatcher;

  constructor(options: WorkerRunLifecycleOptions) {
    this.store = options.store;
    this.reports =
      options.dispatcher ??
      createWorkerDispatcher({
        store: options.store,
        idFactory: options.idFactory ?? createRandomIdFactory(),
      });
  }

  async claim(workerRunId: EntityId): Promise<ClaimWorkerRunResult> {
    const taskStatuses = taskStatusForClaim();
    const result = await this.store.applyWorkerRunTaskTransition({
      workerRunId,
      fromRunStatuses: ["queued"],
      toRunStatus: "running",
      fromTaskStatuses: taskStatuses.from,
      toTaskStatus: taskStatuses.to,
    });
    if (!result.ok) {
      throwForTransition(result.reason);
    }
    const event = await this.ensureLifecycleEvent(result.workerRun, LIFECYCLE_EVENTS.STARTED, {
      fromStatus: "queued",
      toStatus: "running",
      taskStatus: result.task.status,
    });
    return {
      workerRun: result.workerRun,
      task: result.task,
      event,
      claimed: result.applied,
    };
  }

  async succeed(workerRunId: EntityId, input: SucceedWorkerRunInput): Promise<CompleteWorkerRunResult> {
    const summary = sanitizeSummary(input.summary);
    const structuredOutcome =
      input.structuredOutcome !== undefined
        ? constrainStructuredOutcome(input.structuredOutcome)
        : undefined;
    const taskStatuses = taskStatusForSuccess();
    const result = await this.store.applyWorkerRunTaskTransition({
      workerRunId,
      fromRunStatuses: ["running"],
      toRunStatus: "succeeded",
      fromTaskStatuses: taskStatuses.from,
      toTaskStatus: taskStatuses.to,
    });
    if (!result.ok) {
      throwForTransition(result.reason);
    }
    const event = await this.ensureLifecycleEvent(result.workerRun, LIFECYCLE_EVENTS.SUCCEEDED, {
      fromStatus: "running",
      toStatus: "succeeded",
      taskStatus: result.task.status,
      ...(structuredOutcome !== undefined ? { structuredOutcome } : {}),
    });
    const metrics = metricsFromStructuredOutcome(structuredOutcome);
    const persisted = await this.persistTerminalReport(result.workerRun, {
      summary,
      outcome: "success",
      ...(metrics !== undefined ? { metrics } : {}),
      ...(structuredOutcome !== undefined ? { structuredOutcome } : {}),
    });
    return {
      workerRun: result.workerRun,
      task: result.task,
      event,
      report: persisted.report,
      inboxItem: persisted.inboxItem,
      applied: result.applied,
    };
  }

  async fail(workerRunId: EntityId, input: FailWorkerRunInput): Promise<CompleteWorkerRunResult> {
    const errorCode = sanitizeErrorCode(input.errorCode);
    const summary = sanitizeSummary(input.summary);
    const taskStatuses = taskStatusForFailure();
    const result = await this.store.applyWorkerRunTaskTransition({
      workerRunId,
      fromRunStatuses: ["running"],
      toRunStatus: "failed",
      fromTaskStatuses: taskStatuses.from,
      toTaskStatus: taskStatuses.to,
      errorMessage: `${errorCode}: ${summary}`,
    });
    if (!result.ok) {
      throwForTransition(result.reason);
    }
    const event = await this.ensureLifecycleEvent(result.workerRun, LIFECYCLE_EVENTS.FAILED, {
      fromStatus: "running",
      toStatus: "failed",
      taskStatus: result.task.status,
      errorCode,
    });
    const persisted = await this.persistTerminalReport(result.workerRun, {
      summary,
      outcome: "failure",
      errorCode,
    });
    return {
      workerRun: result.workerRun,
      task: result.task,
      event,
      report: persisted.report,
      inboxItem: persisted.inboxItem,
      applied: result.applied,
    };
  }

  async cancel(workerRunId: EntityId, input: CancelWorkerRunInput): Promise<CancelWorkerRunResult> {
    const reason = sanitizeSummary(input.reason, "reason");
    const existing = await this.store.getWorkerRun(workerRunId);
    if (existing === undefined) {
      throw new WorkerRunLifecycleError("not_found", `Worker run not found: ${workerRunId}`);
    }
    if (existing.status === "queued") {
      return this.cancelFrom(existing, "queued", reason);
    }
    if (existing.status === "running") {
      return this.cancelFrom(existing, "running", reason);
    }
    throw new WorkerRunLifecycleError("illegal_transition", "Cannot cancel a terminal worker run");
  }

  private async cancelFrom(
    existing: WorkerRun,
    fromStatus: "queued" | "running",
    reason: string,
  ): Promise<CancelWorkerRunResult> {
    const taskStatuses = taskStatusForCancel(fromStatus);
    const result = await this.store.applyWorkerRunTaskTransition({
      workerRunId: existing.id,
      fromRunStatuses: [fromStatus],
      toRunStatus: "cancelled",
      fromTaskStatuses: taskStatuses.from,
      toTaskStatus: taskStatuses.to,
      errorMessage: reason,
    });
    if (!result.ok) {
      throwForTransition(result.reason);
    }
    const event = await this.ensureLifecycleEvent(result.workerRun, LIFECYCLE_EVENTS.CANCELLED, {
      fromStatus,
      toStatus: "cancelled",
      taskStatus: result.task.status,
    });
    return {
      workerRun: result.workerRun,
      task: result.task,
      event,
      applied: result.applied,
    };
  }

  private async persistTerminalReport(
    workerRun: WorkerRun,
    input: {
      summary: string;
      outcome: WorkerReport["outcome"];
      metrics?: Record<string, number>;
      structuredOutcome?: StructuredOutcome;
      errorCode?: string;
    },
  ): Promise<PersistWorkerReportResult> {
    const taskId = workerRun.taskId;
    if (taskId === undefined) {
      throw new WorkerRunLifecycleError("inconsistent", "Worker run is missing taskId");
    }
    return this.reports.persistWorkerReport(
      {
        id: workerReportIdForRun(workerRun.id),
        projectId: workerRun.projectId,
        taskId,
        workerRunId: workerRun.id,
        summary: input.summary,
        outcome: input.outcome,
        ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
      },
      {
        ...(input.structuredOutcome !== undefined ? { structuredOutcome: input.structuredOutcome } : {}),
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      },
    );
  }

  private async ensureLifecycleEvent(
    workerRun: WorkerRun,
    name: WorkerRunLifecycleEventName,
    payload: Record<string, unknown>,
  ): Promise<WorkerEvent> {
    const taskId = workerRun.taskId;
    if (taskId === undefined) {
      throw new WorkerRunLifecycleError("inconsistent", "Worker run is missing taskId");
    }
    const eventId = lifecycleEventId(workerRun.id, name);
    const existing = (await this.store.listWorkerEvents(workerRun.id)).find(
      (event) => event.id === eventId || event.payload?.["lifecycle"] === name,
    );
    if (existing !== undefined) {
      return existing;
    }
    return this.store.appendWorkerEvent({
      id: eventId,
      projectId: workerRun.projectId,
      taskId,
      workerRunId: workerRun.id,
      eventType: workerEventTypeForLifecycle(name),
      message: name,
      payload: { lifecycle: name, ...payload },
    });
  }
}

export function createWorkerRunLifecycle(options: WorkerRunLifecycleOptions): WorkerRunLifecycle {
  return new WorkerRunLifecycle(options);
}

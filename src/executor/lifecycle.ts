import type {
  EntityId,
  ISOTimestamp,
  MasterInboxItem,
  Task,
  WorkerEvent,
  WorkerReport,
  WorkerRun,
} from "../domain/index.js";
import { nowIso } from "../domain/common.js";
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
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_ATTEMPTS_LIMIT,
  generateLeaseToken,
  hashLeaseToken,
  leaseExpiryIso,
} from "./lease.js";
import {
  taskStatusForCancel,
  taskStatusForFailure,
  taskStatusForSuccess,
  taskStatusForTimeout,
} from "./transitions.js";

export type StructuredOutcome = Readonly<Record<string, string | number | boolean>>;

export interface WorkerRunLifecycleOptions {
  readonly store: AsyncStateStore;
  readonly idFactory?: IdFactory;
  readonly dispatcher?: WorkerDispatcher;
  readonly now?: () => ISOTimestamp;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
}

export interface ClaimWorkerRunInput {
  readonly ownerId: EntityId;
}

export interface SucceedWorkerRunInput {
  readonly summary: string;
  readonly leaseToken: string;
  readonly structuredOutcome?: StructuredOutcome;
}

export interface FailWorkerRunInput {
  readonly errorCode: string;
  readonly summary: string;
  readonly leaseToken: string;
}

export interface CancelWorkerRunInput {
  readonly reason: string;
  readonly leaseToken?: string;
}

export interface HeartbeatWorkerRunLifecycleInput {
  readonly leaseToken: string;
}

export interface ClaimWorkerRunResult {
  readonly workerRun: WorkerRun;
  readonly task: Task;
  readonly event: WorkerEvent;
  readonly claimed: boolean;
  readonly leaseToken: string;
}

export interface HeartbeatWorkerRunLifecycleResult {
  readonly workerRun: WorkerRun;
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

export interface RecoveredExpiredRun {
  readonly workerRun: WorkerRun;
  readonly task: Task;
  readonly event: WorkerEvent;
  readonly report: WorkerReport;
  readonly inboxItem: MasterInboxItem;
  readonly applied: boolean;
}

export interface RecoverExpiredRunsResult {
  readonly recovered: readonly RecoveredExpiredRun[];
}

export interface RetryWorkerRunResult {
  readonly previousWorkerRun: WorkerRun;
  readonly workerRun: WorkerRun;
  readonly task: Task;
  readonly event: WorkerEvent;
}

const MAX_SUMMARY_CHARS = 2000;
const MAX_STRUCTURED_KEYS = 16;
const STRUCTURED_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const OWNER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TIMEOUT_ERROR_CODE = "LEASE_EXPIRED";
const TIMEOUT_SUMMARY = "Worker lease expired without a heartbeat.";

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

function assertOwnerId(value: string): EntityId {
  if (!OWNER_ID_PATTERN.test(value)) {
    throw new WorkerRunLifecycleError("validation", "Invalid ownerId");
  }
  return value;
}

function assertLeaseToken(value: string): string {
  if (value.length < 32 || value.length > 256 || /[\u0000-\u001F]/.test(value)) {
    throw new WorkerRunLifecycleError("validation", "Invalid leaseToken");
  }
  return value;
}

function clampMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new WorkerRunLifecycleError("validation", "maxAttempts must be a positive integer");
  }
  return Math.min(value, MAX_ATTEMPTS_LIMIT);
}

function throwForTransition(
  reason: "not_found" | "inconsistent" | "illegal_transition" | "unauthorized" | "expired" | "already_claimed",
): never {
  if (reason === "not_found") {
    throw new WorkerRunLifecycleError("not_found", "Worker run or task not found");
  }
  if (reason === "inconsistent") {
    throw new WorkerRunLifecycleError(
      "inconsistent",
      "Worker run and task assignment are inconsistent",
    );
  }
  if (reason === "unauthorized") {
    throw new WorkerRunLifecycleError("unauthorized", "Lease token is not valid for this worker run");
  }
  if (reason === "expired") {
    throw new WorkerRunLifecycleError("expired", "Worker-run lease has expired");
  }
  if (reason === "already_claimed") {
    throw new WorkerRunLifecycleError("conflict", "Worker run is already claimed");
  }
  throw new WorkerRunLifecycleError("illegal_transition", "Illegal worker-run transition");
}

/**
 * Control-plane worker-run lifecycle. Claims, heartbeats, completes, times out, and retries runs.
 * Does not execute coding work.
 */
export class WorkerRunLifecycle {
  private readonly store: AsyncStateStore;
  private readonly reports: WorkerDispatcher;
  private readonly ids: IdFactory;
  private readonly nowFn: () => ISOTimestamp;
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;

  constructor(options: WorkerRunLifecycleOptions) {
    this.store = options.store;
    this.ids = options.idFactory ?? createRandomIdFactory();
    this.reports =
      options.dispatcher ??
      createWorkerDispatcher({
        store: options.store,
        idFactory: this.ids,
      });
    this.nowFn = options.now ?? nowIso;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.maxAttempts = clampMaxAttempts(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  }

  async claim(workerRunId: EntityId, input: ClaimWorkerRunInput): Promise<ClaimWorkerRunResult> {
    const ownerId = assertOwnerId(input.ownerId);
    const at = this.nowFn();
    const leaseToken = generateLeaseToken();
    const leaseTokenHash = await hashLeaseToken(leaseToken);
    const result = await this.store.claimQueuedWorkerRun({
      workerRunId,
      ownerId,
      leaseTokenHash,
      leaseExpiresAt: leaseExpiryIso(at, this.leaseDurationMs),
      lastHeartbeatAt: at,
      at,
    });
    if (!result.ok) {
      throwForTransition(result.reason);
    }
    const event = await this.ensureLifecycleEvent(result.workerRun, LIFECYCLE_EVENTS.STARTED, {
      fromStatus: "queued",
      toStatus: "running",
      taskStatus: result.task.status,
      ownerId,
    });
    return {
      workerRun: result.workerRun,
      task: result.task,
      event,
      claimed: true,
      leaseToken,
    };
  }

  async heartbeat(
    workerRunId: EntityId,
    input: HeartbeatWorkerRunLifecycleInput,
  ): Promise<HeartbeatWorkerRunLifecycleResult> {
    const leaseToken = assertLeaseToken(input.leaseToken);
    const at = this.nowFn();
    const result = await this.store.heartbeatWorkerRun({
      workerRunId,
      leaseTokenHash: await hashLeaseToken(leaseToken),
      lastHeartbeatAt: at,
      leaseExpiresAt: leaseExpiryIso(at, this.leaseDurationMs),
      now: at,
    });
    if (!result.ok) {
      throwForTransition(result.reason);
    }
    return { workerRun: result.workerRun };
  }

  async succeed(workerRunId: EntityId, input: SucceedWorkerRunInput): Promise<CompleteWorkerRunResult> {
    const summary = sanitizeSummary(input.summary);
    const leaseToken = assertLeaseToken(input.leaseToken);
    const structuredOutcome =
      input.structuredOutcome !== undefined
        ? constrainStructuredOutcome(input.structuredOutcome)
        : undefined;
    const at = this.nowFn();
    const taskStatuses = taskStatusForSuccess();
    const result = await this.store.applyWorkerRunTaskTransition({
      workerRunId,
      fromRunStatuses: ["running"],
      toRunStatus: "succeeded",
      fromTaskStatuses: taskStatuses.from,
      toTaskStatus: taskStatuses.to,
      at,
      now: at,
      leaseTokenHash: await hashLeaseToken(leaseToken),
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
    const leaseToken = assertLeaseToken(input.leaseToken);
    const at = this.nowFn();
    const taskStatuses = taskStatusForFailure();
    const result = await this.store.applyWorkerRunTaskTransition({
      workerRunId,
      fromRunStatuses: ["running"],
      toRunStatus: "failed",
      fromTaskStatuses: taskStatuses.from,
      toTaskStatus: taskStatuses.to,
      errorMessage: `${errorCode}: ${summary}`,
      at,
      now: at,
      leaseTokenHash: await hashLeaseToken(leaseToken),
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
      if (input.leaseToken === undefined) {
        throw new WorkerRunLifecycleError("validation", "leaseToken is required to cancel a running worker run");
      }
      return this.cancelFrom(existing, "running", reason, assertLeaseToken(input.leaseToken));
    }
    throw new WorkerRunLifecycleError("illegal_transition", "Cannot cancel a terminal worker run");
  }

  async recoverExpiredRuns(projectId: EntityId): Promise<RecoverExpiredRunsResult> {
    const project = await this.store.getProject(projectId);
    if (project === undefined) {
      throw new WorkerRunLifecycleError("not_found", `Project not found: ${projectId}`);
    }
    const at = this.nowFn();
    const expired = await this.store.listExpiredRunningWorkerRuns(projectId, at);
    const recovered: RecoveredExpiredRun[] = [];
    const taskStatuses = taskStatusForTimeout();
    for (const run of expired) {
      const result = await this.store.applyWorkerRunTaskTransition({
        workerRunId: run.id,
        fromRunStatuses: ["running"],
        toRunStatus: "timed_out",
        fromTaskStatuses: taskStatuses.from,
        toTaskStatus: taskStatuses.to,
        errorMessage: `${TIMEOUT_ERROR_CODE}: ${TIMEOUT_SUMMARY}`,
        at,
      });
      if (!result.ok) {
        continue;
      }
      const event = await this.ensureLifecycleEvent(result.workerRun, LIFECYCLE_EVENTS.TIMED_OUT, {
        fromStatus: "running",
        toStatus: "timed_out",
        taskStatus: result.task.status,
        ...(result.workerRun.ownerId !== undefined ? { ownerId: result.workerRun.ownerId } : {}),
        ...(result.workerRun.leaseExpiresAt !== undefined
          ? { leaseExpiresAt: result.workerRun.leaseExpiresAt }
          : {}),
      });
      const persisted = await this.persistTerminalReport(result.workerRun, {
        summary: TIMEOUT_SUMMARY,
        outcome: "failure",
        errorCode: TIMEOUT_ERROR_CODE,
      });
      recovered.push({
        workerRun: result.workerRun,
        task: result.task,
        event,
        report: persisted.report,
        inboxItem: persisted.inboxItem,
        applied: result.applied,
      });
    }
    return { recovered: recovered.filter((item) => item.applied) };
  }

  async retry(workerRunId: EntityId): Promise<RetryWorkerRunResult> {
    const previous = await this.store.getWorkerRun(workerRunId);
    if (previous === undefined) {
      throw new WorkerRunLifecycleError("not_found", `Worker run not found: ${workerRunId}`);
    }
    if (previous.status !== "timed_out") {
      throw new WorkerRunLifecycleError("illegal_transition", "Only timed_out worker runs can be retried");
    }
    if (previous.iteration >= this.maxAttempts) {
      throw new WorkerRunLifecycleError("conflict", "Maximum worker-run attempts reached");
    }
    const at = this.nowFn();
    const assignment = await this.store.requeueTimedOutWorkerRun({
      previousWorkerRunId: previous.id,
      newWorkerRunId: this.ids.next("wrun"),
      projectId: previous.projectId,
      at,
    });
    if (assignment === undefined) {
      throw new WorkerRunLifecycleError(
        "conflict",
        "Cannot requeue timed-out worker run (task already has an active run or is not in recovery state)",
      );
    }
    const unchanged = await this.store.getWorkerRun(previous.id);
    if (unchanged === undefined || unchanged.status !== "timed_out") {
      throw new WorkerRunLifecycleError("inconsistent", "Previous worker run was mutated during retry");
    }
    const event = await this.ensureLifecycleEvent(assignment.workerRun, LIFECYCLE_EVENTS.RETRY_CREATED, {
      previousWorkerRunId: previous.id,
      iteration: assignment.workerRun.iteration,
      taskStatus: assignment.task.status,
    });
    return {
      previousWorkerRun: unchanged,
      workerRun: assignment.workerRun,
      task: assignment.task,
      event,
    };
  }

  private async cancelFrom(
    existing: WorkerRun,
    fromStatus: "queued" | "running",
    reason: string,
    leaseToken?: string,
  ): Promise<CancelWorkerRunResult> {
    const at = this.nowFn();
    const taskStatuses = taskStatusForCancel(fromStatus);
    const result = await this.store.applyWorkerRunTaskTransition({
      workerRunId: existing.id,
      fromRunStatuses: [fromStatus],
      toRunStatus: "cancelled",
      fromTaskStatuses: taskStatuses.from,
      toTaskStatus: taskStatuses.to,
      errorMessage: reason,
      at,
      ...(leaseToken !== undefined
        ? { leaseTokenHash: await hashLeaseToken(leaseToken), now: at }
        : {}),
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

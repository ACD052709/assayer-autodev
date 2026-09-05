import type { AsyncStateStore } from "../state/async-store.js";
import type { WorkerReport } from "../domain/index.js";
import { codeCandidateIdForWorkerRun } from "../domain/code-candidate.js";
import { assertPromotionRefPrefixAllowed, assertPromotionRepositoryAllowed, PromotionTargetError } from "../domain/promotion-target.js";
import type { EvidenceBlobStore } from "../evidence/index.js";
import { evidenceBlobKey, candidateBlobKey } from "../evidence/index.js";
import { verifyPatchChecksum } from "../security/checksum.js";
import type { MasterOrchestrator } from "../master/index.js";
import { MasterModelConfigError } from "../master/index.js";
import {
  createWorkerDispatcher,
  DispatchValidationError,
  normalizeMaxAssignments,
  WorkerDispatcher,
  WorkerReportValidationError,
} from "../dispatch/index.js";
import {
  assertTaskVerificationDecision,
  createWorkerRunLifecycle,
  TaskVerificationError,
  verifyTaskResult,
  WorkerRunLifecycle,
  WorkerRunLifecycleError,
  type StructuredOutcome,
} from "../executor/index.js";
import {
  BudgetResourceConflictError,
  expectedBudgetUnit,
  listBudgetResourceViews,
  toBudgetResourceView,
} from "../domain/budget.js";
import type { AuthConfig } from "./auth/index.js";
import {
  assertCallerPermitted,
  authenticateBearer,
  INBOX_WRITE_POLICY,
  MASTER_WRITE_POLICY,
  policyFor,
  PUBLIC_ROUTE_POLICY,
  READ_POLICY,
  VERIFIER_WRITE_POLICY,
  WORKER_WRITE_POLICY,
  type RoutePolicy,
} from "./auth/index.js";
import { ApiError, finalizeResponse, jsonResponse } from "./errors.js";
import {
  decodeBootstrapBase64,
  MAX_BOOTSTRAP_BLOB_BYTES,
  MAX_EVIDENCE_JSON_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  readJsonBody,
} from "./security/index.js";
import {
  assertDoNotModifyConstraints,
  assertEntityId,
  assertLeaseToken,
  assertNonEmptyString,
  assertObject,
  assertOptionalRepositorySlug,
  assertOptionalTrustedTestCommand,
  rejectUnknownKeys,
  validators,
} from "./validation.js";
import { buildWorkerTaskPacket } from "../worker/task-packet.js";
import { hashLeaseToken } from "../executor/lease.js";
import { nowIso } from "../domain/common.js";
import { runProjectAudit } from "../auditor/index.js";
import { reconstructProjectTaskLifecycles } from "../auditor/persisted-lifecycle.js";
import type { AuditFindingStatus } from "../domain/audit-finding.js";
import type { createAutoDevOrchestrator } from "../orchestrator/index.js";
import { parseBrowserTestSpec } from "../verifier/browser-spec.js";

export type AutoDevOrchestrator = ReturnType<typeof createAutoDevOrchestrator>;

export interface ApiDependencies {
  store: AsyncStateStore;
  blobs: EvidenceBlobStore;
  masterOrchestrator?: MasterOrchestrator;
  autoDevOrchestrator?: AutoDevOrchestrator;
  taskDispatcher?: WorkerDispatcher;
  workerRunLifecycle?: WorkerRunLifecycle;
}

export interface ApiRouterOptions {
  deps: ApiDependencies;
  auth: AuthConfig;
}

type RouteHandler = (
  request: Request,
  params: Record<string, string>,
  deps: ApiDependencies,
) => Promise<Response>;

function assertOptionalEntityId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertEntityId(value, field);
}

function assertOptionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertNonEmptyString(value, field);
}

function assertFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(400, "validation_error", `Invalid ${field}`, [
      { field, message: "Must be a finite number" },
    ]);
  }
  return value;
}

function assertOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertFiniteNumber(value, field);
}

function assertOptionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertObject(value, field);
}

function assertEntityIdArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ApiError(400, "validation_error", `Invalid ${field}`, [
      { field, message: "Must be an array" },
    ]);
  }
  return value.map((item, index) => assertEntityId(item, `${field}[${index}]`));
}

function assertOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ApiError(400, "validation_error", `Invalid ${field}`, [
      { field, message: "Must be a boolean" },
    ]);
  }
  return value;
}

function assertStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ApiError(400, "validation_error", `Invalid ${field}`, [
      { field, message: "Must be an array" },
    ]);
  }
  return value.map((item, index) => assertNonEmptyString(item, `${field}[${index}]`));
}

function assertNumberRecord(value: unknown, field: string): Record<string, number> | undefined {
  const obj = assertOptionalObject(value, field);
  if (obj === undefined) {
    return undefined;
  }
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(obj)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new ApiError(400, "validation_error", `Invalid ${field}.${key}`, [
        { field: `${field}.${key}`, message: "Must be a finite number" },
      ]);
    }
    result[key] = entry;
  }
  return result;
}

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i]!;
    const pathPart = pathParts[i]!;
    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

function dispatcherFor(deps: ApiDependencies): WorkerDispatcher {
  return deps.taskDispatcher ?? createWorkerDispatcher({ store: deps.store });
}

function lifecycleFor(deps: ApiDependencies): WorkerRunLifecycle {
  return (
    deps.workerRunLifecycle ??
    createWorkerRunLifecycle({ store: deps.store, dispatcher: dispatcherFor(deps) })
  );
}

function mapLifecycleError(error: WorkerRunLifecycleError): ApiError {
  if (error.code === "not_found") {
    return new ApiError(404, "not_found", error.message);
  }
  if (error.code === "validation") {
    return new ApiError(400, "validation_error", error.message);
  }
  if (error.code === "unauthorized") {
    return new ApiError(403, "forbidden", error.message);
  }
  if (error.code === "expired") {
    return new ApiError(409, "conflict", error.message);
  }
  if (error.code === "inconsistent") {
    return new ApiError(409, "conflict", error.message);
  }
  return new ApiError(409, "conflict", error.message);
}

function mapTaskVerificationError(error: TaskVerificationError): ApiError {
  if (error.code === "not_found") {
    return new ApiError(404, "not_found", error.message);
  }
  if (error.code === "validation") {
    return new ApiError(400, "validation_error", error.message);
  }
  if (error.code === "inconsistent") {
    return new ApiError(409, "conflict", error.message);
  }
  return new ApiError(409, "conflict", error.message);
}

function assertStructuredOutcome(value: unknown, field: string): StructuredOutcome | undefined {
  const obj = assertOptionalObject(value, field);
  if (obj === undefined) {
    return undefined;
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(obj)) {
    if (typeof entry === "string" || typeof entry === "boolean") {
      result[key] = entry;
      continue;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      result[key] = entry;
      continue;
    }
    throw new ApiError(400, "validation_error", `Invalid ${field}.${key}`, [
      { field: `${field}.${key}`, message: "Must be a string, finite number, or boolean" },
    ]);
  }
  return result;
}

function assertOptionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const n = assertFiniteNumber(value, field);
  if (!Number.isInteger(n)) {
    throw new ApiError(400, "validation_error", `Invalid ${field}`, [
      { field, message: "Must be an integer" },
    ]);
  }
  return n;
}

async function requireProject(store: AsyncStateStore, projectId: string) {
  const project = await store.getProject(projectId);
  if (project === undefined) {
    throw new ApiError(404, "not_found", `Project not found: ${projectId}`);
  }
  return project;
}

async function handleGetHealth(): Promise<Response> {
  return jsonResponse({ status: "ok" });
}

async function handleGetProjectState(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  const project = await requireProject(deps.store, projectId);
  const masterState = await deps.store.getOrCreateMasterState(projectId);
  return jsonResponse({ project, masterState });
}

async function handleGetProjectTasks(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const tasks = await deps.store.listTasksByProject(projectId);
  return jsonResponse({ tasks });
}

async function handleGetTask(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const taskId = assertEntityId(params.taskId, "taskId");
  const task = await deps.store.getTask(taskId);
  if (task === undefined) {
    throw new ApiError(404, "not_found", `Task not found: ${taskId}`);
  }
  return jsonResponse({ task });
}

async function handlePostTaskVerify(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const taskId = assertEntityId(params.taskId, "taskId");
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["decision", "summary"]);
  try {
    const decision = assertTaskVerificationDecision(
      assertNonEmptyString(body.decision, "decision"),
    );
    const summary = assertOptionalNonEmptyString(body.summary, "summary");
    const result = await verifyTaskResult(
      taskId,
      {
        decision,
        ...(summary !== undefined ? { summary } : {}),
      },
      { store: deps.store },
    );
    return jsonResponse({ task: result.task, inboxItem: result.inboxItem });
  } catch (error) {
    if (error instanceof TaskVerificationError) {
      throw mapTaskVerificationError(error);
    }
    throw error;
  }
}

async function handleGetTaskEvidence(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const taskId = assertEntityId(params.taskId, "taskId");
  const task = await deps.store.getTask(taskId);
  if (task === undefined) {
    throw new ApiError(404, "not_found", `Task not found: ${taskId}`);
  }
  const evidence = await deps.store.listEvidenceByTask(taskId);
  return jsonResponse({ evidence });
}

async function handleGetMasterInbox(request: Request, deps: ApiDependencies): Promise<Response> {
  const url = new URL(request.url);
  const projectId = assertEntityId(url.searchParams.get("projectId"), "projectId");
  await requireProject(deps.store, projectId);
  const items = [...(await deps.store.listMasterInbox(projectId))].sort(
    (a, b) => b.receivedAt.localeCompare(a.receivedAt),
  );
  return jsonResponse({ items });
}

async function handlePostProject(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, [
    "id",
    "name",
    "description",
    "targetRepository",
    "targetRef",
    "targetTestCommand",
    "promotionRepository",
    "promotionRefPrefix",
    "doNotModifyConstraints",
  ]);
  const targetRepository = assertOptionalRepositorySlug(body.targetRepository, "targetRepository");
  const targetRef = assertOptionalNonEmptyString(body.targetRef, "targetRef");
  const targetTestCommand = assertOptionalTrustedTestCommand(body.targetTestCommand, "targetTestCommand");
  const promotionRepository = assertOptionalRepositorySlug(body.promotionRepository, "promotionRepository");
  const promotionRefPrefix = assertOptionalNonEmptyString(body.promotionRefPrefix, "promotionRefPrefix");
  try {
    if (promotionRepository !== undefined) assertPromotionRepositoryAllowed(promotionRepository);
    if (promotionRefPrefix !== undefined) assertPromotionRefPrefixAllowed(promotionRefPrefix);
  } catch (error) {
    if (error instanceof PromotionTargetError) {
      throw new ApiError(400, "validation_error", error.message);
    }
    throw error;
  }
  if (promotionRepository !== undefined && targetRepository !== undefined && promotionRepository !== targetRepository) {
    throw new ApiError(400, "validation_error", "Cross-repository promotion is not supported");
  }
  const doNotModifyConstraints = assertDoNotModifyConstraints(
    body.doNotModifyConstraints,
    "doNotModifyConstraints",
  );
  const project = await deps.store.createProject({
    id: assertEntityId(body.id, "id"),
    name: assertNonEmptyString(body.name, "name"),
    description: assertNonEmptyString(body.description, "description"),
    ...(targetRepository !== undefined ? { targetRepository } : {}),
    ...(targetRef !== undefined ? { targetRef } : {}),
    ...(targetTestCommand !== undefined ? { targetTestCommand } : {}),
    ...(promotionRepository !== undefined ? { promotionRepository } : {}),
    ...(promotionRefPrefix !== undefined ? { promotionRefPrefix } : {}),
    ...(doNotModifyConstraints !== undefined ? { doNotModifyConstraints } : {}),
  });
  return jsonResponse({ project }, 201);
}

async function handlePostProjectTargetConfig(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, [
    "targetRepository",
    "targetRef",
    "targetTestCommand",
    "promotionRepository",
    "promotionRefPrefix",
    "doNotModifyConstraints",
  ]);
  const targetRepository = assertOptionalRepositorySlug(body.targetRepository, "targetRepository");
  const targetRef = assertOptionalNonEmptyString(body.targetRef, "targetRef");
  const targetTestCommand = assertOptionalTrustedTestCommand(body.targetTestCommand, "targetTestCommand");
  const promotionRepository = assertOptionalRepositorySlug(body.promotionRepository, "promotionRepository");
  const promotionRefPrefix = assertOptionalNonEmptyString(body.promotionRefPrefix, "promotionRefPrefix");
  const doNotModifyConstraints = assertDoNotModifyConstraints(body.doNotModifyConstraints, "doNotModifyConstraints");
  try {
    if (promotionRepository !== undefined) assertPromotionRepositoryAllowed(promotionRepository);
    if (promotionRefPrefix !== undefined) assertPromotionRefPrefixAllowed(promotionRefPrefix);
  } catch (error) {
    if (error instanceof PromotionTargetError) {
      throw new ApiError(400, "validation_error", error.message);
    }
    throw error;
  }
  if (
    promotionRepository !== undefined &&
    targetRepository !== undefined &&
    promotionRepository !== targetRepository
  ) {
    throw new ApiError(400, "validation_error", "Cross-repository promotion is not supported");
  }
  const project = await deps.store.updateProjectWorkerTarget({
    projectId,
    ...(targetRepository !== undefined ? { targetRepository } : {}),
    ...(targetRef !== undefined ? { targetRef } : {}),
    ...(targetTestCommand !== undefined ? { targetTestCommand } : {}),
    ...(promotionRepository !== undefined ? { promotionRepository } : {}),
    ...(promotionRefPrefix !== undefined ? { promotionRefPrefix } : {}),
    ...(doNotModifyConstraints !== undefined ? { doNotModifyConstraints } : {}),
  });
  return jsonResponse({ project });
}

async function handlePostRequirement(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["id", "projectId", "title", "description", "priority", "source"]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const priority = assertOptionalNumber(body.priority, "priority");
  const requirement = await deps.store.createRequirement({
    id: assertEntityId(body.id, "id"),
    projectId,
    title: assertNonEmptyString(body.title, "title"),
    description: assertNonEmptyString(body.description, "description"),
    ...(priority !== undefined ? { priority } : {}),
    ...(assertOptionalNonEmptyString(body.source, "source") !== undefined
      ? { source: assertOptionalNonEmptyString(body.source, "source")! }
      : {}),
  });
  return jsonResponse({ requirement }, 201);
}

async function handlePostTask(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["id", "projectId", "title", "description", "kind", "dependencyIds"]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const dependencyIds = assertEntityIdArray(body.dependencyIds, "dependencyIds");
  const task = await deps.store.createTask({
    id: assertEntityId(body.id, "id"),
    projectId,
    title: assertNonEmptyString(body.title, "title"),
    description: assertNonEmptyString(body.description, "description"),
    kind: validators.taskKind(body.kind, "kind"),
    ...(dependencyIds !== undefined ? { dependencyIds } : {}),
  });
  return jsonResponse({ task }, 201);
}

async function handlePostWorkerRun(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["id", "projectId", "taskId", "workerKind", "iteration"]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const taskId = assertEntityId(body.taskId, "taskId");
  const task = await deps.store.getTask(taskId);
  if (task === undefined) {
    throw new ApiError(404, "not_found", `Task not found: ${taskId}`);
  }
  const iteration = assertOptionalNumber(body.iteration, "iteration");
  const workerRun = await deps.store.createWorkerRun({
    id: assertEntityId(body.id, "id"),
    projectId,
    taskId,
    workerKind: validators.workerKind(body.workerKind, "workerKind"),
    ...(iteration !== undefined ? { iteration } : {}),
  });
  return jsonResponse({ workerRun }, 201);
}

async function handlePostWorkerEvent(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["id", "projectId", "taskId", "workerRunId", "eventType", "message", "payload"]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const taskId = assertEntityId(body.taskId, "taskId");
  const workerRunId = assertEntityId(body.workerRunId, "workerRunId");
  const task = await deps.store.getTask(taskId);
  if (task === undefined) {
    throw new ApiError(404, "not_found", `Task not found: ${taskId}`);
  }
  const workerRun = await deps.store.getWorkerRun(workerRunId);
  if (workerRun === undefined) {
    throw new ApiError(404, "not_found", `Worker run not found: ${workerRunId}`);
  }
  const payload = assertOptionalObject(body.payload, "payload");
  const event = await deps.store.appendWorkerEvent({
    id: assertEntityId(body.id, "id"),
    projectId,
    taskId,
    workerRunId,
    eventType: validators.workerEventType(body.eventType, "eventType"),
    message: assertNonEmptyString(body.message, "message"),
    ...(payload !== undefined ? { payload } : {}),
  });
  return jsonResponse({ event }, 201);
}

async function handlePostWorkerReport(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["id", "projectId", "taskId", "workerRunId", "summary", "outcome", "metrics"]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const taskId = assertEntityId(body.taskId, "taskId");
  const workerRunId = assertEntityId(body.workerRunId, "workerRunId");
  const task = await deps.store.getTask(taskId);
  if (task === undefined) {
    throw new ApiError(404, "not_found", `Task not found: ${taskId}`);
  }
  const workerRun = await deps.store.getWorkerRun(workerRunId);
  if (workerRun === undefined) {
    throw new ApiError(404, "not_found", `Worker run not found: ${workerRunId}`);
  }
  const metrics = assertNumberRecord(body.metrics, "metrics");
  try {
    const result = await dispatcherFor(deps).persistWorkerReport({
      id: assertEntityId(body.id, "id"),
      projectId,
      taskId,
      workerRunId,
      summary: assertNonEmptyString(body.summary, "summary"),
      outcome: validators.workerReportOutcome(body.outcome, "outcome") as WorkerReport["outcome"],
      ...(metrics !== undefined ? { metrics } : {}),
    });
    return jsonResponse(
      { report: result.report, inboxItem: result.inboxItem, created: result.created },
      result.created ? 201 : 200,
    );
  } catch (error) {
    if (error instanceof WorkerReportValidationError) {
      if (error.code === "not_found") {
        throw new ApiError(404, "not_found", error.message);
      }
      if (error.code === "conflict") {
        throw new ApiError(409, "conflict", error.message);
      }
      throw new ApiError(400, "validation_error", error.message);
    }
    throw error;
  }
}

async function handleGetTestCase(params: Record<string, string>, deps: ApiDependencies): Promise<Response> {
  const testCaseId = assertEntityId(params.testCaseId, "testCaseId");
  const testCase = await deps.store.getTestCase(testCaseId);
  if (testCase === undefined) {
    throw new ApiError(404, "not_found", `Test case not found: ${testCaseId}`);
  }
  return jsonResponse({ testCase });
}

async function handlePostTestCase(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["id", "projectId", "taskId", "name", "description", "kind", "browserSpecJson"]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const id = assertEntityId(body.id, "id");
  const taskId = assertOptionalEntityId(body.taskId, "taskId");
  if (taskId !== undefined) {
    const task = await deps.store.getTask(taskId);
    if (task === undefined) {
      throw new ApiError(404, "not_found", `Task not found: ${taskId}`);
    }
    if (task.projectId !== projectId) {
      throw new ApiError(400, "validation_error", "taskId does not belong to projectId");
    }
  }
  const name = assertNonEmptyString(body.name, "name");
  const description = assertNonEmptyString(body.description, "description");
  const kind = validators.testCaseKind(body.kind, "kind");
  const browserSpecJson = assertOptionalNonEmptyString(body.browserSpecJson, "browserSpecJson");
  if (browserSpecJson !== undefined) {
    if (kind !== "browser") {
      throw new ApiError(400, "validation_error", "browserSpecJson is only valid for browser test cases");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(browserSpecJson); } catch {
      throw new ApiError(400, "invalid_browser_spec", "browserSpecJson must be valid JSON");
    }
    try { parseBrowserTestSpec(parsed); } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid browser test specification";
      throw new ApiError(400, "invalid_browser_spec", message);
    }
  }
  const existing = await deps.store.getTestCase(id);
  if (existing !== undefined) {
    const sameProject = existing.projectId === projectId;
    const sameTask = (existing.taskId ?? undefined) === taskId;
    const sameFields =
      sameProject &&
      sameTask &&
      existing.name === name &&
      existing.description === description &&
      existing.kind === kind &&
      existing.browserSpecJson === browserSpecJson;
    if (sameFields) {
      return jsonResponse({ testCase: existing }, 200);
    }
    throw new ApiError(409, "conflict", `Test case already exists: ${id}`);
  }
  const testCase = await deps.store.createTestCase({
    id,
    projectId,
    name,
    description,
    kind,
    ...(browserSpecJson !== undefined ? { browserSpecJson } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  });
  return jsonResponse({ testCase }, 201);
}

async function handlePostTestResult(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, [
    "id",
    "projectId",
    "testCaseId",
    "outcome",
    "taskId",
    "workerRunId",
    "verifierRunId",
    "message",
    "durationMs",
  ]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const testCaseId = assertEntityId(body.testCaseId, "testCaseId");
  const testCase = await deps.store.getTestCase(testCaseId);
  if (testCase === undefined) {
    throw new ApiError(404, "not_found", `Test case not found: ${testCaseId}`);
  }
  const taskId = assertOptionalEntityId(body.taskId, "taskId");
  const workerRunId = assertOptionalEntityId(body.workerRunId, "workerRunId");
  const verifierRunId = assertOptionalEntityId(body.verifierRunId, "verifierRunId");
  const message = assertOptionalNonEmptyString(body.message, "message");
  const durationMs = assertOptionalNumber(body.durationMs, "durationMs");
  const result = await deps.store.recordTestResult({
    id: assertEntityId(body.id, "id"),
    projectId,
    testCaseId,
    outcome: validators.verificationOutcome(body.outcome, "outcome"),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(workerRunId !== undefined ? { workerRunId } : {}),
    ...(verifierRunId !== undefined ? { verifierRunId } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  return jsonResponse({ result }, 201);
}

async function handlePostEvidence(
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const body = await readJsonBody(request, MAX_EVIDENCE_JSON_BODY_BYTES);
  rejectUnknownKeys(body, [
    "id",
    "projectId",
    "kind",
    "label",
    "taskId",
    "workerRunId",
    "verifierRunId",
    "gitRevisionId",
    "deploymentId",
    "uri",
    "mimeType",
    "metadata",
    "blobBase64",
  ]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const id = assertEntityId(body.id, "id");
  const taskId = assertOptionalEntityId(body.taskId, "taskId");
  const workerRunId = assertOptionalEntityId(body.workerRunId, "workerRunId");
  const verifierRunId = assertOptionalEntityId(body.verifierRunId, "verifierRunId");
  const gitRevisionId = assertOptionalEntityId(body.gitRevisionId, "gitRevisionId");
  const deploymentId = assertOptionalEntityId(body.deploymentId, "deploymentId");
  const uri = assertOptionalNonEmptyString(body.uri, "uri");
  const mimeType = assertOptionalNonEmptyString(body.mimeType, "mimeType");
  const metadata = assertOptionalObject(body.metadata, "metadata");
  const blobBase64 = assertOptionalNonEmptyString(body.blobBase64, "blobBase64");
  const kind = validators.evidenceKind(body.kind, "kind");
  const label = assertNonEmptyString(body.label, "label");

  let contentRef: string | undefined;
  let blobKey: string | undefined;
  if (blobBase64 !== undefined) {
    const bytes = decodeBootstrapBase64(blobBase64, MAX_BOOTSTRAP_BLOB_BYTES);
    blobKey = evidenceBlobKey(projectId, id);
    const ref = await deps.blobs.put(blobKey, bytes, mimeType);
    contentRef = ref.key;
  }

  try {
    const evidence = await deps.store.createEvidence({
      id,
      projectId,
      kind,
      label,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(workerRunId !== undefined ? { workerRunId } : {}),
      ...(verifierRunId !== undefined ? { verifierRunId } : {}),
      ...(gitRevisionId !== undefined ? { gitRevisionId } : {}),
      ...(deploymentId !== undefined ? { deploymentId } : {}),
      ...(uri !== undefined ? { uri } : {}),
      ...(contentRef !== undefined ? { contentRef } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
    return jsonResponse({ evidence }, 201);
  } catch (error) {
    if (blobKey !== undefined) {
      try {
        await deps.blobs.delete(blobKey);
      } catch {
        // Best-effort cleanup; do not expose details to client.
      }
    }
    throw error;
  }
}

async function handlePostVerifierRun(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["id", "projectId", "taskId", "codeCandidateId", "outcome", "summary", "evidenceIds"]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const taskId = assertEntityId(body.taskId, "taskId");
  const id = assertEntityId(body.id, "id");
  const codeCandidateId = assertOptionalEntityId(body.codeCandidateId, "codeCandidateId");
  if (codeCandidateId !== undefined) {
    const candidate = await deps.store.getCodeCandidate(codeCandidateId);
    if (candidate === undefined || candidate.projectId !== projectId) {
      throw new ApiError(404, "not_found", `Code candidate not found: ${codeCandidateId}`);
    }
  }
  const task = await deps.store.getTask(taskId);
  if (task === undefined) {
    throw new ApiError(404, "not_found", `Task not found: ${taskId}`);
  }

  const outcome = body.outcome;
  if (outcome !== undefined && outcome !== null) {
    const existing = await deps.store.getVerifierRun(id);
    if (existing === undefined) {
      throw new ApiError(404, "not_found", `Verifier run not found: ${id}`);
    }
    const summary = assertOptionalNonEmptyString(body.summary, "summary");
    const evidenceIds = assertEntityIdArray(body.evidenceIds, "evidenceIds");
    const verifierRun = await deps.store.completeVerifierRun({
      verifierRunId: id,
      outcome: validators.verificationOutcome(outcome, "outcome"),
      ...(summary !== undefined ? { summary } : {}),
      ...(evidenceIds !== undefined ? { evidenceIds } : {}),
    });
    return jsonResponse({ verifierRun }, 201);
  }

  const verifierRun = await deps.store.createVerifierRun({ id, projectId, taskId, ...(codeCandidateId !== undefined ? { codeCandidateId } : {}) });
  return jsonResponse({ verifierRun }, 201);
}

async function handlePostMasterInbox(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["id", "projectId", "kind", "subject", "body", "relatedEntityId"]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const relatedEntityId = assertOptionalEntityId(body.relatedEntityId, "relatedEntityId");
  const item = await deps.store.enqueueMasterInboxItem({
    id: assertEntityId(body.id, "id"),
    projectId,
    kind: validators.masterInboxKind(body.kind, "kind"),
    subject: assertNonEmptyString(body.subject, "subject"),
    body: assertNonEmptyString(body.body, "body"),
    ...(relatedEntityId !== undefined ? { relatedEntityId } : {}),
  });
  return jsonResponse({ item }, 201);
}

async function handlePostMasterRun(
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  if (deps.masterOrchestrator === undefined) {
    throw new ApiError(503, "master_misconfigured", "Master orchestrator is not configured");
  }
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["projectId", "trigger", "context"]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const trigger = assertOptionalNonEmptyString(body.trigger, "trigger");
  const context = assertOptionalNonEmptyString(body.context, "context");
  try {
    const run = await deps.masterOrchestrator.run({
      projectId,
      ...(trigger !== undefined ? { trigger } : {}),
      ...(context !== undefined ? { context } : {}),
    });
    return jsonResponse({ run }, 201);
  } catch (error) {
    if (error instanceof MasterModelConfigError) {
      throw new ApiError(503, "openai_misconfigured", "OpenAI master client is not configured");
    }
    throw error;
  }
}

async function handleGetMasterRuns(request: Request, deps: ApiDependencies): Promise<Response> {
  const url = new URL(request.url);
  const projectId = assertEntityId(url.searchParams.get("projectId"), "projectId");
  await requireProject(deps.store, projectId);
  const runs = await deps.store.listMasterRunsByProject(projectId);
  return jsonResponse({ runs });
}

async function handleGetMasterRun(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const runId = assertEntityId(params.runId, "runId");
  const run = await deps.store.getMasterRun(runId);
  if (run === undefined) {
    throw new ApiError(404, "not_found", `Master run not found: ${runId}`);
  }
  return jsonResponse({ run });
}

async function handlePostReleaseContract(
  request: Request,
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, [
    "id",
    "version",
    "requiredEvidenceKinds",
    "requiredEvidenceLabels",
    "notes",
    "acceptanceCriteria",
  ]);
  const version = assertOptionalNumber(body.version, "version") ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new ApiError(400, "validation_error", "Invalid version", [
      { field: "version", message: "Must be a positive integer" },
    ]);
  }
  const requiredEvidenceKinds = assertStringArray(body.requiredEvidenceKinds, "requiredEvidenceKinds").map(
    (kind, index) => validators.evidenceKind(kind, `requiredEvidenceKinds[${index}]`),
  );
  const labelsRaw = body.requiredEvidenceLabels;
  const requiredEvidenceLabels =
    labelsRaw === undefined || labelsRaw === null
      ? undefined
      : assertStringArray(labelsRaw, "requiredEvidenceLabels");
  const notes = assertOptionalNonEmptyString(body.notes, "notes");

  const contract = await deps.store.createReleaseContract({
    id: assertEntityId(body.id, "id"),
    projectId,
    version,
    requiredEvidenceKinds,
    ...(requiredEvidenceLabels !== undefined ? { requiredEvidenceLabels } : {}),
    ...(notes !== undefined ? { notes } : {}),
  });

  const criteriaInput = body.acceptanceCriteria;
  if (criteriaInput !== undefined && criteriaInput !== null) {
    if (!Array.isArray(criteriaInput)) {
      throw new ApiError(400, "validation_error", "Invalid acceptanceCriteria", [
        { field: "acceptanceCriteria", message: "Must be an array" },
      ]);
    }
    for (const [index, raw] of criteriaInput.entries()) {
      const item = assertObject(raw, `acceptanceCriteria[${index}]`);
      rejectUnknownKeys(item, ["id", "description", "requirementIds", "applicable"]);
      const applicable = assertOptionalBoolean(item.applicable, `acceptanceCriteria[${index}].applicable`);
      const requirementIds = assertEntityIdArray(
        item.requirementIds,
        `acceptanceCriteria[${index}].requirementIds`,
      );
      await deps.store.createAcceptanceCriterion({
        id: assertEntityId(item.id, `acceptanceCriteria[${index}].id`),
        projectId,
        releaseContractId: contract.id,
        description: assertNonEmptyString(item.description, `acceptanceCriteria[${index}].description`),
        ...(requirementIds !== undefined ? { requirementIds } : {}),
        ...(applicable !== undefined ? { applicable } : {}),
      });
    }
  }

  const acceptanceCriteria = (await deps.store.listAcceptanceCriteriaByProject(projectId)).filter(
    (c) => c.releaseContractId === contract.id,
  );
  const blockers = await deps.store.listBlockersByProject(projectId);
  return jsonResponse({ contract, acceptanceCriteria, blockers }, 201);
}

async function handleGetReleaseContract(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const contract = await deps.store.getLatestReleaseContract(projectId);
  if (contract === undefined) {
    throw new ApiError(404, "not_found", `Release contract not found for project: ${projectId}`);
  }
  const acceptanceCriteria = (await deps.store.listAcceptanceCriteriaByProject(projectId)).filter(
    (c) => c.releaseContractId === contract.id,
  );
  const blockers = await deps.store.listBlockersByProject(projectId);
  return jsonResponse({ contract, acceptanceCriteria, blockers });
}

async function handlePostProjectBudget(
  request: Request,
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["resourceType", "hardLimit", "softLimit", "unit"]);
  const resourceType = validators.budgetCategory(body.resourceType, "resourceType");
  const unit = assertNonEmptyString(body.unit, "unit");
  if (unit !== expectedBudgetUnit(resourceType)) {
    throw new ApiError(400, "validation_error", "Invalid unit", [
      { field: "unit", message: `Must be ${expectedBudgetUnit(resourceType)} for ${resourceType}` },
    ]);
  }
  const hardLimit = assertFiniteNumber(body.hardLimit, "hardLimit");
  if (hardLimit <= 0) {
    throw new ApiError(400, "validation_error", "Invalid hardLimit", [
      { field: "hardLimit", message: "Must be greater than 0" },
    ]);
  }
  const softLimit = assertOptionalNumber(body.softLimit, "softLimit");
  if (softLimit !== undefined && (softLimit < 0 || softLimit > hardLimit)) {
    throw new ApiError(400, "validation_error", "Invalid softLimit", [
      { field: "softLimit", message: "Must be >= 0 and <= hardLimit" },
    ]);
  }

  try {
    const ledger = await deps.store.addBudgetResource({
      projectId,
      resourceType,
      hardLimit,
      unit,
      ...(softLimit !== undefined ? { softLimit } : {}),
    });
    const budget = toBudgetResourceView(ledger, resourceType);
    return jsonResponse({ budget }, 201);
  } catch (error) {
    if (error instanceof BudgetResourceConflictError) {
      throw new ApiError(409, "conflict", "Budget already exists for this resource type");
    }
    throw error;
  }
}

async function handleGetProjectBudgets(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const ledger = await deps.store.getBudgetLedger(projectId);
  const budgets = ledger === undefined ? [] : listBudgetResourceViews(ledger);
  return jsonResponse({ budgets });
}

async function handleGetProjectBudget(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  const budgetId = assertEntityId(params.budgetId, "budgetId");
  await requireProject(deps.store, projectId);
  const ledger = await deps.store.getBudgetLedger(projectId);
  if (ledger === undefined) {
    throw new ApiError(404, "not_found", `Budget not found: ${budgetId}`);
  }
  let resourceType: ReturnType<typeof validators.budgetCategory>;
  try {
    resourceType = validators.budgetCategory(budgetId, "budgetId");
  } catch {
    throw new ApiError(404, "not_found", `Budget not found: ${budgetId}`);
  }
  const budget = toBudgetResourceView(ledger, resourceType);
  if (budget === undefined) {
    throw new ApiError(404, "not_found", `Budget not found: ${budgetId}`);
  }
  return jsonResponse({ budget });
}

async function handlePostIncreaseProjectBudget(
  request: Request,
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  const budgetId = assertEntityId(params.budgetId, "budgetId");
  await requireProject(deps.store, projectId);
  let resourceType: ReturnType<typeof validators.budgetCategory>;
  try {
    resourceType = validators.budgetCategory(budgetId, "budgetId");
  } catch {
    throw new ApiError(404, "not_found", `Budget not found: ${budgetId}`);
  }
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["additionalAmount"]);
  const additionalAmount = assertFiniteNumber(body.additionalAmount, "additionalAmount");
  if (additionalAmount <= 0) {
    throw new ApiError(400, "validation_error", "Invalid additionalAmount", [
      { field: "additionalAmount", message: "Must be greater than 0" },
    ]);
  }
  const ledger = await deps.store.getBudgetLedger(projectId);
  if (ledger === undefined || toBudgetResourceView(ledger, resourceType) === undefined) {
    throw new ApiError(404, "not_found", `Budget not found: ${budgetId}`);
  }
  const updated = await deps.store.increaseBudgetResource({ projectId, resourceType, additionalAmount });
  return jsonResponse({ budget: toBudgetResourceView(updated, resourceType) });
}

async function handlePostBudgetEntry(
  request: Request,
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["id", "resourceType", "amount", "unit", "taskId", "workerRunId", "description"]);
  const id = assertEntityId(body.id, "id");
  const resourceType = validators.budgetCategory(body.resourceType, "resourceType");
  const unit = assertNonEmptyString(body.unit, "unit");
  if (unit !== expectedBudgetUnit(resourceType)) {
    throw new ApiError(400, "validation_error", "Invalid unit", [
      { field: "unit", message: `Must be ${expectedBudgetUnit(resourceType)} for ${resourceType}` },
    ]);
  }
  const amount = assertFiniteNumber(body.amount, "amount");
  if (amount < 0) {
    throw new ApiError(400, "validation_error", "Invalid amount", [
      { field: "amount", message: "Must be greater than or equal to 0" },
    ]);
  }
  const taskId = assertOptionalEntityId(body.taskId, "taskId");
  const workerRunId = assertOptionalEntityId(body.workerRunId, "workerRunId");
  const description = assertOptionalNonEmptyString(body.description, "description");

  if (taskId !== undefined) {
    const task = await deps.store.getTask(taskId);
    if (task === undefined || task.projectId !== projectId) {
      throw new ApiError(400, "validation_error", "taskId does not belong to project");
    }
  }
  if (workerRunId !== undefined) {
    const run = await deps.store.getWorkerRun(workerRunId);
    if (run === undefined || run.projectId !== projectId) {
      throw new ApiError(400, "validation_error", "workerRunId does not belong to project");
    }
  }

  const ledger = await deps.store.getBudgetLedger(projectId);
  if (ledger === undefined || toBudgetResourceView(ledger, resourceType) === undefined) {
    throw new ApiError(409, "budget_unavailable", `Budget is not configured for ${resourceType}`);
  }
  const existing = ledger.entries.find((entry) => entry.id === id);
  if (existing !== undefined) {
    const same =
      existing.category === resourceType &&
      existing.amount === amount &&
      existing.unit === unit &&
      existing.taskId === taskId &&
      existing.workerRunId === workerRunId;
    if (!same) {
      throw new ApiError(409, "conflict", `Budget entry already exists: ${id}`);
    }
    return jsonResponse({ entry: existing, created: false });
  }

  const entry = await deps.store.recordBudgetEntry({
    id,
    projectId,
    category: resourceType,
    amount,
    unit,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(workerRunId !== undefined ? { workerRunId } : {}),
    ...(description !== undefined ? { description } : {}),
  });
  return jsonResponse({ entry, created: true }, 201);
}

async function handlePostProjectDispatch(
  request: Request,
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["maxAssignments", "launchWorkers"]);
  const maxAssignments = assertOptionalInteger(body.maxAssignments, "maxAssignments");
  const launchWorkers = assertOptionalBoolean(body.launchWorkers, "launchWorkers");
  try {
    if (maxAssignments !== undefined) {
      normalizeMaxAssignments(maxAssignments);
    }
    const result = await dispatcherFor(deps).dispatch(projectId, {
      ...(maxAssignments !== undefined ? { maxAssignments } : {}),
      ...(launchWorkers !== undefined ? { launchWorkers } : {}),
    });
    return jsonResponse({
      assignments: result.assignments,
      launches: result.launches,
      ...(result.budgetBlocked !== undefined ? { budgetBlocked: result.budgetBlocked } : {}),
    });
  } catch (error) {
    if (error instanceof DispatchValidationError) {
      throw new ApiError(400, "validation_error", `Invalid ${error.field}`, [
        { field: error.field, message: error.message },
      ]);
    }
    throw error;
  }
}

async function handleGetProjectWorkerRuns(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const workerRuns = await deps.store.listWorkerRunsByProject(projectId);
  return jsonResponse({ workerRuns });
}

async function handleGetWorkerRun(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const workerRunId = assertEntityId(params.workerRunId, "workerRunId");
  const workerRun = await deps.store.getWorkerRun(workerRunId);
  if (workerRun === undefined) {
    throw new ApiError(404, "not_found", `Worker run not found: ${workerRunId}`);
  }
  return jsonResponse({ workerRun });
}

async function handleGetWorkerRunTaskPacket(
  request: Request,
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const workerRunId = assertEntityId(params.workerRunId, "workerRunId");
  const leaseToken = assertLeaseToken(new URL(request.url).searchParams.get("leaseToken"), "leaseToken");
  const workerRun = await deps.store.getWorkerRun(workerRunId);
  if (workerRun === undefined) {
    throw new ApiError(404, "not_found", `Worker run not found: ${workerRunId}`);
  }
  const verification = await deps.store.verifyWorkerRunLease(
    workerRunId,
    await hashLeaseToken(leaseToken),
    nowIso(),
  );
  if (!verification.ok) {
    if (verification.reason === "not_found") {
      throw new ApiError(404, "not_found", `Worker run not found: ${workerRunId}`);
    }
    throw new ApiError(403, "forbidden", "Lease token is not valid for this worker run");
  }
  try {
    const packet = await buildWorkerTaskPacket(deps.store, workerRun);
    return jsonResponse({ packet });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build worker task packet";
    throw new ApiError(409, "conflict", message);
  }
}

async function handlePostWorkerRunClaim(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const workerRunId = assertEntityId(params.workerRunId, "workerRunId");
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["ownerId"]);
  try {
    const result = await lifecycleFor(deps).claim(workerRunId, {
      ownerId: assertEntityId(body.ownerId, "ownerId"),
    });
    return jsonResponse({
      workerRun: result.workerRun,
      task: result.task,
      event: result.event,
      claimed: result.claimed,
      leaseToken: result.leaseToken,
    });
  } catch (error) {
    if (error instanceof WorkerRunLifecycleError) {
      throw mapLifecycleError(error);
    }
    throw error;
  }
}

async function handlePostWorkerRunHeartbeat(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const workerRunId = assertEntityId(params.workerRunId, "workerRunId");
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["leaseToken"]);
  try {
    const result = await lifecycleFor(deps).heartbeat(workerRunId, {
      leaseToken: assertLeaseToken(body.leaseToken),
    });
    return jsonResponse({ workerRun: result.workerRun });
  } catch (error) {
    if (error instanceof WorkerRunLifecycleError) {
      throw mapLifecycleError(error);
    }
    throw error;
  }
}

async function handlePostWorkerRunSucceed(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const workerRunId = assertEntityId(params.workerRunId, "workerRunId");
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["summary", "structuredOutcome", "leaseToken"]);
  const structuredOutcome = assertStructuredOutcome(body.structuredOutcome, "structuredOutcome");
  try {
    const result = await lifecycleFor(deps).succeed(workerRunId, {
      summary: assertNonEmptyString(body.summary, "summary"),
      leaseToken: assertLeaseToken(body.leaseToken),
      ...(structuredOutcome !== undefined ? { structuredOutcome } : {}),
    });
    return jsonResponse({
      workerRun: result.workerRun,
      task: result.task,
      event: result.event,
      report: result.report,
      inboxItem: result.inboxItem,
      applied: result.applied,
    });
  } catch (error) {
    if (error instanceof WorkerRunLifecycleError) {
      throw mapLifecycleError(error);
    }
    throw error;
  }
}

async function handlePostWorkerRunFail(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const workerRunId = assertEntityId(params.workerRunId, "workerRunId");
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["errorCode", "summary", "leaseToken"]);
  try {
    const result = await lifecycleFor(deps).fail(workerRunId, {
      errorCode: assertNonEmptyString(body.errorCode, "errorCode"),
      summary: assertNonEmptyString(body.summary, "summary"),
      leaseToken: assertLeaseToken(body.leaseToken),
    });
    return jsonResponse({
      workerRun: result.workerRun,
      task: result.task,
      event: result.event,
      report: result.report,
      inboxItem: result.inboxItem,
      applied: result.applied,
    });
  } catch (error) {
    if (error instanceof WorkerRunLifecycleError) {
      throw mapLifecycleError(error);
    }
    throw error;
  }
}

async function handlePostWorkerRunCancel(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const workerRunId = assertEntityId(params.workerRunId, "workerRunId");
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["reason", "leaseToken"]);
  try {
    const result = await lifecycleFor(deps).cancel(workerRunId, {
      reason: assertNonEmptyString(body.reason, "reason"),
      ...(body.leaseToken !== undefined ? { leaseToken: assertLeaseToken(body.leaseToken) } : {}),
    });
    return jsonResponse({
      workerRun: result.workerRun,
      task: result.task,
      event: result.event,
      applied: result.applied,
    });
  } catch (error) {
    if (error instanceof WorkerRunLifecycleError) {
      throw mapLifecycleError(error);
    }
    throw error;
  }
}

async function handlePostRecoverExpiredRuns(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, []);
  try {
    const result = await lifecycleFor(deps).recoverExpiredRuns(projectId);
    return jsonResponse({ recovered: result.recovered });
  } catch (error) {
    if (error instanceof WorkerRunLifecycleError) {
      throw mapLifecycleError(error);
    }
    throw error;
  }
}

async function handlePostProjectAudit(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, []);
  const result = await runProjectAudit(deps.store, projectId, { now: nowIso() });
  const lifecycles = await reconstructProjectTaskLifecycles(deps.store, projectId);
  const activeFindings = result.findings.filter((finding) => finding.status === "active");
  return jsonResponse({
    projectId,
    evaluatedAt: result.evaluatedAt,
    activeCount: result.activeCount,
    resolvedCount: result.resolvedCount,
    findings: activeFindings,
    lifecycles,
  });
}

async function handleGetProjectAuditFindings(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? "active";
  const status: AuditFindingStatus | "all" =
    statusParam === "active" || statusParam === "resolved" || statusParam === "all"
      ? statusParam
      : (() => {
          throw new ApiError(400, "invalid_status", `Invalid audit finding status: ${statusParam}`);
        })();
  const findings = await deps.store.listAuditFindingsByProject(projectId, { status });
  return jsonResponse({ projectId, status, findings });
}

async function handlePostCodeCandidate(request: Request, deps: ApiDependencies): Promise<Response> {
  const body = await readJsonBody(request, MAX_EVIDENCE_JSON_BODY_BYTES);
  rejectUnknownKeys(body, [
    "id",
    "projectId",
    "taskId",
    "workerRunId",
    "sourceRepository",
    "sourceRef",
    "parentCandidateId",
    "baseCommitSha",
    "changedFiles",
    "patchChecksumSha256",
    "patchBase64",
    "testCommand",
    "testExitCode",
  ]);
  const projectId = assertEntityId(body.projectId, "projectId");
  const project = await requireProject(deps.store, projectId);
  const id = assertEntityId(body.id, "id");
  const taskId = assertEntityId(body.taskId, "taskId");
  const workerRunId = assertEntityId(body.workerRunId, "workerRunId");
  const workerRun = await deps.store.getWorkerRun(workerRunId);
  if (workerRun === undefined || workerRun.taskId !== taskId || workerRun.projectId !== projectId) {
    throw new ApiError(404, "not_found", `Worker run not found: ${workerRunId}`);
  }
  const expectedCandidateId = codeCandidateIdForWorkerRun(taskId, workerRunId);
  if (id !== expectedCandidateId) {
    throw new ApiError(400, "invalid_candidate_id", `Candidate id must be ${expectedCandidateId}`);
  }
  const sourceRepository = assertNonEmptyString(body.sourceRepository, "sourceRepository");
  assertOptionalRepositorySlug(sourceRepository, "sourceRepository");
  if (project.targetRepository !== undefined && sourceRepository !== project.targetRepository) {
    throw new ApiError(409, "target_mismatch", "Candidate repository does not match project target");
  }
  const sourceRef = assertOptionalNonEmptyString(body.sourceRef, "sourceRef");
  const parentCandidateId = assertOptionalEntityId(body.parentCandidateId, "parentCandidateId");
  if (project.targetRef !== undefined && sourceRef !== project.targetRef) {
    throw new ApiError(409, "target_mismatch", "Candidate source ref does not match project target ref");
  }
  if (parentCandidateId !== undefined) {
    const parent = await deps.store.getCodeCandidate(parentCandidateId);
    if (parent === undefined || parent.projectId !== projectId || parent.sourceRepository !== sourceRepository) {
      throw new ApiError(409, "invalid_parent_candidate", "Parent candidate is missing or incompatible");
    }
  }
  const baseCommitSha = assertNonEmptyString(body.baseCommitSha, "baseCommitSha");
  if (!/^[0-9a-f]{40,64}$/i.test(baseCommitSha)) {
    throw new ApiError(400, "invalid_field", "baseCommitSha must be a full git commit SHA");
  }
  const changedFilesRaw = body.changedFiles;
  if (!Array.isArray(changedFilesRaw) || !changedFilesRaw.every((entry) => typeof entry === "string")) {
    throw new ApiError(400, "invalid_field", "changedFiles must be a string array");
  }
  const changedFiles = changedFilesRaw as string[];
  if (changedFiles.length === 0 || changedFiles.some((path) => path.length === 0 || path.startsWith("/") || path.includes(".."))) {
    throw new ApiError(400, "invalid_field", "changedFiles must contain safe relative paths");
  }
  const patchChecksumSha256 = assertNonEmptyString(body.patchChecksumSha256, "patchChecksumSha256");
  if (!/^[0-9a-f]{64}$/i.test(patchChecksumSha256)) {
    throw new ApiError(400, "invalid_field", "patchChecksumSha256 must be a SHA-256 hex digest");
  }
  const patchBase64 = assertNonEmptyString(body.patchBase64, "patchBase64");
  const testCommand = assertNonEmptyString(body.testCommand, "testCommand");
  const testExitCode = assertOptionalNumber(body.testExitCode, "testExitCode");
  if (testExitCode === undefined || testExitCode !== 0) {
    throw new ApiError(400, "invalid_field", "testExitCode must be 0 for candidate creation");
  }

  const patchBytes = decodeBootstrapBase64(patchBase64, MAX_BOOTSTRAP_BLOB_BYTES);
  const patchText = new TextDecoder().decode(patchBytes);
  if (patchText.length === 0) {
    throw new ApiError(400, "invalid_field", "Candidate patch must not be empty");
  }
  if (!verifyPatchChecksum(patchText, patchChecksumSha256)) {
    throw new ApiError(400, "checksum_mismatch", "Patch checksum does not match content");
  }

  const existing =
    (await deps.store.getCodeCandidate(id)) ??
    (await deps.store.getCodeCandidateByWorkerRun(taskId, workerRunId));
  if (existing !== undefined) {
    const same =
      existing.id === id &&
      existing.projectId === projectId &&
      existing.taskId === taskId &&
      existing.workerRunId === workerRunId &&
      existing.sourceRepository === sourceRepository &&
      existing.sourceRef === sourceRef &&
      existing.parentCandidateId === parentCandidateId &&
      existing.baseCommitSha === baseCommitSha &&
      existing.patchChecksumSha256 === patchChecksumSha256 &&
      existing.testCommand === testCommand &&
      existing.testExitCode === testExitCode &&
      JSON.stringify(existing.changedFiles) === JSON.stringify(changedFiles);
    if (!same) {
      throw new ApiError(409, "candidate_conflict", "Code candidate already exists with different immutable metadata");
    }
    const existingPatch = await deps.blobs.get(existing.patchContentRef);
    if (existingPatch === null || !verifyPatchChecksum(new TextDecoder().decode(existingPatch), existing.patchChecksumSha256)) {
      throw new ApiError(409, "candidate_integrity_error", "Existing candidate artifact is missing or invalid");
    }
    return jsonResponse({ candidate: existing }, 200);
  }

  const blobKey = candidateBlobKey(projectId, id);
  const ref = await deps.blobs.put(blobKey, patchBytes, "text/x-patch");
  try {
    const candidate = await deps.store.createCodeCandidate({
      id,
      projectId,
      taskId,
      workerRunId,
      sourceRepository,
      ...(sourceRef !== undefined ? { sourceRef } : {}),
      ...(parentCandidateId !== undefined ? { parentCandidateId } : {}),
      baseCommitSha,
      changedFiles,
      patchChecksumSha256,
      patchContentRef: ref.key,
      testCommand,
      testExitCode,
    });
    return jsonResponse({ candidate }, 201);
  } catch (error) {
    try {
      await deps.blobs.delete(blobKey);
    } catch {
      // best effort
    }
    throw error;
  }
}

async function handleGetCodeCandidatePatch(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const candidateId = assertEntityId(params.candidateId, "candidateId");
  const candidate = await deps.store.getCodeCandidate(candidateId);
  if (candidate === undefined) {
    throw new ApiError(404, "not_found", `Code candidate not found: ${candidateId}`);
  }
  const patch = await deps.blobs.get(candidate.patchContentRef);
  if (patch === null) {
    throw new ApiError(404, "not_found", "Candidate patch blob not found");
  }
  return new Response(patch, {
    status: 200,
    headers: {
      "content-type": "text/x-patch; charset=utf-8",
      "x-patch-checksum-sha256": candidate.patchChecksumSha256,
    },
  });
}

async function handlePostPromotionRunComplete(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const promotionRunId = assertEntityId(params.promotionRunId, "promotionRunId");
  const promotionRun = await deps.store.getPromotionRun(promotionRunId);
  if (promotionRun === undefined) {
    throw new ApiError(404, "not_found", `Promotion run not found: ${promotionRunId}`);
  }
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["status", "resultingCommitSha", "errorMessage"]);
  const status = assertNonEmptyString(body.status, "status");
  if (status !== "succeeded" && status !== "failed") {
    throw new ApiError(400, "invalid_status", "status must be succeeded or failed");
  }
  const resultingCommitSha = assertOptionalNonEmptyString(body.resultingCommitSha, "resultingCommitSha");
  const errorMessage = assertOptionalNonEmptyString(body.errorMessage, "errorMessage");
  if (status === "succeeded" && resultingCommitSha === undefined) {
    throw new ApiError(400, "invalid_field", "resultingCommitSha is required when status is succeeded");
  }
  if (promotionRun.status === "succeeded") {
    if (status === "succeeded" && resultingCommitSha === promotionRun.resultingCommitSha) {
      return jsonResponse({ promotionRun });
    }
    throw new ApiError(409, "promotion_already_completed", "Promotion run already succeeded with a different result");
  }

  const completed = await deps.store.completePromotionRun({
    promotionRunId,
    status,
    ...(resultingCommitSha !== undefined ? { resultingCommitSha } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  });
  if (status === "succeeded" && resultingCommitSha !== undefined) {
    await deps.store.completeCodeCandidatePromotion({
      codeCandidateId: promotionRun.codeCandidateId,
      promotionRunId,
      resultingCommitSha,
    });
  }
  return jsonResponse({ promotionRun: completed });
}

async function handleGetCodeCandidate(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const candidateId = assertEntityId(params.candidateId, "candidateId");
  const candidate = await deps.store.getCodeCandidate(candidateId);
  if (candidate === undefined) {
    throw new ApiError(404, "not_found", `Code candidate not found: ${candidateId}`);
  }
  return jsonResponse({ candidate });
}

async function handleGetPromotionRun(
  params: Record<string, string>,
  deps: ApiDependencies,
): Promise<Response> {
  const promotionRunId = assertEntityId(params.promotionRunId, "promotionRunId");
  const promotionRun = await deps.store.getPromotionRun(promotionRunId);
  if (promotionRun === undefined) {
    throw new ApiError(404, "not_found", `Promotion run not found: ${promotionRunId}`);
  }
  return jsonResponse({ promotionRun });
}

function orchestratorFor(deps: ApiDependencies): AutoDevOrchestrator {
  if (deps.autoDevOrchestrator === undefined) {
    throw new ApiError(503, "orchestrator_misconfigured", "AutoDev orchestrator is not configured");
  }
  return deps.autoDevOrchestrator;
}

async function handlePostProjectOrchestrate(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const projectId = assertEntityId(params.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, ["runMasterReevaluation", "runAudit", "haltOnCriticalAudit"]);
  const result = await orchestratorFor(deps).runCycle(projectId, {
    now: nowIso(),
    runMasterReevaluation: body.runMasterReevaluation !== false,
    runAudit: body.runAudit !== false,
    haltOnCriticalAudit: body.haltOnCriticalAudit === true,
  });
  return jsonResponse(result);
}

async function handlePostWorkerRunRetry(
  params: Record<string, string>,
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const workerRunId = assertEntityId(params.workerRunId, "workerRunId");
  const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  rejectUnknownKeys(body, []);
  try {
    const result = await lifecycleFor(deps).retry(workerRunId);
    return jsonResponse({
      previousWorkerRun: result.previousWorkerRun,
      workerRun: result.workerRun,
      task: result.task,
      event: result.event,
    });
  } catch (error) {
    if (error instanceof WorkerRunLifecycleError) {
      throw mapLifecycleError(error);
    }
    throw error;
  }
}

const routes: readonly {
  method: string;
  pattern: string;
  policy: RoutePolicy;
  handler: RouteHandler;
}[] = [
  { method: "GET", pattern: "/health", policy: PUBLIC_ROUTE_POLICY, handler: () => handleGetHealth() },
  {
    method: "GET",
    pattern: "/api/projects/:projectId/state",
    policy: READ_POLICY,
    handler: (_request, params, deps) => handleGetProjectState(params, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:projectId/tasks",
    policy: READ_POLICY,
    handler: (_request, params, deps) => handleGetProjectTasks(params, deps),
  },
  {
    method: "GET",
    pattern: "/api/tasks/:taskId",
    policy: READ_POLICY,
    handler: (_request, params, deps) => handleGetTask(params, deps),
  },
  {
    method: "GET",
    pattern: "/api/tasks/:taskId/evidence",
    policy: READ_POLICY,
    handler: (_request, params, deps) => handleGetTaskEvidence(params, deps),
  },
  {
    method: "POST",
    pattern: "/api/tasks/:taskId/verify",
    policy: MASTER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostTaskVerify(params, request, deps),
  },
  {
    method: "GET",
    pattern: "/api/master/inbox",
    policy: READ_POLICY,
    handler: (request, _params, deps) => handleGetMasterInbox(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects",
    policy: MASTER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostProject(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:projectId/target-config",
    policy: MASTER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostProjectTargetConfig(params, request, deps),
  },
  {
    method: "POST",
    pattern: "/api/requirements",
    policy: MASTER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostRequirement(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/tasks",
    policy: MASTER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostTask(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/worker-runs",
    policy: WORKER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostWorkerRun(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/worker-events",
    policy: WORKER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostWorkerEvent(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/worker-reports",
    policy: WORKER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostWorkerReport(request, deps),
  },
  {
    method: "GET",
    pattern: "/api/test-cases/:testCaseId",
    policy: VERIFIER_WRITE_POLICY,
    handler: (_request, params, deps) => handleGetTestCase(params, deps),
  },
  {
    method: "POST",
    pattern: "/api/test-cases",
    policy: VERIFIER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostTestCase(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/test-results",
    policy: VERIFIER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostTestResult(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/evidence",
    policy: policyFor(["worker", "verifier", "admin"]),
    handler: (request, _params, deps) => handlePostEvidence(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/code-candidates",
    policy: WORKER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostCodeCandidate(request, deps),
  },
  {
    method: "GET",
    pattern: "/api/code-candidates/:candidateId",
    policy: WORKER_WRITE_POLICY,
    handler: (_request, params, deps) => handleGetCodeCandidate(params, deps),
  },
  {
    method: "GET",
    pattern: "/api/code-candidates/:candidateId/patch",
    policy: WORKER_WRITE_POLICY,
    handler: (_request, params, deps) => handleGetCodeCandidatePatch(params, deps),
  },
  {
    method: "GET",
    pattern: "/api/promotion-runs/:promotionRunId",
    policy: WORKER_WRITE_POLICY,
    handler: (_request, params, deps) => handleGetPromotionRun(params, deps),
  },
  {
    method: "POST",
    pattern: "/api/promotion-runs/:promotionRunId/complete",
    policy: WORKER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostPromotionRunComplete(params, request, deps),
  },
  {
    method: "POST",
    pattern: "/api/verifier-runs",
    policy: VERIFIER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostVerifierRun(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/master/inbox",
    policy: INBOX_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostMasterInbox(request, deps),
  },
  {
    method: "POST",
    pattern: "/api/master/run",
    policy: MASTER_WRITE_POLICY,
    handler: (request, _params, deps) => handlePostMasterRun(request, deps),
  },
  {
    method: "GET",
    pattern: "/api/master/runs",
    policy: READ_POLICY,
    handler: (request, _params, deps) => handleGetMasterRuns(request, deps),
  },
  {
    method: "GET",
    pattern: "/api/master/runs/:runId",
    policy: READ_POLICY,
    handler: (_request, params, deps) => handleGetMasterRun(params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:projectId/release-contract",
    policy: MASTER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostReleaseContract(request, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:projectId/release-contract",
    policy: READ_POLICY,
    handler: (_request, params, deps) => handleGetReleaseContract(params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:projectId/budgets",
    policy: MASTER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostProjectBudget(request, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:projectId/budgets",
    policy: READ_POLICY,
    handler: (_request, params, deps) => handleGetProjectBudgets(params, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:projectId/budgets/:budgetId",
    policy: READ_POLICY,
    handler: (_request, params, deps) => handleGetProjectBudget(params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:projectId/budgets/:budgetId/increase",
    policy: MASTER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostIncreaseProjectBudget(request, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:projectId/budget-entries",
    policy: WORKER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostBudgetEntry(request, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:projectId/dispatch",
    policy: MASTER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostProjectDispatch(request, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:projectId/recover-expired-runs",
    policy: MASTER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostRecoverExpiredRuns(params, request, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:projectId/audit",
    policy: MASTER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostProjectAudit(params, request, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:projectId/audit-findings",
    policy: READ_POLICY,
    handler: (request, params, deps) => handleGetProjectAuditFindings(params, request, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:projectId/orchestrate",
    policy: MASTER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostProjectOrchestrate(params, request, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:projectId/worker-runs",
    policy: READ_POLICY,
    handler: (_request, params, deps) => handleGetProjectWorkerRuns(params, deps),
  },
  {
    method: "GET",
    pattern: "/api/worker-runs/:workerRunId",
    policy: READ_POLICY,
    handler: (_request, params, deps) => handleGetWorkerRun(params, deps),
  },
  {
    method: "GET",
    pattern: "/api/worker-runs/:workerRunId/task-packet",
    policy: READ_POLICY,
    handler: (request, params, deps) => handleGetWorkerRunTaskPacket(request, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/worker-runs/:workerRunId/claim",
    policy: WORKER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostWorkerRunClaim(params, request, deps),
  },
  {
    method: "POST",
    pattern: "/api/worker-runs/:workerRunId/heartbeat",
    policy: WORKER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostWorkerRunHeartbeat(params, request, deps),
  },
  {
    method: "POST",
    pattern: "/api/worker-runs/:workerRunId/succeed",
    policy: WORKER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostWorkerRunSucceed(params, request, deps),
  },
  {
    method: "POST",
    pattern: "/api/worker-runs/:workerRunId/fail",
    policy: WORKER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostWorkerRunFail(params, request, deps),
  },
  {
    method: "POST",
    pattern: "/api/worker-runs/:workerRunId/cancel",
    policy: WORKER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostWorkerRunCancel(params, request, deps),
  },
  {
    method: "POST",
    pattern: "/api/worker-runs/:workerRunId/retry",
    policy: MASTER_WRITE_POLICY,
    handler: (request, params, deps) => handlePostWorkerRunRetry(params, request, deps),
  },
];

async function dispatch(request: Request, options: ApiRouterOptions): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  for (const route of routes) {
    if (route.method !== request.method) {
      continue;
    }
    const params = matchRoute(pathname, route.pattern);
    if (params !== null) {
      if (route.policy.auth === "protected") {
        const caller = authenticateBearer(request, options.auth);
        assertCallerPermitted(caller, route.policy);
      }
      return route.handler(request, params, options.deps);
    }
  }

  throw new ApiError(404, "not_found", `No route for ${request.method} ${pathname}`);
}

export function createApiRouter(options: ApiRouterOptions): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      const response = await dispatch(request, options);
      return finalizeResponse(response, options.auth.production);
    } catch (error) {
      return finalizeResponse(new Response(), options.auth.production, error);
    }
  };
}

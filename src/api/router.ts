import type { AsyncStateStore } from "../state/async-store.js";
import type { WorkerReport } from "../domain/index.js";
import type { EvidenceBlobStore } from "../evidence/index.js";
import { evidenceBlobKey } from "../evidence/index.js";
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
  assertEntityId,
  assertNonEmptyString,
  assertObject,
  rejectUnknownKeys,
  validators,
} from "./validation.js";

export interface ApiDependencies {
  store: AsyncStateStore;
  blobs: EvidenceBlobStore;
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

function assertOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(400, "validation_error", `Invalid ${field}`, [
      { field, message: "Must be a finite number" },
    ]);
  }
  return value;
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
  rejectUnknownKeys(body, ["id", "name", "description"]);
  const project = await deps.store.createProject({
    id: assertEntityId(body.id, "id"),
    name: assertNonEmptyString(body.name, "name"),
    description: assertNonEmptyString(body.description, "description"),
  });
  return jsonResponse({ project }, 201);
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
  const report = await deps.store.createWorkerReport({
    id: assertEntityId(body.id, "id"),
    projectId,
    taskId,
    workerRunId,
    summary: assertNonEmptyString(body.summary, "summary"),
    outcome: validators.workerReportOutcome(body.outcome, "outcome") as WorkerReport["outcome"],
    ...(metrics !== undefined ? { metrics } : {}),
  });
  return jsonResponse({ report }, 201);
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
  rejectUnknownKeys(body, ["id", "projectId", "taskId", "outcome", "summary", "evidenceIds"]);
  const projectId = assertEntityId(body.projectId, "projectId");
  await requireProject(deps.store, projectId);
  const taskId = assertEntityId(body.taskId, "taskId");
  const id = assertEntityId(body.id, "id");
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

  const verifierRun = await deps.store.createVerifierRun({ id, projectId, taskId });
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

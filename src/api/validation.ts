import type {
  BudgetCategory,
  BudgetLimitKind,
  DeploymentStatus,
  EvidenceKind,
  MasterInboxItemKind,
  MasterPhase,
  PermissionDecision,
  PermissionScope,
  ProjectStatus,
  RequirementStatus,
  TaskKind,
  TaskStatus,
  TestCaseKind,
  VerificationOutcome,
  WorkerEventType,
  WorkerKind,
  WorkerRunStatus,
} from "../domain/index.js";
import { ApiError } from "./errors.js";

export const ENTITY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const PROJECT_STATUSES = new Set<ProjectStatus>(["active", "paused", "archived"]);
const REQUIREMENT_STATUSES = new Set<RequirementStatus>(["draft", "approved", "superseded", "rejected"]);
const TASK_STATUSES = new Set<TaskStatus>([
  "pending", "ready", "assigned", "in_progress", "blocked",
  "awaiting_verification", "completed", "failed", "cancelled",
]);
const TASK_KINDS = new Set<TaskKind>(["planning", "implementation", "verification", "deployment", "acceptance"]);
const WORKER_KINDS = new Set<WorkerKind>(["cursor_acp", "playwright", "verifier", "generic"]);
const WORKER_RUN_STATUSES = new Set<WorkerRunStatus>(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]);
const WORKER_EVENT_TYPES = new Set<WorkerEventType>(["started", "log", "artifact", "progress", "error", "completed"]);
const WORKER_REPORT_OUTCOMES = new Set(["success", "failure", "partial"]);
const TEST_CASE_KINDS = new Set<TestCaseKind>(["unit", "integration", "browser", "acceptance"]);
const VERIFICATION_OUTCOMES = new Set<VerificationOutcome>(["PASS", "FAIL", "INCONCLUSIVE"]);
const EVIDENCE_KINDS = new Set<EvidenceKind>(["screenshot", "log", "artifact", "report", "diff", "other"]);
const PERMISSION_SCOPES = new Set<PermissionScope>(["filesystem", "network", "git", "deployment", "external_api", "cost"]);
const PERMISSION_DECISIONS = new Set<PermissionDecision>(["allow", "deny", "escalate"]);
const DEPLOYMENT_STATUSES = new Set<DeploymentStatus>(["pending", "in_progress", "live", "failed", "rolled_back"]);
const MASTER_PHASES = new Set<MasterPhase>([
  "initializing", "planning", "executing", "verifying", "accepting", "paused", "completed", "failed",
]);
const MASTER_INBOX_KINDS = new Set<MasterInboxItemKind>([
  "worker_report", "verification_result", "permission_request", "budget_alert", "task_update", "human_message",
]);
const BUDGET_CATEGORIES = new Set<BudgetCategory>(["llm_tokens", "compute", "browser_minutes", "storage", "other"]);
const BUDGET_LIMIT_KINDS = new Set<BudgetLimitKind>(["soft", "hard"]);

export function assertEntityId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ENTITY_ID_PATTERN.test(value)) {
    throw new ApiError(400, "validation_error", `Invalid ${field}`, [{ field, message: "Must be a stable string ID" }]);
  }
  return value;
}

export function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "validation_error", `Invalid ${field}`, [{ field, message: "Required non-empty string" }]);
  }
  return value;
}

export function assertEnum<T extends string>(value: unknown, field: string, allowed: ReadonlySet<T>): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new ApiError(400, "validation_error", `Invalid ${field}`, [
      { field, message: `Must be one of: ${[...allowed].join(", ")}` },
    ]);
  }
  return value as T;
}

export function assertOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<T>,
): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertEnum(value, field, allowed);
}

export function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "validation_error", `Invalid ${field}`, [{ field, message: "Must be an object" }]);
  }
  return value as Record<string, unknown>;
}

export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  return assertObject(body, "body");
}

export const validators = {
  projectStatus: (v: unknown, f: string) => assertEnum(v, f, PROJECT_STATUSES),
  requirementStatus: (v: unknown, f: string) => assertEnum(v, f, REQUIREMENT_STATUSES),
  taskStatus: (v: unknown, f: string) => assertEnum(v, f, TASK_STATUSES),
  taskKind: (v: unknown, f: string) => assertEnum(v, f, TASK_KINDS),
  workerKind: (v: unknown, f: string) => assertEnum(v, f, WORKER_KINDS),
  workerRunStatus: (v: unknown, f: string) => assertEnum(v, f, WORKER_RUN_STATUSES),
  workerEventType: (v: unknown, f: string) => assertEnum(v, f, WORKER_EVENT_TYPES),
  workerReportOutcome: (v: unknown, f: string) => assertEnum(v, f, WORKER_REPORT_OUTCOMES as ReadonlySet<string>),
  testCaseKind: (v: unknown, f: string) => assertEnum(v, f, TEST_CASE_KINDS),
  verificationOutcome: (v: unknown, f: string) => assertEnum(v, f, VERIFICATION_OUTCOMES),
  evidenceKind: (v: unknown, f: string) => assertEnum(v, f, EVIDENCE_KINDS),
  permissionScope: (v: unknown, f: string) => assertEnum(v, f, PERMISSION_SCOPES),
  permissionDecision: (v: unknown, f: string) => assertEnum(v, f, PERMISSION_DECISIONS),
  deploymentStatus: (v: unknown, f: string) => assertEnum(v, f, DEPLOYMENT_STATUSES),
  masterPhase: (v: unknown, f: string) => assertEnum(v, f, MASTER_PHASES),
  masterInboxKind: (v: unknown, f: string) => assertEnum(v, f, MASTER_INBOX_KINDS),
  budgetCategory: (v: unknown, f: string) => assertEnum(v, f, BUDGET_CATEGORIES),
  budgetLimitKind: (v: unknown, f: string) => assertEnum(v, f, BUDGET_LIMIT_KINDS),
};

export function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, "validation_error", "Unknown fields in request body", [
        { field: key, message: "Unknown field" },
      ]);
    }
  }
}

export function decodeBase64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  const buf = Buffer.from(value, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

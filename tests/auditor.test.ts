import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import { runProjectAudit, DEFAULT_AUDIT_THRESHOLDS } from "../src/auditor/index.js";
import { DEFAULT_LEASE_DURATION_MS, leaseExpiryIso } from "../src/executor/lease.js";
import { createWorkerRunLifecycle } from "../src/executor/index.js";
import { createWorkerDispatcher } from "../src/dispatch/index.js";
import { createSequentialIdFactory } from "../src/master/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import { asAsyncStore, createInMemoryStateStore, createTestD1Database, createD1StateStore } from "../src/state/index.js";

const PROJECT_ID = "proj-auditor";
const TASK_ID = "task-auditor";
const TEST_THRESHOLDS = {
  ...DEFAULT_AUDIT_THRESHOLDS,
  queuedStuckMs: 1_000,
  repeatedTaskFailureMin: 2,
  retryLoopMinRuns: 3,
  repeatedIdenticalFailureMin: 2,
  budgetApproachingRemainingRatio: 0.1,
};

function createHarness() {
  const syncStore = createInMemoryStateStore();
  const store = asAsyncStore(syncStore);
  const ids = createSequentialIdFactory();
  const taskDispatcher = createWorkerDispatcher({ store, idFactory: ids });
  const workerRunLifecycle = createWorkerRunLifecycle({ store, dispatcher: taskDispatcher });
  const router = createApiRouter({
    deps: { store, blobs: new InMemoryEvidenceBlobStore(), taskDispatcher, workerRunLifecycle },
    auth: { serviceToken: "audit-token", production: false },
  });
  return { syncStore, store, router, workerRunLifecycle };
}

function seedHealthyProject(syncStore: ReturnType<typeof createInMemoryStateStore>): void {
  syncStore.createProject({ id: PROJECT_ID, name: "Audit", description: "Audit tests" });
  syncStore.createTask({
    id: TASK_ID,
    projectId: PROJECT_ID,
    title: "Task",
    description: "Task",
    kind: "implementation",
  });
}

async function audit(
  syncStore: ReturnType<typeof createInMemoryStateStore>,
  now: string,
): Promise<ReturnType<typeof runProjectAudit>> {
  return runProjectAudit(syncStore, PROJECT_ID, { now, thresholds: TEST_THRESHOLDS });
}

function activeRuleCodes(result: Awaited<ReturnType<typeof audit>>): string[] {
  return result.findings.filter((f) => f.status === "active").map((f) => f.ruleCode);
}

describe("auditor rules and persistence", () => {
  let syncStore: ReturnType<typeof createInMemoryStateStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    syncStore = createInMemoryStateStore();
    seedHealthyProject(syncStore);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports no serious findings for a healthy project", async () => {
    const result = await audit(syncStore, new Date().toISOString());
    expect(activeRuleCodes(result)).toEqual([]);
    expect(result.activeCount).toBe(0);
  });

  it("detects STUCK_WORKER for expired running lease", async () => {
    syncStore.assignTaskToWorkerRun({
      id: "run-stuck",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });
    const claimAt = "2026-01-01T00:00:00.000Z";
    syncStore.claimQueuedWorkerRun({
      workerRunId: "run-stuck",
      ownerId: "owner-1",
      leaseTokenHash: "hash",
      leaseExpiresAt: leaseExpiryIso(claimAt, DEFAULT_LEASE_DURATION_MS),
      lastHeartbeatAt: claimAt,
      at: claimAt,
    });

    const stuckAt = new Date(Date.parse(claimAt) + DEFAULT_LEASE_DURATION_MS + 1_000).toISOString();
    const result = await audit(syncStore, stuckAt);
    expect(activeRuleCodes(result)).toContain("STUCK_WORKER");
    expect(result.findings.find((f) => f.ruleCode === "STUCK_WORKER")?.workerRunId).toBe("run-stuck");
  });

  it("detects REPEATED_TASK_FAILURE and REPEATED_IDENTICAL_FAILURE", async () => {
    for (const id of ["run-fail-1", "run-fail-2"]) {
      syncStore.createWorkerRun({
        id,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        workerKind: "generic",
      });
      syncStore.updateWorkerRunStatus(id, "failed", "Build timeout exceeded");
    }

    const result = await audit(syncStore, new Date().toISOString());
    expect(activeRuleCodes(result)).toContain("REPEATED_TASK_FAILURE");
    expect(activeRuleCodes(result)).toContain("REPEATED_IDENTICAL_FAILURE");
  });

  it("detects RETRY_LOOP without successful progress", async () => {
    for (const id of ["run-loop-1", "run-loop-2", "run-loop-3"]) {
      syncStore.createWorkerRun({
        id,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        workerKind: "generic",
      });
      syncStore.updateWorkerRunStatus(id, "failed", "transient");
    }

    const result = await audit(syncStore, new Date().toISOString());
    expect(activeRuleCodes(result)).toContain("RETRY_LOOP");
  });

  it("detects DUPLICATE_ACTIVE_WORK", async () => {
    syncStore.createWorkerRun({
      id: "run-dup-1",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });
    syncStore.createWorkerRun({
      id: "run-dup-2",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });

    const result = await audit(syncStore, new Date().toISOString());
    expect(activeRuleCodes(result)).toContain("DUPLICATE_ACTIVE_WORK");
  });

  it("detects MISSING_REPORT for terminal worker runs", async () => {
    syncStore.createWorkerRun({
      id: "run-no-report",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });
    syncStore.updateWorkerRunStatus("run-no-report", "succeeded");

    const result = await audit(syncStore, new Date().toISOString());
    expect(activeRuleCodes(result)).toContain("MISSING_REPORT");
  });

  it("detects VERIFIER_MISMATCH when pass disagrees with failed task", async () => {
    syncStore.updateTaskStatus(TASK_ID, "failed");
    syncStore.createVerifierRun({
      id: "verifier-mismatch",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
    });
    syncStore.completeVerifierRun({
      verifierRunId: "verifier-mismatch",
      outcome: "PASS",
      summary: "Looks good",
    });

    const result = await audit(syncStore, new Date().toISOString());
    expect(activeRuleCodes(result)).toContain("VERIFIER_MISMATCH");
  });

  it("detects BUDGET_ANOMALY when hard limit is exceeded", async () => {
    syncStore.initializeBudgetLedger({
      projectId: PROJECT_ID,
      limits: [{ kind: "hard", category: "llm_tokens", maxAmount: 100, unit: "tokens" }],
    });
    syncStore.recordBudgetEntry({
      id: "budget-entry-1",
      projectId: PROJECT_ID,
      category: "llm_tokens",
      amount: 150,
      unit: "tokens",
    });

    const result = await audit(syncStore, new Date().toISOString());
    expect(activeRuleCodes(result)).toContain("BUDGET_ANOMALY");
  });

  it("does not create duplicate active findings on reruns", async () => {
    syncStore.createWorkerRun({
      id: "run-dup-1",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });
    syncStore.createWorkerRun({
      id: "run-dup-2",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });

    const first = await audit(syncStore, new Date().toISOString());
    const second = await audit(syncStore, new Date(Date.now() + 5_000).toISOString());
    const activeDuplicate = second.findings.filter(
      (f) => f.status === "active" && f.ruleCode === "DUPLICATE_ACTIVE_WORK",
    );
    expect(first.activeCount).toBeGreaterThan(0);
    expect(activeDuplicate).toHaveLength(1);
    expect(activeDuplicate[0]!.firstObservedAt).toBe(first.findings.find((f) => f.ruleCode === "DUPLICATE_ACTIVE_WORK")!.firstObservedAt);
    expect(activeDuplicate[0]!.lastObservedAt).not.toBe(activeDuplicate[0]!.firstObservedAt);
  });

  it("resolves findings when the underlying condition clears", async () => {
    syncStore.createWorkerRun({
      id: "run-dup-1",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });
    syncStore.createWorkerRun({
      id: "run-dup-2",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });

    await audit(syncStore, new Date().toISOString());
    syncStore.updateWorkerRunStatus("run-dup-2", "cancelled");
    syncStore.createWorkerReport({
      id: "report-dup-2",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerRunId: "run-dup-2",
      summary: "Cancelled",
      outcome: "failure",
    });

    const after = await audit(syncStore, new Date(Date.now() + 10_000).toISOString());
    expect(after.findings.filter((f) => f.status === "active" && f.ruleCode === "DUPLICATE_ACTIVE_WORK")).toHaveLength(0);
    const resolved = after.findings.filter(
      (f) => f.ruleCode === "DUPLICATE_ACTIVE_WORK" && f.status === "resolved",
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.resolvedAt).toBeDefined();
  });
});

describe("auditor API", () => {
  const BASE = "http://localhost";

  async function request(
    router: ReturnType<typeof createApiRouter>,
    method: string,
    path: string,
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: { authorization: "Bearer audit-token", "content-type": "application/json" },
    };
    if (method === "POST") {
      init.body = "{}";
    }
    return router(new Request(`${BASE}${path}`, init));
  }

  it("runs audit and lists findings via API", async () => {
    const { syncStore, router } = createHarness();
    seedHealthyProject(syncStore);
    syncStore.createWorkerRun({
      id: "run-dup-1",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });
    syncStore.createWorkerRun({
      id: "run-dup-2",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });

    const run = await request(router, "POST", `/api/projects/${PROJECT_ID}/audit`);
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as { activeCount: number; findings: { ruleCode: string }[] };
    expect(runBody.activeCount).toBe(1);
    expect(runBody.findings[0]!.ruleCode).toBe("DUPLICATE_ACTIVE_WORK");

    const list = await request(router, "GET", `/api/projects/${PROJECT_ID}/audit-findings`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { findings: unknown[] };
    expect(listBody.findings).toHaveLength(1);
  });
});

describe("auditor D1 persistence", () => {
  it("persists audit findings in D1", async () => {
    const db = await createTestD1Database();
    const store = createD1StateStore(db);
    await store.createProject({ id: PROJECT_ID, name: "Audit", description: "D1" });
    await store.createTask({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Task",
      description: "Task",
      kind: "implementation",
    });
    await store.createWorkerRun({
      id: "run-dup-1",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });
    await store.createWorkerRun({
      id: "run-dup-2",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });

    const result = await runProjectAudit(store, PROJECT_ID, {
      now: "2026-01-01T00:00:00.000Z",
      thresholds: TEST_THRESHOLDS,
    });
    expect(result.activeCount).toBe(1);

    const listed = await store.listAuditFindingsByProject(PROJECT_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.ruleCode).toBe("DUPLICATE_ACTIVE_WORK");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import { createWorkerDispatcher } from "../src/dispatch/index.js";
import {
  createWorkerRunLifecycle,
  HEARTBEAT_EVENTS_PERSISTED,
  LIFECYCLE_EVENTS,
  WorkerRunLifecycleError,
  generateLeaseToken,
  hashLeaseToken,
} from "../src/executor/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import { createSequentialIdFactory } from "../src/master/index.js";
import { asAsyncStore, createD1StateStore, createInMemoryStateStore, createTestD1Database } from "../src/state/index.js";

const PROJECT = "proj-lease";
const OTHER = "proj-other";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const WRONG_TOKEN = "ab".repeat(32);
const START = "2026-08-30T00:00:00.000Z";
const LEASE_MS = 60_000;

function shift(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function serializedContainsToken(value: unknown, token: string): boolean {
  return JSON.stringify(value).includes(token);
}

describe("lease token helpers", () => {
  it("generates high-entropy tokens and SHA-256 hashes", async () => {
    const token = generateLeaseToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(generateLeaseToken());
    const hash = await hashLeaseToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(HEARTBEAT_EVENTS_PERSISTED).toBe(false);
  });
});

describe("worker-run leases and recovery", () => {
  let syncStore: ReturnType<typeof createInMemoryStateStore>;
  let clock: { now: string };
  let lifecycle: ReturnType<typeof createWorkerRunLifecycle>;
  let dispatcher: ReturnType<typeof createWorkerDispatcher>;

  beforeEach(() => {
    syncStore = createInMemoryStateStore();
    const store = asAsyncStore(syncStore);
    const ids = createSequentialIdFactory();
    clock = { now: START };
    dispatcher = createWorkerDispatcher({ store, idFactory: ids });
    lifecycle = createWorkerRunLifecycle({
      store,
      dispatcher,
      idFactory: ids,
      now: () => clock.now,
      leaseDurationMs: LEASE_MS,
      maxAttempts: 3,
    });
    syncStore.createProject({ id: PROJECT, name: "Lease", description: "Lease" });
    syncStore.createProject({ id: OTHER, name: "Other", description: "Other" });
  });

  async function dispatchTask(taskId: string, projectId = PROJECT) {
    syncStore.createTask({
      id: taskId,
      projectId,
      title: taskId,
      description: "Work",
      kind: "implementation",
    });
    const result = await dispatcher.dispatch(projectId, { maxAssignments: 1 });
    const assignment = result.assignments[0]!;
    return assignment;
  }

  it("lets only one owner claim and rejects steal while the lease is active", async () => {
    const assignment = await dispatchTask("task-claim-once");
    const first = await lifecycle.claim(assignment.workerRun.id, { ownerId: OWNER_A });
    expect(first.workerRun.ownerId).toBe(OWNER_A);
    expect(first.workerRun.leaseExpiresAt).toBe(shift(START, LEASE_MS));
    await expect(lifecycle.claim(assignment.workerRun.id, { ownerId: OWNER_B })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(syncStore.getWorkerRun(assignment.workerRun.id)?.ownerId).toBe(OWNER_A);
    expect(syncStore.listWorkerRunsByProject(PROJECT)).toHaveLength(1);
  });

  it("does not overwrite stale ownership via normal claim", async () => {
    const assignment = await dispatchTask("task-stale");
    await lifecycle.claim(assignment.workerRun.id, { ownerId: OWNER_A });
    clock.now = shift(START, LEASE_MS);
    await expect(lifecycle.claim(assignment.workerRun.id, { ownerId: OWNER_B })).rejects.toMatchObject({
      code: "conflict",
    });
    const run = syncStore.getWorkerRun(assignment.workerRun.id)!;
    expect(run.status).toBe("running");
    expect(run.ownerId).toBe(OWNER_A);
  });

  it("extends the lease only for the current token and rejects a wrong token", async () => {
    const assignment = await dispatchTask("task-hb");
    const claimed = await lifecycle.claim(assignment.workerRun.id, { ownerId: OWNER_A });
    clock.now = shift(START, 30_000);
    const beat = await lifecycle.heartbeat(assignment.workerRun.id, { leaseToken: claimed.leaseToken });
    expect(beat.workerRun.lastHeartbeatAt).toBe(clock.now);
    expect(beat.workerRun.leaseExpiresAt).toBe(shift(clock.now, LEASE_MS));
    expect(syncStore.getTask(assignment.task.id)?.status).toBe("in_progress");
    expect(syncStore.listWorkerEvents(assignment.workerRun.id)).toHaveLength(1);

    await expect(
      lifecycle.heartbeat(assignment.workerRun.id, { leaseToken: WRONG_TOKEN }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(syncStore.getWorkerRun(assignment.workerRun.id)?.lastHeartbeatAt).toBe(clock.now);
  });

  it("rejects heartbeat, success, and fail with the wrong token", async () => {
    const assignment = await dispatchTask("task-wrong");
    await lifecycle.claim(assignment.workerRun.id, { ownerId: OWNER_A });
    await expect(
      lifecycle.succeed(assignment.workerRun.id, { summary: "nope", leaseToken: WRONG_TOKEN }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      lifecycle.fail(assignment.workerRun.id, {
        errorCode: "X",
        summary: "nope",
        leaseToken: WRONG_TOKEN,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(syncStore.getWorkerRun(assignment.workerRun.id)?.status).toBe("running");
  });

  it("rejects finish and heartbeat after the lease expires and does not revive it", async () => {
    const assignment = await dispatchTask("task-exp");
    const claimed = await lifecycle.claim(assignment.workerRun.id, { ownerId: OWNER_A });
    clock.now = shift(START, LEASE_MS);
    await expect(
      lifecycle.heartbeat(assignment.workerRun.id, { leaseToken: claimed.leaseToken }),
    ).rejects.toMatchObject({ code: "expired" });
    await expect(
      lifecycle.succeed(assignment.workerRun.id, { summary: "late", leaseToken: claimed.leaseToken }),
    ).rejects.toMatchObject({ code: "expired" });
    await expect(
      lifecycle.fail(assignment.workerRun.id, {
        errorCode: "LATE",
        summary: "late",
        leaseToken: claimed.leaseToken,
      }),
    ).rejects.toMatchObject({ code: "expired" });
    expect(syncStore.getWorkerRun(assignment.workerRun.id)?.status).toBe("running");
  });

  it("times out an expired run once and does not duplicate events, reports, or inbox", async () => {
    const assignment = await dispatchTask("task-timeout");
    const claimed = await lifecycle.claim(assignment.workerRun.id, { ownerId: OWNER_A });
    clock.now = shift(START, LEASE_MS);
    const first = await lifecycle.recoverExpiredRuns(PROJECT);
    expect(first.recovered).toHaveLength(1);
    const recovered = first.recovered[0]!;
    expect(recovered.workerRun.status).toBe("timed_out");
    expect(recovered.workerRun.completedAt).toBe(clock.now);
    expect(recovered.task.status).toBe("failed");
    expect(recovered.task.status).not.toBe("completed");
    expect(recovered.event.payload?.["lifecycle"]).toBe(LIFECYCLE_EVENTS.TIMED_OUT);
    expect(recovered.report.outcome).toBe("failure");
    expect(syncStore.listBlockersByProject(PROJECT)).toHaveLength(0);

    const second = await lifecycle.recoverExpiredRuns(PROJECT);
    expect(second.recovered).toHaveLength(0);
    expect(
      syncStore.listWorkerEvents(assignment.workerRun.id).filter(
        (event) => event.payload?.["lifecycle"] === LIFECYCLE_EVENTS.TIMED_OUT,
      ),
    ).toHaveLength(1);
    expect(syncStore.listMasterInbox(PROJECT).filter((item) => item.kind === "worker_report")).toHaveLength(1);
    expect(serializedContainsToken(syncStore.listWorkerEvents(assignment.workerRun.id), claimed.leaseToken)).toBe(
      false,
    );
    expect(serializedContainsToken(syncStore.listMasterInbox(PROJECT), claimed.leaseToken)).toBe(false);
    expect(serializedContainsToken(recovered.report, claimed.leaseToken)).toBe(false);
  });

  it("does not restart a timed_out run and retry creates a new run", async () => {
    const assignment = await dispatchTask("task-retry");
    await lifecycle.claim(assignment.workerRun.id, { ownerId: OWNER_A });
    clock.now = shift(START, LEASE_MS);
    await lifecycle.recoverExpiredRuns(PROJECT);
    const timedOut = syncStore.getWorkerRun(assignment.workerRun.id)!;
    expect(timedOut.status).toBe("timed_out");

    await expect(lifecycle.claim(timedOut.id, { ownerId: OWNER_B })).rejects.toMatchObject({
      code: "illegal_transition",
    });
    await expect(
      lifecycle.heartbeat(timedOut.id, { leaseToken: WRONG_TOKEN }),
    ).rejects.toMatchObject({ code: "illegal_transition" });

    const retried = await lifecycle.retry(timedOut.id);
    expect(retried.previousWorkerRun.id).toBe(timedOut.id);
    expect(retried.previousWorkerRun.status).toBe("timed_out");
    expect(retried.workerRun.id).not.toBe(timedOut.id);
    expect(retried.workerRun.status).toBe("queued");
    expect(retried.workerRun.iteration).toBe(timedOut.iteration + 1);
    expect(retried.task.assignedWorkerRunId).toBe(retried.workerRun.id);
    expect(retried.task.status).toBe("assigned");
    expect(retried.event.payload?.["lifecycle"]).toBe(LIFECYCLE_EVENTS.RETRY_CREATED);
    expect(syncStore.getWorkerRun(timedOut.id)?.status).toBe("timed_out");
    expect(syncStore.getWorkerRun(timedOut.id)?.updatedAt).toBe(timedOut.updatedAt);

    const active = syncStore
      .listWorkerRunsByProject(PROJECT)
      .filter((run) => run.taskId === assignment.task.id && (run.status === "queued" || run.status === "running"));
    expect(active).toHaveLength(1);
  });

  it("enforces max attempts and keeps a single nonterminal run per task", async () => {
    const assignment = await dispatchTask("task-max");
    let currentId = assignment.workerRun.id;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await lifecycle.claim(currentId, { ownerId: OWNER_A });
      clock.now = shift(clock.now, LEASE_MS);
      await lifecycle.recoverExpiredRuns(PROJECT);
      expect(syncStore.getWorkerRun(currentId)?.status).toBe("timed_out");
      const nonterminal = syncStore
        .listWorkerRunsByProject(PROJECT)
        .filter((run) => run.taskId === assignment.task.id && (run.status === "queued" || run.status === "running"));
      expect(nonterminal).toHaveLength(0);
      if (attempt < 3) {
        const retried = await lifecycle.retry(currentId);
        currentId = retried.workerRun.id;
      }
    }
    await expect(lifecycle.retry(currentId)).rejects.toMatchObject({ code: "conflict" });
    expect(syncStore.listWorkerRunsByProject(PROJECT).filter((run) => run.taskId === assignment.task.id)).toHaveLength(
      3,
    );
  });

  it("ignores expired runs in another project", async () => {
    const local = await dispatchTask("task-local");
    const remote = await dispatchTask("task-remote", OTHER);
    await lifecycle.claim(local.workerRun.id, { ownerId: OWNER_A });
    await lifecycle.claim(remote.workerRun.id, { ownerId: OWNER_B });
    clock.now = shift(START, LEASE_MS);
    const recovered = await lifecycle.recoverExpiredRuns(PROJECT);
    expect(recovered.recovered.map((item) => item.workerRun.id)).toEqual([local.workerRun.id]);
    expect(syncStore.getWorkerRun(remote.workerRun.id)?.status).toBe("running");
  });
});

describe("worker-run lease APIs", () => {
  const TEST_TOKEN = "test-service-token";
  const BASE = "http://localhost";
  const PROJECT_ID = "proj-lease-api";

  function createHarness(now: { current: string }) {
    const syncStore = createInMemoryStateStore();
    const store = asAsyncStore(syncStore);
    const blobs = new InMemoryEvidenceBlobStore();
    const ids = createSequentialIdFactory();
    const taskDispatcher = createWorkerDispatcher({ store, idFactory: ids });
    const workerRunLifecycle = createWorkerRunLifecycle({
      store,
      dispatcher: taskDispatcher,
      idFactory: ids,
      now: () => now.current,
      leaseDurationMs: LEASE_MS,
    });
    const router = createApiRouter({
      deps: { store, blobs, taskDispatcher, workerRunLifecycle },
      auth: { serviceToken: TEST_TOKEN, production: false },
    });
    return { router, syncStore };
  }

  async function request(
    router: ReturnType<typeof createApiRouter>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return router(new Request(`${BASE}${path}`, init));
  }

  it("heartbeats, recovers, and retries through the HTTP API", async () => {
    const now = { current: START };
    const { router, syncStore } = createHarness(now);
    await request(router, "POST", "/api/projects", {
      id: PROJECT_ID,
      name: "Lease API",
      description: "Lease API",
    });
    await request(router, "POST", "/api/tasks", {
      id: "task-lease-api",
      projectId: PROJECT_ID,
      title: "A",
      description: "A",
      kind: "implementation",
    });
    const dispatch = await request(router, "POST", `/api/projects/${PROJECT_ID}/dispatch`, {
      maxAssignments: 1,
    });
    const dispatched = (await dispatch.json()) as { assignments: { workerRun: { id: string } }[] };
    const runId = dispatched.assignments[0]!.workerRun.id;

    const claim = await request(router, "POST", `/api/worker-runs/${runId}/claim`, { ownerId: OWNER_A });
    const claimed = (await claim.json()) as { leaseToken: string; workerRun: { status: string } };
    expect(claim.status).toBe(200);

    now.current = shift(START, 30_000);
    const heartbeat = await request(router, "POST", `/api/worker-runs/${runId}/heartbeat`, {
      leaseToken: claimed.leaseToken,
    });
    expect(heartbeat.status).toBe(200);

    const wrong = await request(router, "POST", `/api/worker-runs/${runId}/succeed`, {
      summary: "stolen",
      leaseToken: WRONG_TOKEN,
    });
    expect(wrong.status).toBe(403);

    now.current = shift(now.current, LEASE_MS);
    const expiredFinish = await request(router, "POST", `/api/worker-runs/${runId}/succeed`, {
      summary: "late",
      leaseToken: claimed.leaseToken,
    });
    expect(expiredFinish.status).toBe(409);

    const recover = await request(router, "POST", `/api/projects/${PROJECT_ID}/recover-expired-runs`, {});
    expect(recover.status).toBe(200);
    const recovered = (await recover.json()) as {
      recovered: { workerRun: { status: string }; task: { status: string } }[];
    };
    expect(recovered.recovered).toHaveLength(1);
    expect(recovered.recovered[0]?.workerRun.status).toBe("timed_out");
    expect(recovered.recovered[0]?.task.status).toBe("failed");
    expect(JSON.stringify(recovered)).not.toContain(claimed.leaseToken);

    const retry = await request(router, "POST", `/api/worker-runs/${runId}/retry`, {});
    expect(retry.status).toBe(200);
    const retried = (await retry.json()) as {
      previousWorkerRun: { id: string; status: string };
      workerRun: { id: string; status: string; iteration: number };
      task: { assignedWorkerRunId: string; status: string };
    };
    expect(retried.previousWorkerRun.status).toBe("timed_out");
    expect(retried.workerRun.id).not.toBe(runId);
    expect(retried.workerRun.status).toBe("queued");
    expect(retried.task.assignedWorkerRunId).toBe(retried.workerRun.id);
    expect(retried).not.toHaveProperty("leaseToken");
    expect(syncStore.getWorkerRun(runId)?.status).toBe("timed_out");
  });
});

describe("D1 worker-run leases", () => {
  it("claims, heartbeats, times out, and retries without exposing the token hash", async () => {
    const db = await createTestD1Database();
    const store = createD1StateStore(db);
    const ids = createSequentialIdFactory();
    let now = START;
    const dispatcher = createWorkerDispatcher({ store, idFactory: ids });
    const lifecycle = createWorkerRunLifecycle({
      store,
      dispatcher,
      idFactory: ids,
      now: () => now,
      leaseDurationMs: LEASE_MS,
    });
    await store.createProject({ id: PROJECT, name: "D1 lease", description: "D1" });
    await store.createTask({
      id: "task-d1-lease",
      projectId: PROJECT,
      title: "D1",
      description: "D1",
      kind: "implementation",
    });
    const dispatched = await dispatcher.dispatch(PROJECT, { maxAssignments: 1 });
    const runId = dispatched.assignments[0]!.workerRun.id;
    const claimed = await lifecycle.claim(runId, { ownerId: OWNER_A });
    const loaded = await store.getWorkerRun(runId);
    expect(loaded).not.toHaveProperty("leaseToken");
    expect(loaded).not.toHaveProperty("leaseTokenHash");
    expect(JSON.stringify(loaded)).not.toContain(claimed.leaseToken);

    now = shift(START, 30_000);
    await lifecycle.heartbeat(runId, { leaseToken: claimed.leaseToken });
    await expect(lifecycle.heartbeat(runId, { leaseToken: WRONG_TOKEN })).rejects.toBeInstanceOf(
      WorkerRunLifecycleError,
    );

    now = shift(now, LEASE_MS);
    const recovered = await lifecycle.recoverExpiredRuns(PROJECT);
    expect(recovered.recovered).toHaveLength(1);
    const retried = await lifecycle.retry(runId);
    expect(retried.workerRun.iteration).toBe(2);
    expect((await store.getWorkerRun(runId))?.status).toBe("timed_out");
  });
});

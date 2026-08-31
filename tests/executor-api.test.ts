import { beforeEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import { createWorkerDispatcher } from "../src/dispatch/index.js";
import { createWorkerRunLifecycle, LIFECYCLE_EVENTS } from "../src/executor/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import { createSequentialIdFactory } from "../src/master/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const TEST_TOKEN = "test-service-token";
const BASE = "http://localhost";
const PROJECT_ID = "proj-exec-api";

function createHarness() {
  const syncStore = createInMemoryStateStore();
  const store = asAsyncStore(syncStore);
  const blobs = new InMemoryEvidenceBlobStore();
  const ids = createSequentialIdFactory();
  const taskDispatcher = createWorkerDispatcher({ store, idFactory: ids });
  const workerRunLifecycle = createWorkerRunLifecycle({ store, dispatcher: taskDispatcher });
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
  const headers: Record<string, string> = {
    authorization: `Bearer ${TEST_TOKEN}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return router(new Request(`${BASE}${path}`, init));
}

describe("Worker-run lifecycle API", () => {
  let router: ReturnType<typeof createApiRouter>;
  let syncStore: ReturnType<typeof createInMemoryStateStore>;

  beforeEach(async () => {
    const harness = createHarness();
    router = harness.router;
    syncStore = harness.syncStore;
    await request(router, "POST", "/api/projects", {
      id: PROJECT_ID,
      name: "Exec",
      description: "API",
    });
    await request(router, "POST", "/api/tasks", {
      id: "task-exec-api",
      projectId: PROJECT_ID,
      title: "A",
      description: "A",
      kind: "implementation",
    });
  });

  async function dispatchedRunId(): Promise<string> {
    const dispatch = await request(router, "POST", `/api/projects/${PROJECT_ID}/dispatch`, {
      maxAssignments: 1,
    });
    const body = (await dispatch.json()) as { assignments: { workerRun: { id: string } }[] };
    return body.assignments[0]!.workerRun.id;
  }

  it("claims, succeeds, and rejects unknown fields", async () => {
    const runId = await dispatchedRunId();
    const claim = await request(router, "POST", `/api/worker-runs/${runId}/claim`, {
      ownerId: "owner-api",
    });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as {
      claimed: boolean;
      leaseToken: string;
      workerRun: { status: string; ownerId: string };
      task: { status: string };
      event: { payload: { lifecycle: string } };
    };
    expect(claimed.claimed).toBe(true);
    expect(claimed.leaseToken.length).toBeGreaterThanOrEqual(32);
    expect(claimed.workerRun.status).toBe("running");
    expect(claimed.workerRun.ownerId).toBe("owner-api");
    expect(claimed.task.status).toBe("in_progress");
    expect(claimed.event.payload.lifecycle).toBe(LIFECYCLE_EVENTS.STARTED);

    const listed = await request(router, "GET", `/api/worker-runs/${runId}`);
    const listedBody = (await listed.json()) as { workerRun: Record<string, unknown> };
    expect(listedBody.workerRun).not.toHaveProperty("leaseToken");
    expect(listedBody.workerRun).not.toHaveProperty("leaseTokenHash");
    expect(JSON.stringify(listedBody)).not.toContain(claimed.leaseToken);

    const unknown = await request(router, "POST", `/api/worker-runs/${runId}/succeed`, {
      summary: "ok",
      leaseToken: claimed.leaseToken,
      executor: "cursor",
    });
    expect(unknown.status).toBe(400);

    const succeed = await request(router, "POST", `/api/worker-runs/${runId}/succeed`, {
      summary: "Finished the slice",
      leaseToken: claimed.leaseToken,
      structuredOutcome: { testsPassed: 3 },
    });
    expect(succeed.status).toBe(200);
    const succeeded = (await succeed.json()) as {
      workerRun: { status: string };
      task: { status: string };
      report: { outcome: string };
      inboxItem: { kind: string };
    };
    expect(succeeded.workerRun.status).toBe("succeeded");
    expect(succeeded.task.status).toBe("awaiting_verification");
    expect(succeeded.report.outcome).toBe("success");
    expect(succeeded.inboxItem.kind).toBe("worker_report");
  });

  it("fails a claimed run via the fail route", async () => {
    const runId = await dispatchedRunId();
    const claim = await request(router, "POST", `/api/worker-runs/${runId}/claim`, {
      ownerId: "owner-api",
    });
    const claimed = (await claim.json()) as { leaseToken: string };
    const fail = await request(router, "POST", `/api/worker-runs/${runId}/fail`, {
      errorCode: "TIMEOUT",
      summary: "Worker timed out",
      leaseToken: claimed.leaseToken,
    });
    expect(fail.status).toBe(200);
    const body = (await fail.json()) as {
      workerRun: { status: string; errorMessage: string };
      task: { status: string };
    };
    expect(body.workerRun.status).toBe("failed");
    expect(body.task.status).toBe("failed");
    expect(body.workerRun.errorMessage).toContain("TIMEOUT");
  });

  it("cancels a queued run", async () => {
    const runId = await dispatchedRunId();
    const cancel = await request(router, "POST", `/api/worker-runs/${runId}/cancel`, {
      reason: "no_longer_needed",
    });
    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as {
      workerRun: { status: string };
      task: { status: string };
    };
    expect(body.workerRun.status).toBe("cancelled");
    expect(body.task.status).toBe("cancelled");
    expect(syncStore.getTask("task-exec-api")?.status).toBe("cancelled");
  });
});

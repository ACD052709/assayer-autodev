import { beforeEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import { InMemoryEvidenceBlobStore, evidenceBlobKey } from "../src/evidence/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const TEST_TOKEN = "test-service-token";
const BASE = "http://localhost";

function createHarness() {
  const syncStore = createInMemoryStateStore();
  const store = asAsyncStore(syncStore);
  const blobs = new InMemoryEvidenceBlobStore();
  const router = createApiRouter({
    deps: { store, blobs },
    auth: { serviceToken: TEST_TOKEN, production: false },
  });
  return { router, store, syncStore, blobs };
}

async function request(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  const headers: Record<string, string> = {
    authorization: `Bearer ${TEST_TOKEN}`,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  init.headers = headers;
  return router(new Request(`${BASE}${path}`, init));
}

describe("API router", () => {
  let router: ReturnType<typeof createApiRouter>;
  let syncStore: ReturnType<typeof createInMemoryStateStore>;
  let blobs: InMemoryEvidenceBlobStore;

  beforeEach(() => {
    const harness = createHarness();
    router = harness.router;
    syncStore = harness.syncStore;
    blobs = harness.blobs;
  });

  it("returns health status", async () => {
    const res = await router(new Request(`${BASE}/health`, { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("creates a project and returns state", async () => {
    const create = await request(router, "POST", "/api/projects", {
      id: "proj-api",
      name: "API Project",
      description: "Via HTTP",
    });
    expect(create.status).toBe(201);

    const state = await request(router, "GET", "/api/projects/proj-api/state");
    expect(state.status).toBe(200);
    const body = (await state.json()) as { project: { id: string }; masterState: { status: string } };
    expect(body.project.id).toBe("proj-api");
    expect(body.masterState.status).toBe("initializing");
  });

  it("configures target and promotion policy for an existing project", async () => {
    await request(router, "POST", "/api/projects", {
      id: "proj-target",
      name: "Target",
      description: "Target config",
    });

    const configured = await request(router, "POST", "/api/projects/proj-target/target-config", {
      targetRepository: "owner/repo",
      targetRef: "smoke",
      targetTestCommand: "node --test",
      promotionRepository: "owner/repo",
      promotionRefPrefix: "autodev",
      doNotModifyConstraints: ["Do not touch production"],
    });
    expect(configured.status).toBe(200);
    const body = (await configured.json()) as { project: { promotionRepository?: string; promotionRefPrefix?: string } };
    expect(body.project.promotionRepository).toBe("owner/repo");
    expect(body.project.promotionRefPrefix).toBe("autodev");

    const rejected = await request(router, "POST", "/api/projects/proj-target/target-config", {
      targetRepository: "owner/repo",
      promotionRepository: "other/repo",
    });
    expect(rejected.status).toBe(400);
  });

  it("persists requirements and tasks", async () => {
    await request(router, "POST", "/api/projects", {
      id: "proj-rt",
      name: "RT",
      description: "Test",
    });

    const req = await request(router, "POST", "/api/requirements", {
      id: "req-1",
      projectId: "proj-rt",
      title: "Must work",
      description: "Requirement body",
      priority: 1,
    });
    expect(req.status).toBe(201);

    const task = await request(router, "POST", "/api/tasks", {
      id: "task-1",
      projectId: "proj-rt",
      title: "Build",
      description: "Implement",
      kind: "implementation",
    });
    expect(task.status).toBe(201);

    const tasks = await request(router, "GET", "/api/projects/proj-rt/tasks");
    const tasksBody = (await tasks.json()) as { tasks: { id: string }[] };
    expect(tasksBody.tasks).toHaveLength(1);

    const one = await request(router, "GET", "/api/tasks/task-1");
    expect(one.status).toBe(200);
  });

  it("persists task dependencies via store layer", async () => {
    await request(router, "POST", "/api/projects", { id: "proj-dep", name: "D", description: "D" });
    await request(router, "POST", "/api/tasks", {
      id: "task-a",
      projectId: "proj-dep",
      title: "A",
      description: "Task A",
      kind: "implementation",
    });
    await request(router, "POST", "/api/tasks", {
      id: "task-b",
      projectId: "proj-dep",
      title: "B",
      description: "Task A",
      kind: "verification",
    });

    const dep = syncStore.addTaskDependency({ taskId: "task-b", dependsOnTaskId: "task-a" });
    expect(dep.dependsOnTaskId).toBe("task-a");
    expect(syncStore.listTaskDependencies("task-b")).toHaveLength(1);
  });

  it("persists worker events and reports", async () => {
    await request(router, "POST", "/api/projects", { id: "proj-w", name: "W", description: "W" });
    await request(router, "POST", "/api/tasks", {
      id: "task-w",
      projectId: "proj-w",
      title: "Work",
      description: "Task A",
      kind: "implementation",
    });
    await request(router, "POST", "/api/worker-runs", {
      id: "run-1",
      projectId: "proj-w",
      taskId: "task-w",
      workerKind: "cursor_acp",
    });

    const evt = await request(router, "POST", "/api/worker-events", {
      id: "evt-1",
      projectId: "proj-w",
      taskId: "task-w",
      workerRunId: "run-1",
      eventType: "log",
      message: "Working",
    });
    expect(evt.status).toBe(201);

    const report = await request(router, "POST", "/api/worker-reports", {
      id: "rep-1",
      projectId: "proj-w",
      taskId: "task-w",
      workerRunId: "run-1",
      summary: "Done",
      outcome: "success",
    });
    expect(report.status).toBe(201);
  });

  it("separates evidence metadata from blob storage", async () => {
    await request(router, "POST", "/api/projects", { id: "proj-ev", name: "E", description: "E" });
    await request(router, "POST", "/api/tasks", {
      id: "task-ev",
      projectId: "proj-ev",
      title: "Ev",
      description: "Task A",
      kind: "verification",
    });

    const payload = Buffer.from("screenshot-bytes").toString("base64");
    const res = await request(router, "POST", "/api/evidence", {
      id: "ev-1",
      projectId: "proj-ev",
      taskId: "task-ev",
      kind: "screenshot",
      label: "Homepage",
      mimeType: "image/png",
      blobBase64: payload,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { evidence: { contentRef?: string; uri?: string } };
    expect(body.evidence.contentRef).toBe(evidenceBlobKey("proj-ev", "ev-1"));
    expect(body.evidence.uri).toBeUndefined();
    expect(await blobs.exists(body.evidence.contentRef!)).toBe(true);

    const listed = await request(router, "GET", "/api/tasks/task-ev/evidence");
    const listedBody = (await listed.json()) as { evidence: unknown[] };
    expect(listedBody.evidence).toHaveLength(1);
  });

  it("records verifier PASS, FAIL, and INCONCLUSIVE outcomes", async () => {
    await request(router, "POST", "/api/projects", { id: "proj-v", name: "V", description: "V" });
    await request(router, "POST", "/api/tasks", {
      id: "task-v",
      projectId: "proj-v",
      title: "Verify",
      description: "Task A",
      kind: "verification",
    });

    for (const outcome of ["PASS", "FAIL", "INCONCLUSIVE"] as const) {
      const id = `ver-${outcome}`;
      const create = await request(router, "POST", "/api/verifier-runs", {
        id,
        projectId: "proj-v",
        taskId: "task-v",
      });
      expect(create.status).toBe(201);

      const complete = await request(router, "POST", "/api/verifier-runs", {
        id,
        projectId: "proj-v",
        taskId: "task-v",
        outcome,
        summary: `Result ${outcome}`,
      });
      expect(complete.status).toBe(201);
      const body = (await complete.json()) as { verifierRun: { outcome: string } };
      expect(body.verifierRun.outcome).toBe(outcome);
    }
  });

  it("orders master inbox by receivedAt descending", async () => {
    await request(router, "POST", "/api/projects", { id: "proj-in", name: "I", description: "I" });

    const first = await request(router, "POST", "/api/master/inbox", {
      id: "in-1",
      projectId: "proj-in",
      kind: "task_update",
      subject: "First",
      body: "One",
    });
    expect(first.status).toBe(201);
    await new Promise((r) => setTimeout(r, 5));
    const second = await request(router, "POST", "/api/master/inbox", {
      id: "in-2",
      projectId: "proj-in",
      kind: "worker_report",
      subject: "Second",
      body: "Two",
    });
    expect(second.status).toBe(201);

    const res = await request(router, "GET", "/api/master/inbox?projectId=proj-in");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.id).toBe("in-2");
    expect(body.items[1]?.id).toBe("in-1");
  });

  it("persists budget ledger via store layer", async () => {
    await request(router, "POST", "/api/projects", { id: "proj-b", name: "B", description: "B" });
    syncStore.initializeBudgetLedger({
      projectId: "proj-b",
      limits: [{ kind: "soft", category: "llm_tokens", maxAmount: 100, unit: "tokens" }],
    });
    syncStore.recordBudgetEntry({
      id: "be-1",
      projectId: "proj-b",
      category: "llm_tokens",
      amount: 40,
      unit: "tokens",
    });
    const check = syncStore.checkBudget("proj-b", "llm_tokens");
    expect(check.allowed).toBe(true);
  });

  it("rejects malformed requests with JSON error envelope", async () => {
    const badEnum = await request(router, "POST", "/api/projects", {
      id: "proj-bad",
      name: "Bad",
      description: "Bad",
      extra: true,
    });
    expect(badEnum.status).toBe(400);
    const body = (await badEnum.json()) as { error: { code: string; details?: unknown[] } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details).toBeTruthy();

    await request(router, "POST", "/api/projects", { id: "proj-task-bad", name: "T", description: "T" });
    const badTask = await request(router, "POST", "/api/tasks", {
      id: "task-bad",
      projectId: "proj-task-bad",
      title: "X",
      description: "X",
      kind: "not_a_real_kind",
    });
    expect(badTask.status).toBe(400);

    const badId = await request(router, "POST", "/api/projects", {
      id: "bad id with spaces",
      name: "X",
      description: "X",
    });
    expect(badId.status).toBe(400);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import {
  createGitHubLaunchBridge,
  createWorkerDispatcher,
  MAX_ASSIGNMENTS_LIMIT,
} from "../src/dispatch/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import { createSequentialIdFactory } from "../src/master/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const TEST_TOKEN = "test-service-token";
const BASE = "http://localhost";
const PROJECT_ID = "proj-dispatch-api";

function createHarness() {
  const syncStore = createInMemoryStateStore();
  const store = asAsyncStore(syncStore);
  const blobs = new InMemoryEvidenceBlobStore();
  const taskDispatcher = createWorkerDispatcher({
    store,
    idFactory: createSequentialIdFactory(),
  });
  const router = createApiRouter({
    deps: { store, blobs, taskDispatcher },
    auth: { serviceToken: TEST_TOKEN, production: false },
  });
  return { router, syncStore };
}

async function request(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TEST_TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return router(new Request(`${BASE}${path}`, init));
}

describe("Dispatch API", () => {
  let router: ReturnType<typeof createApiRouter>;
  let syncStore: ReturnType<typeof createInMemoryStateStore>;

  beforeEach(async () => {
    const harness = createHarness();
    router = harness.router;
    syncStore = harness.syncStore;
    await request(router, "POST", "/api/projects", {
      id: PROJECT_ID,
      name: "Dispatch",
      description: "API",
    });
    await request(router, "POST", "/api/tasks", {
      id: "task-api-a",
      projectId: PROJECT_ID,
      title: "A",
      description: "A",
      kind: "implementation",
    });
    await request(router, "POST", "/api/tasks", {
      id: "task-api-b",
      projectId: PROJECT_ID,
      title: "B",
      description: "B",
      kind: "implementation",
    });
  });

  it("dispatches eligible tasks and exposes worker runs", async () => {
    const dispatch = await request(router, "POST", `/api/projects/${PROJECT_ID}/dispatch`, {
      maxAssignments: 2,
    });
    expect(dispatch.status).toBe(200);
    const body = (await dispatch.json()) as {
      assignments: { task: { id: string; status: string; assignedWorkerRunId: string }; workerRun: { id: string } }[];
    };
    expect(body.assignments).toHaveLength(2);
    expect(body.assignments[0]!.task.status).toBe("assigned");
    expect(body.assignments[0]!.task.assignedWorkerRunId).toBe(body.assignments[0]!.workerRun.id);

    const dispatchBody = body as typeof body & {
      launches: { workerRunId: string; launched: boolean; skipped?: boolean }[];
    };
    expect(dispatchBody.launches).toHaveLength(2);
    expect(dispatchBody.launches.every((launch) => launch.launched === false)).toBe(true);
    expect(dispatchBody.launches.every((launch) => launch.skipped === true)).toBe(true);

    const listed = await request(router, "GET", `/api/projects/${PROJECT_ID}/worker-runs`);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { workerRuns: { id: string; projectId: string }[] };
    expect(listedBody.workerRuns).toHaveLength(2);
    expect(listedBody.workerRuns.every((run) => run.projectId === PROJECT_ID)).toBe(true);

    const one = await request(router, "GET", `/api/worker-runs/${body.assignments[0]!.workerRun.id}`);
    expect(one.status).toBe(200);
    const oneBody = (await one.json()) as { workerRun: { id: string } };
    expect(oneBody.workerRun.id).toBe(body.assignments[0]!.workerRun.id);
  });

  it("rejects unknown dispatch fields and unsafe maxAssignments", async () => {
    const unknown = await request(router, "POST", `/api/projects/${PROJECT_ID}/dispatch`, {
      maxAssignments: 1,
      executor: "cursor",
    });
    expect(unknown.status).toBe(400);

    const tooHigh = await request(router, "POST", `/api/projects/${PROJECT_ID}/dispatch`, {
      maxAssignments: MAX_ASSIGNMENTS_LIMIT + 1,
    });
    expect(tooHigh.status).toBe(400);
  });

  it("launches GitHub Actions when a launch bridge is configured", async () => {
    const calls: string[] = [];
    const launchBridge = createGitHubLaunchBridge(
      {
        token: "ghs_test",
        repository: "ACD052709/assayer-autodev",
        workflowFile: "autodev-worker.yml",
        ref: "main",
        executionMode: "synthetic-noop",
      },
      async (url) => {
        calls.push(String(url));
        return new Response(null, { status: 204 });
      },
    );
    const syncStore = createInMemoryStateStore();
    const store = asAsyncStore(syncStore);
    const router = createApiRouter({
      deps: {
        store,
        blobs: new InMemoryEvidenceBlobStore(),
        taskDispatcher: createWorkerDispatcher({
          store,
          idFactory: createSequentialIdFactory(),
          launchBridge,
        }),
      },
      auth: { serviceToken: TEST_TOKEN, production: false },
    });
    await request(router, "POST", "/api/projects", {
      id: "proj-launch",
      name: "Launch",
      description: "Launch",
    });
    await request(router, "POST", "/api/tasks", {
      id: "task-launch",
      projectId: "proj-launch",
      title: "Launch",
      description: "Launch",
      kind: "implementation",
    });

    const dispatch = await request(router, "POST", "/api/projects/proj-launch/dispatch", {
      maxAssignments: 1,
    });
    expect(dispatch.status).toBe(200);
    const body = (await dispatch.json()) as {
      assignments: { workerRun: { id: string } }[];
      launches: { workerRunId: string; launched: boolean }[];
    };
    expect(body.launches).toHaveLength(1);
    expect(body.launches[0]!.workerRunId).toBe(body.assignments[0]!.workerRun.id);
    expect(body.launches[0]!.launched).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("requires Master/control-plane write auth for dispatch", async () => {
    const unauth = await request(router, "POST", `/api/projects/${PROJECT_ID}/dispatch`, { maxAssignments: 1 }, null);
    expect(unauth.status).toBe(401);
  });

  it("enqueues inbox items when a worker report is posted", async () => {
    const dispatch = await request(router, "POST", `/api/projects/${PROJECT_ID}/dispatch`, {
      maxAssignments: 1,
    });
    const dispatched = (await dispatch.json()) as {
      assignments: { workerRun: { id: string }; task: { id: string } }[];
    };
    const assignment = dispatched.assignments[0]!;
    const report = await request(router, "POST", "/api/worker-reports", {
      id: "rep-api-1",
      projectId: PROJECT_ID,
      taskId: assignment.task.id,
      workerRunId: assignment.workerRun.id,
      summary: "Done",
      outcome: "success",
    });
    expect(report.status).toBe(201);
    const reportBody = (await report.json()) as {
      report: { id: string };
      inboxItem: { kind: string; relatedEntityId: string };
      created: boolean;
    };
    expect(reportBody.created).toBe(true);
    expect(reportBody.inboxItem.kind).toBe("worker_report");
    expect(reportBody.inboxItem.relatedEntityId).toBe("rep-api-1");

    const inbox = syncStore.listMasterInbox(PROJECT_ID);
    expect(inbox).toHaveLength(1);
    expect(syncStore.getTask(assignment.task.id)?.status).toBe("assigned");
  });
});

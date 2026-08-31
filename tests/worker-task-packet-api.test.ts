import { beforeEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import { createWorkerDispatcher } from "../src/dispatch/index.js";
import { createWorkerRunLifecycle } from "../src/executor/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import { createSequentialIdFactory } from "../src/master/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const TEST_TOKEN = "test-service-token";
const BASE = "http://localhost";
const PROJECT_ID = "proj-task-packet";

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

function approveRequirement(
  syncStore: ReturnType<typeof createInMemoryStateStore>,
  requirementId: string,
): void {
  const requirement = syncStore.getRequirement(requirementId);
  if (requirement === undefined) {
    throw new Error(`Requirement not found: ${requirementId}`);
  }
  Object.assign(requirement, { status: "approved" });
}

describe("Worker task packet API", () => {
  let router: ReturnType<typeof createApiRouter>;
  let syncStore: ReturnType<typeof createInMemoryStateStore>;

  beforeEach(async () => {
    const harness = createHarness();
    router = harness.router;
    syncStore = harness.syncStore;

    await request(router, "POST", "/api/projects", {
      id: PROJECT_ID,
      name: "Packet",
      description: "Packet project",
      targetRepository: "ACD052709/assayer",
      targetRef: "main",
      doNotModifyConstraints: ["production/**", ".github/workflows/deploy.yml"],
    });
    await request(router, "POST", "/api/requirements", {
      id: "req-approved",
      projectId: PROJECT_ID,
      title: "Approved req",
      description: "Must ship",
    });
    await request(router, "POST", "/api/requirements", {
      id: "req-draft",
      projectId: PROJECT_ID,
      title: "Draft req",
      description: "Ignore me",
    });
    approveRequirement(syncStore, "req-approved");
    await request(router, "POST", "/api/tasks", {
      id: "task-packet-a",
      projectId: PROJECT_ID,
      title: "Implement slice",
      description: "Bounded coding objective",
      kind: "implementation",
    });
    await request(router, "POST", "/api/tasks", {
      id: "task-packet-b",
      projectId: PROJECT_ID,
      title: "Second slice",
      description: "Another task",
      kind: "implementation",
    });
    await request(router, "POST", `/api/projects/${PROJECT_ID}/release-contract`, {
      id: "rc-1",
      version: 1,
      requiredEvidenceKinds: ["log"],
      requiredEvidenceLabels: ["test"],
      acceptanceCriteria: [
        {
          id: "ac-1",
          description: "Tests pass",
          requirementIds: ["req-approved"],
          applicable: true,
        },
      ],
    });
    syncStore.createBlocker({
      id: "blk-open",
      projectId: PROJECT_ID,
      kind: "dependency",
      summary: "Open blocker",
    });
    syncStore.createBlocker({
      id: "blk-resolved",
      projectId: PROJECT_ID,
      kind: "other",
      summary: "Resolved blocker",
    });
    syncStore.resolveBlocker("blk-resolved");
  });

  async function claimRun(taskId = "task-packet-a"): Promise<{ runId: string; leaseToken: string }> {
    const dispatch = await request(router, "POST", `/api/projects/${PROJECT_ID}/dispatch`, {
      maxAssignments: 1,
    });
    const body = (await dispatch.json()) as {
      assignments: { workerRun: { id: string }; task: { id: string } }[];
    };
    expect(body.assignments[0]!.task.id).toBe(taskId);
    const runId = body.assignments[0]!.workerRun.id;
    const claim = await request(router, "POST", `/api/worker-runs/${runId}/claim`, {
      ownerId: "owner-packet",
    });
    const claimed = (await claim.json()) as { leaseToken: string };
    return { runId, leaseToken: claimed.leaseToken };
  }

  it("returns a bounded packet for a claimed worker run", async () => {
    const { runId, leaseToken } = await claimRun();
    const packetRes = await request(
      router,
      "GET",
      `/api/worker-runs/${runId}/task-packet?leaseToken=${encodeURIComponent(leaseToken)}`,
    );
    expect(packetRes.status).toBe(200);
    const body = (await packetRes.json()) as {
      packet: {
        workerRunId: string;
        taskId: string;
        projectId: string;
        task: { title: string; description: string };
        requirements: { id: string; status: string }[];
        acceptanceCriteria: { id: string }[];
        releaseContract: { version: number };
        blockers: { id: string; status: string }[];
        doNotModifyConstraints: string[];
        targetRepository: string;
        targetRef: string;
        execution: { iteration: number; status: string; ownerId: string };
      };
    };
    expect(body.packet.workerRunId).toBe(runId);
    expect(body.packet.taskId).toBe("task-packet-a");
    expect(body.packet.projectId).toBe(PROJECT_ID);
    expect(body.packet.task.title).toBe("Implement slice");
    expect(body.packet.task.description).toBe("Bounded coding objective");
    expect(body.packet.requirements.map((r) => r.id)).toEqual(["req-approved"]);
    expect(body.packet.acceptanceCriteria.map((c) => c.id)).toEqual(["ac-1"]);
    expect(body.packet.releaseContract.version).toBe(1);
    expect(body.packet.blockers.map((b) => b.id)).toEqual(["blk-open"]);
    expect(body.packet.doNotModifyConstraints).toEqual([
      "production/**",
      ".github/workflows/deploy.yml",
    ]);
    expect(body.packet.targetRepository).toBe("ACD052709/assayer");
    expect(body.packet.targetRef).toBe("main");
    expect(body.packet.execution.iteration).toBe(1);
    expect(body.packet.execution.status).toBe("running");
    expect(body.packet.execution.ownerId).toBe("owner-packet");
  });

  it("rejects unauthorized requests", async () => {
    const { runId, leaseToken } = await claimRun();
    const unauth = await request(
      router,
      "GET",
      `/api/worker-runs/${runId}/task-packet?leaseToken=${encodeURIComponent(leaseToken)}`,
      undefined,
      null,
    );
    expect(unauth.status).toBe(401);
  });

  it("rejects unrelated worker runs without a valid lease", async () => {
    const first = await claimRun("task-packet-a");
    const second = await claimRun("task-packet-b");
    const wrongLease = await request(
      router,
      "GET",
      `/api/worker-runs/${second.runId}/task-packet?leaseToken=${encodeURIComponent(first.leaseToken)}`,
    );
    expect(wrongLease.status).toBe(403);

    const missingLease = await request(router, "GET", `/api/worker-runs/${first.runId}/task-packet`);
    expect(missingLease.status).toBe(400);
  });

  it("returns not found for missing worker runs", async () => {
    const missing = await request(
      router,
      "GET",
      `/api/worker-runs/wrun-missing/task-packet?leaseToken=${"a".repeat(64)}`,
    );
    expect(missing.status).toBe(404);
  });
});

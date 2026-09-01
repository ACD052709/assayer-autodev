import { beforeEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import { sha256Hex } from "../src/security/checksum.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const TOKEN = "test-service-token";
const BASE = "http://localhost";
const REPO = "ACD052709/assayer-autodev-coding-smoke";
const PATCH = "diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n@@ -1 +1 @@\n-old\n+new\n";

function createHarness() {
  const syncStore = createInMemoryStateStore();
  const store = asAsyncStore(syncStore);
  const blobs = new InMemoryEvidenceBlobStore();
  const router = createApiRouter({
    deps: { store, blobs },
    auth: { serviceToken: TOKEN, production: false },
  });
  syncStore.createProject({
    id: "proj-cand",
    name: "Candidate",
    description: "Candidate",
    targetRepository: REPO,
    targetRef: "main",
  });
  syncStore.createTask({
    id: "task-cand",
    projectId: "proj-cand",
    title: "Candidate",
    description: "Candidate",
    kind: "implementation",
  });
  syncStore.assignTaskToWorkerRun({
    id: "wrun-cand",
    projectId: "proj-cand",
    taskId: "task-cand",
    workerKind: "generic",
  });
  syncStore.updateWorkerRunStatus("wrun-cand", "running");
  return { router, blobs };
}

async function post(router: ReturnType<typeof createApiRouter>, body: Record<string, unknown>) {
  return router(new Request(`${BASE}/api/code-candidates`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }));
}

function payload() {
  return {
    id: "cand-task-cand-wrun-cand",
    projectId: "proj-cand",
    taskId: "task-cand",
    workerRunId: "wrun-cand",
    sourceRepository: REPO,
    sourceRef: "main",
    baseCommitSha: "a".repeat(40),
    changedFiles: ["math.js"],
    patchChecksumSha256: sha256Hex(PATCH),
    patchBase64: Buffer.from(PATCH, "utf8").toString("base64"),
    testCommand: "node --test math.test.js",
    testExitCode: 0,
  };
}

describe("code candidate API", () => {
  let router: ReturnType<typeof createApiRouter>;

  beforeEach(() => {
    ({ router } = createHarness());
  });

  it("persists an immutable checksummed candidate and supports idempotent replay", async () => {
    const first = await post(router, payload());
    expect(first.status).toBe(201);
    const second = await post(router, payload());
    expect(second.status).toBe(200);

    const patch = await router(new Request(`${BASE}/api/code-candidates/cand-task-cand-wrun-cand/patch`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    expect(patch.status).toBe(200);
    expect(await patch.text()).toBe(PATCH);
  });

  it("fails closed on candidate mutation, wrong target, or checksum mismatch", async () => {
    expect((await post(router, payload())).status).toBe(201);
    expect((await post(router, { ...payload(), changedFiles: ["other.js"] })).status).toBe(409);

    const wrongTargetHarness = createHarness();
    expect((await post(wrongTargetHarness.router, { ...payload(), sourceRepository: "owner/other" })).status).toBe(409);

    const checksumHarness = createHarness();
    expect((await post(checksumHarness.router, { ...payload(), patchChecksumSha256: "b".repeat(64) })).status).toBe(400);
  });
});

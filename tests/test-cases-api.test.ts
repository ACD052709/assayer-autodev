import { beforeEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
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

describe("Test cases API", () => {
  let router: ReturnType<typeof createApiRouter>;

  beforeEach(async () => {
    router = createHarness().router;
    await request(router, "POST", "/api/projects", {
      id: "proj-tc",
      name: "Test cases",
      description: "API",
    });
    await request(router, "POST", "/api/tasks", {
      id: "task-tc",
      projectId: "proj-tc",
      title: "Verify",
      description: "Browser verification task",
      kind: "verification",
    });
  });

  it("registers a browser test case", async () => {
    const res = await request(router, "POST", "/api/test-cases", {
      id: "tc-browser-1",
      projectId: "proj-tc",
      taskId: "task-tc",
      name: "Home page loads",
      description: "Checks fixture home page",
      kind: "browser",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { testCase: { id: string; kind: string; status: string } };
    expect(body.testCase.id).toBe("tc-browser-1");
    expect(body.testCase.kind).toBe("browser");
    expect(body.testCase.status).toBe("active");
  });

  it("rejects unknown fields and invalid kinds", async () => {
    const unknown = await request(router, "POST", "/api/test-cases", {
      id: "tc-bad",
      projectId: "proj-tc",
      name: "Bad",
      description: "Bad",
      kind: "browser",
      steps: [],
    });
    expect(unknown.status).toBe(400);

    const badKind = await request(router, "POST", "/api/test-cases", {
      id: "tc-bad-kind",
      projectId: "proj-tc",
      name: "Bad",
      description: "Bad",
      kind: "not-a-kind",
    });
    expect(badKind.status).toBe(400);
  });

  it("returns idempotent success for identical duplicate registration", async () => {
    const payload = {
      id: "tc-dup",
      projectId: "proj-tc",
      taskId: "task-tc",
      name: "Dup",
      description: "Dup",
      kind: "browser" as const,
    };
    const first = await request(router, "POST", "/api/test-cases", payload);
    const second = await request(router, "POST", "/api/test-cases", payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
  });

  it("conflicts when reusing an id with different fields", async () => {
    await request(router, "POST", "/api/test-cases", {
      id: "tc-conflict",
      projectId: "proj-tc",
      name: "One",
      description: "One",
      kind: "browser",
    });
    const conflict = await request(router, "POST", "/api/test-cases", {
      id: "tc-conflict",
      projectId: "proj-tc",
      name: "Two",
      description: "Two",
      kind: "browser",
    });
    expect(conflict.status).toBe(409);
  });

  it("requires authenticated verifier write access", async () => {
    const res = await request(
      router,
      "POST",
      "/api/test-cases",
      {
        id: "tc-auth",
        projectId: "proj-tc",
        name: "Auth",
        description: "Auth",
        kind: "browser",
      },
      null,
    );
    expect(res.status).toBe(401);
  });
});

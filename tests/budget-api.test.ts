import { beforeEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import {
  FakeMasterModelClient,
  createMasterOrchestrator,
  createSequentialIdFactory,
} from "../src/master/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const TEST_TOKEN = "test-service-token";
const BASE = "http://localhost";
const PROJECT_ID = "proj-budget";

function decision() {
  return {
    action: "CREATE_TASKS",
    rationale: "Create work",
    claimedFinished: false,
    humanApprovalReason: "",
    blockerSummaries: [],
    taskProposals: [
      {
        clientKey: "impl",
        title: "Implement",
        description: "Do the work",
        kind: "implementation",
        dependencyClientKeys: [],
        existingDependencyIds: [],
      },
    ],
  };
}

function createHarness(options?: { returnUsage?: boolean }) {
  const syncStore = createInMemoryStateStore();
  const store = asAsyncStore(syncStore);
  const blobs = new InMemoryEvidenceBlobStore();
  const client = new FakeMasterModelClient(async () => ({
    output: decision(),
    model: "fake-master",
    ...(options?.returnUsage ? { inputTokens: 100, outputTokens: 50 } : {}),
  }));
  const masterOrchestrator = createMasterOrchestrator({
    store,
    client,
    idFactory: createSequentialIdFactory(),
  });
  const router = createApiRouter({
    deps: { store, blobs, masterOrchestrator },
    auth: { serviceToken: TEST_TOKEN, production: false },
  });
  return { router, syncStore, client };
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

describe("Budget API", () => {
  let router: ReturnType<typeof createApiRouter>;
  let client: FakeMasterModelClient;

  beforeEach(async () => {
    const harness = createHarness({ returnUsage: true });
    router = harness.router;
    client = harness.client;
    await request(router, "POST", "/api/projects", {
      id: PROJECT_ID,
      name: "Budget API",
      description: "Operate Master from HTTP budget",
    });
  });

  it("requires service auth on budget routes", async () => {
    const responses = await Promise.all([
      request(router, "POST", `/api/projects/${PROJECT_ID}/budgets`, {
        resourceType: "llm_tokens",
        hardLimit: 1_000_000,
        unit: "tokens",
      }, null),
      request(router, "GET", `/api/projects/${PROJECT_ID}/budgets`, undefined, null),
      request(router, "GET", `/api/projects/${PROJECT_ID}/budgets/llm_tokens`, undefined, null),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
    }
  });

  it("creates an llm_tokens budget, authorizes Master, and records usage", async () => {
    const created = await request(router, "POST", `/api/projects/${PROJECT_ID}/budgets`, {
      resourceType: "llm_tokens",
      hardLimit: 1_000_000,
      softLimit: 800_000,
      unit: "tokens",
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      budget: {
        id: string;
        remainingHardLimit: number;
        consumedAmount: number;
        reservedAmount: number;
      };
    };
    expect(createdBody.budget.id).toBe("llm_tokens");
    expect(createdBody.budget.consumedAmount).toBe(0);
    expect(createdBody.budget.reservedAmount).toBe(0);
    expect(createdBody.budget.remainingHardLimit).toBe(1_000_000);

    const run = await request(router, "POST", "/api/master/run", { projectId: PROJECT_ID });
    expect(run.status).toBe(201);
    const runBody = (await run.json()) as { run: { enforcedAction: string; createdTaskIds: string[] } };
    expect(runBody.run.enforcedAction).toBe("CREATE_TASKS");
    expect(runBody.run.createdTaskIds).toHaveLength(1);
    expect(client.calls).toHaveLength(1);

    const budget = await request(router, "GET", `/api/projects/${PROJECT_ID}/budgets/llm_tokens`);
    expect(budget.status).toBe(200);
    const budgetBody = (await budget.json()) as {
      budget: { consumedAmount: number; remainingHardLimit: number; entries: { amount: number }[] };
    };
    expect(budgetBody.budget.consumedAmount).toBe(150);
    expect(budgetBody.budget.remainingHardLimit).toBe(1_000_000 - 150);
    expect(budgetBody.budget.entries).toHaveLength(1);
  });

  it("rejects malformed budget creation", async () => {
    const cases: unknown[] = [
      { resourceType: "not_a_type", hardLimit: 10, unit: "tokens" },
      { resourceType: "llm_tokens", hardLimit: 0, unit: "tokens" },
      { resourceType: "llm_tokens", hardLimit: -1, unit: "tokens" },
      { resourceType: "llm_tokens", hardLimit: Number.NaN, unit: "tokens" },
      { resourceType: "llm_tokens", hardLimit: Number.POSITIVE_INFINITY, unit: "tokens" },
      { resourceType: "llm_tokens", hardLimit: 10, unit: "usd" },
      { resourceType: "llm_tokens", hardLimit: 10, softLimit: 11, unit: "tokens" },
      { resourceType: "llm_tokens", hardLimit: 10, unit: "tokens", OPENAI_API_KEY: "nope" },
      { resourceType: "llm_tokens", hardLimit: 10, unit: "tokens", AUTODEV_SERVICE_TOKEN: "nope" },
      { resourceType: "llm_tokens", hardLimit: 10, unit: "tokens", inputPerMillion: 5 },
    ];
    for (const body of cases) {
      const res = await request(router, "POST", `/api/projects/${PROJECT_ID}/budgets`, body);
      expect(res.status).toBe(400);
    }
  });

  it("rejects a duplicate active llm_tokens budget deterministically", async () => {
    const first = await request(router, "POST", `/api/projects/${PROJECT_ID}/budgets`, {
      resourceType: "llm_tokens",
      hardLimit: 1000,
      unit: "tokens",
    });
    expect(first.status).toBe(201);
    const second = await request(router, "POST", `/api/projects/${PROJECT_ID}/budgets`, {
      resourceType: "llm_tokens",
      hardLimit: 2000,
      unit: "tokens",
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
  });

  it("does not let a compute budget authorize a Master LLM call", async () => {
    const created = await request(router, "POST", `/api/projects/${PROJECT_ID}/budgets`, {
      resourceType: "compute",
      hardLimit: 60,
      unit: "minutes",
    });
    expect(created.status).toBe(201);
    const run = await request(router, "POST", "/api/master/run", { projectId: PROJECT_ID });
    expect(run.status).toBe(201);
    const body = (await run.json()) as { run: { finishedBlockedReasons: string[] } };
    expect(client.calls).toHaveLength(0);
    expect(body.run.finishedBlockedReasons).toContain("budget_unavailable");
  });
});

describe("Dollar budget checkpoint API", () => {
  it("creates, charges, and increases llm_cost_usd without losing prior usage", async () => {
    const { router } = createHarness();
    await request(router, "POST", "/api/projects", {
      id: "proj-dollar-budget",
      name: "Dollar budget",
      description: "Checkpoint spending",
    });

    const created = await request(router, "POST", "/api/projects/proj-dollar-budget/budgets", {
      resourceType: "llm_cost_usd",
      hardLimit: 10,
      softLimit: 8,
      unit: "usd",
    });
    expect(created.status).toBe(201);

    const charged = await request(router, "POST", "/api/projects/proj-dollar-budget/budget-entries", {
      id: "budg-coding-run-1",
      resourceType: "llm_cost_usd",
      amount: 1.25,
      unit: "usd",
      description: "codex:gpt-5.6-luna",
    });
    expect(charged.status).toBe(201);

    const replay = await request(router, "POST", "/api/projects/proj-dollar-budget/budget-entries", {
      id: "budg-coding-run-1",
      resourceType: "llm_cost_usd",
      amount: 1.25,
      unit: "usd",
      description: "codex:gpt-5.6-luna",
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { created: boolean }).created).toBe(false);

    const increased = await request(
      router,
      "POST",
      "/api/projects/proj-dollar-budget/budgets/llm_cost_usd/increase",
      { additionalAmount: 5 },
    );
    expect(increased.status).toBe(200);
    const body = (await increased.json()) as {
      budget: { hardLimit: number; consumedAmount: number; remainingHardLimit: number };
    };
    expect(body.budget.hardLimit).toBe(15);
    expect(body.budget.consumedAmount).toBe(1.25);
    expect(body.budget.remainingHardLimit).toBe(13.75);
  });

  it("rejects the wrong unit for llm_cost_usd", async () => {
    const { router } = createHarness();
    await request(router, "POST", "/api/projects", {
      id: "proj-dollar-unit",
      name: "Dollar unit",
      description: "Unit validation",
    });
    const res = await request(router, "POST", "/api/projects/proj-dollar-unit/budgets", {
      resourceType: "llm_cost_usd",
      hardLimit: 10,
      unit: "tokens",
    });
    expect(res.status).toBe(400);
  });
});

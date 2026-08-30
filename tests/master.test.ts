import { describe, expect, it, vi } from "vitest";
import type { MasterDecision } from "../src/domain/index.js";
import {
  FakeMasterModelClient,
  MasterModelConfigError,
  OpenAIMasterModelClient,
  createMasterOrchestrator,
  createSequentialIdFactory,
  evaluateFinishedGate,
  validateMasterDecision,
  MasterOutputValidationError,
} from "../src/master/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const PROJECT_ID = "proj-master";

function validDecision(overrides: Partial<MasterDecision> = {}): MasterDecision {
  return {
    action: "CREATE_TASKS",
    rationale: "Need implementation work",
    claimedFinished: false,
    humanApprovalReason: "",
    blockerSummaries: [],
    taskProposals: [
      {
        clientKey: "impl",
        title: "Implement feature",
        description: "Build the feature",
        kind: "implementation",
        dependencyClientKeys: [],
        existingDependencyIds: [],
      },
    ],
    ...overrides,
  };
}

function finishedDecision(): MasterDecision {
  return validDecision({
    action: "FINISHED",
    claimedFinished: true,
    rationale: "Model claims done",
    taskProposals: [],
  });
}

async function seedProject(store: ReturnType<typeof createInMemoryStateStore>) {
  store.createProject({
    id: PROJECT_ID,
    name: "Master Project",
    description: "Ship a verified feature",
  });
  store.initializeBudgetLedger({
    projectId: PROJECT_ID,
    limits: [{ kind: "hard", category: "llm_tokens", maxAmount: 1_000_000, unit: "tokens" }],
  });
}

describe("master output validation", () => {
  it("rejects malformed model output", () => {
    expect(() => validateMasterDecision(null)).toThrow(MasterOutputValidationError);
    expect(() => validateMasterDecision({ action: "NOPE" })).toThrow(MasterOutputValidationError);
    expect(() =>
      validateMasterDecision({
        ...validDecision(),
        claimedFinished: true,
      }),
    ).toThrow(/claimedFinished/);
    expect(() =>
      validateMasterDecision({
        ...validDecision({ action: "CREATE_TASKS", taskProposals: [] }),
      }),
    ).toThrow(/CREATE_TASKS/);
    expect(() =>
      validateMasterDecision({
        ...validDecision(),
        extra: true,
      }),
    ).toThrow(/Unknown field/);
  });
});

describe("MasterOrchestrator", () => {
  it("creates durable tasks from a fake master model", async () => {
    const sync = createInMemoryStateStore();
    await seedProject(sync);
    const client = new FakeMasterModelClient(async () => ({
      output: validDecision(),
      model: "fake-master",
    }));
    const orchestrator = createMasterOrchestrator({
      store: asAsyncStore(sync),
      client,
      idFactory: createSequentialIdFactory(),
    });

    const run = await orchestrator.run({ projectId: PROJECT_ID, trigger: "start" });
    expect(run.enforcedAction).toBe("CREATE_TASKS");
    expect(run.createdTaskIds).toHaveLength(1);
    expect(sync.listTasksByProject(PROJECT_ID)).toHaveLength(1);
    expect(sync.listMasterRunsByProject(PROJECT_ID)).toHaveLength(1);
    expect(sync.listMasterInbox(PROJECT_ID).some((item) => item.kind === "master_decision")).toBe(true);
    expect(client.calls).toHaveLength(1);
  });

  it("persists dependency-safe parallel task proposals", async () => {
    const sync = createInMemoryStateStore();
    await seedProject(sync);
    const client = new FakeMasterModelClient(async () => ({
      output: validDecision({
        taskProposals: [
          {
            clientKey: "a",
            title: "Task A",
            description: "Independent A",
            kind: "implementation",
            dependencyClientKeys: [],
            existingDependencyIds: [],
          },
          {
            clientKey: "b",
            title: "Task B",
            description: "Independent B",
            kind: "implementation",
            dependencyClientKeys: [],
            existingDependencyIds: [],
          },
          {
            clientKey: "c",
            title: "Task C",
            description: "Depends on A and B",
            kind: "verification",
            dependencyClientKeys: ["a", "b"],
            existingDependencyIds: [],
          },
        ],
      }),
      model: "fake-master",
    }));
    const orchestrator = createMasterOrchestrator({
      store: asAsyncStore(sync),
      client,
      idFactory: createSequentialIdFactory(),
    });

    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(run.createdTaskIds).toHaveLength(3);
    const tasks = sync.listTasksByProject(PROJECT_ID);
    const byTitle = new Map(tasks.map((t) => [t.title, t]));
    const taskC = byTitle.get("Task C");
    expect(taskC?.dependencyIds).toHaveLength(2);
    expect(sync.listTaskDependencies(taskC!.id)).toHaveLength(2);
    const independent = [byTitle.get("Task A")!, byTitle.get("Task B")!];
    expect(independent.every((t) => t.dependencyIds.length === 0)).toBe(true);
  });

  it("does not create tasks when structured output is invalid", async () => {
    const sync = createInMemoryStateStore();
    await seedProject(sync);
    const client = new FakeMasterModelClient(async () => ({
      output: { action: "CREATE_TASKS" },
      model: "fake-master",
    }));
    const orchestrator = createMasterOrchestrator({
      store: asAsyncStore(sync),
      client,
    });

    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(run.status).toBe("rejected");
    expect(run.enforcedAction).toBe("BLOCKED");
    expect(sync.listTasksByProject(PROJECT_ID)).toHaveLength(0);
  });

  it("blocks the model call when budget is exhausted", async () => {
    const sync = createInMemoryStateStore();
    sync.createProject({
      id: PROJECT_ID,
      name: "Budget",
      description: "Budgeted",
    });
    sync.initializeBudgetLedger({
      projectId: PROJECT_ID,
      limits: [{ kind: "hard", category: "llm_tokens", maxAmount: 10, unit: "tokens" }],
    });
    sync.recordBudgetEntry({
      id: "spent",
      projectId: PROJECT_ID,
      category: "llm_tokens",
      amount: 10,
      unit: "tokens",
    });
    const client = new FakeMasterModelClient(async () => ({
      output: validDecision(),
      model: "fake-master",
    }));
    const orchestrator = createMasterOrchestrator({
      store: asAsyncStore(sync),
      client,
    });

    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(client.calls).toHaveLength(0);
    expect(run.enforcedAction).toBe("BLOCKED");
    expect(run.finishedBlockedReasons).toContain("hard_limit_exceeded");
    expect(sync.listTasksByProject(PROJECT_ID)).toHaveLength(0);
  });

  it("blocks when no budget ledger exists", async () => {
    const sync = createInMemoryStateStore();
    sync.createProject({ id: PROJECT_ID, name: "No budget", description: "None" });
    const client = new FakeMasterModelClient(async () => ({
      output: validDecision(),
      model: "fake-master",
    }));
    const orchestrator = createMasterOrchestrator({ store: asAsyncStore(sync), client });
    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(client.calls).toHaveLength(0);
    expect(run.enforcedAction).toBe("BLOCKED");
    expect(run.finishedBlockedReasons).toContain("budget_unavailable");
  });

  it("blocks when remaining hard limit is below the estimated call", async () => {
    const sync = createInMemoryStateStore();
    sync.createProject({ id: PROJECT_ID, name: "Small", description: "Small budget" });
    sync.addBudgetResource({
      projectId: PROJECT_ID,
      resourceType: "llm_tokens",
      hardLimit: 5000,
      unit: "tokens",
    });
    const client = new FakeMasterModelClient(async () => ({
      output: validDecision(),
      model: "fake-master",
    }));
    const orchestrator = createMasterOrchestrator({ store: asAsyncStore(sync), client });
    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(client.calls).toHaveLength(0);
    expect(run.finishedBlockedReasons).toContain("hard_limit_exceeded");
  });

  it("does not let another project's budget authorize this project", async () => {
    const sync = createInMemoryStateStore();
    sync.createProject({ id: "proj-a", name: "A", description: "A" });
    sync.createProject({ id: PROJECT_ID, name: "B", description: "B" });
    sync.addBudgetResource({
      projectId: "proj-a",
      resourceType: "llm_tokens",
      hardLimit: 1_000_000,
      unit: "tokens",
    });
    const client = new FakeMasterModelClient(async () => ({
      output: validDecision(),
      model: "fake-master",
    }));
    const orchestrator = createMasterOrchestrator({ store: asAsyncStore(sync), client });
    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(client.calls).toHaveLength(0);
    expect(run.finishedBlockedReasons).toContain("budget_unavailable");
  });

  it("does not persist model blockerSummaries as authoritative blockers", async () => {
    const sync = createInMemoryStateStore();
    await seedProject(sync);
    const client = new FakeMasterModelClient(async () => ({
      output: validDecision({
        action: "BLOCKED",
        taskProposals: [],
        blockerSummaries: ["Model-invented blocker that must not become state"],
      }),
      model: "fake-master",
    }));
    const orchestrator = createMasterOrchestrator({ store: asAsyncStore(sync), client });
    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(run.enforcedAction).toBe("BLOCKED");
    expect(sync.listBlockersByProject(PROJECT_ID)).toHaveLength(0);
  });

  it("blocks FINISHED when acceptance criteria are not PASS", async () => {
    const sync = createInMemoryStateStore();
    await seedProject(sync);
    seedReleasePath(sync, { criteriaPass: false });
    const orchestrator = createMasterOrchestrator({
      store: asAsyncStore(sync),
      client: new FakeMasterModelClient(async () => ({ output: finishedDecision(), model: "fake-master" })),
    });
    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(run.proposedAction).toBe("FINISHED");
    expect(run.enforcedAction).toBe("BLOCKED");
    expect(run.finishedBlockedReasons.some((r) => r.startsWith("acceptance_criterion_not_pass"))).toBe(true);
    expect(sync.getOrCreateMasterState(PROJECT_ID).status).not.toBe("completed");
  });

  it("blocks FINISHED when an unresolved blocker exists", async () => {
    const sync = createInMemoryStateStore();
    await seedProject(sync);
    seedReleasePath(sync, { openBlocker: true });
    const orchestrator = createMasterOrchestrator({
      store: asAsyncStore(sync),
      client: new FakeMasterModelClient(async () => ({ output: finishedDecision(), model: "fake-master" })),
    });
    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(run.enforcedAction).toBe("BLOCKED");
    expect(run.finishedBlockedReasons).toContain("unresolved_blockers");
  });

  it("blocks FINISHED without independent verifier PASS", async () => {
    const sync = createInMemoryStateStore();
    await seedProject(sync);
    seedReleasePath(sync, { verifierPass: false });
    const orchestrator = createMasterOrchestrator({
      store: asAsyncStore(sync),
      client: new FakeMasterModelClient(async () => ({ output: finishedDecision(), model: "fake-master" })),
    });
    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(run.enforcedAction).toBe("BLOCKED");
    expect(run.finishedBlockedReasons).toContain("independent_verification_not_pass");
  });

  it("blocks FINISHED without final regression PASS", async () => {
    const sync = createInMemoryStateStore();
    await seedProject(sync);
    seedReleasePath(sync, { regressionPass: false });
    const orchestrator = createMasterOrchestrator({
      store: asAsyncStore(sync),
      client: new FakeMasterModelClient(async () => ({ output: finishedDecision(), model: "fake-master" })),
    });
    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(run.enforcedAction).toBe("BLOCKED");
    expect(run.finishedBlockedReasons.some((r) => r.startsWith("regression_not_pass") || r === "no_regression_results")).toBe(
      true,
    );
  });

  it("allows FINISHED only when the deterministic gate passes", async () => {
    const sync = createInMemoryStateStore();
    await seedProject(sync);
    seedReleasePath(sync, {});
    const orchestrator = createMasterOrchestrator({
      store: asAsyncStore(sync),
      client: new FakeMasterModelClient(async () => ({ output: finishedDecision(), model: "fake-master" })),
    });
    const run = await orchestrator.run({ projectId: PROJECT_ID });
    expect(run.enforcedAction).toBe("FINISHED");
    expect(run.finishedBlockedReasons).toEqual([]);
    expect(sync.getOrCreateMasterState(PROJECT_ID).status).toBe("completed");
  });
});

describe("evaluateFinishedGate", () => {
  it("is independent of model opinion", async () => {
    const sync = createInMemoryStateStore();
    await seedProject(sync);
    seedReleasePath(sync, { criteriaPass: false });
    const orchestrator = createMasterOrchestrator({
      store: asAsyncStore(sync),
      client: new FakeMasterModelClient(async () => ({ output: finishedDecision(), model: "fake-master" })),
    });
    await orchestrator.run({ projectId: PROJECT_ID });
    const input = {
      projectId: PROJECT_ID,
      objective: "x",
      project: sync.getProject(PROJECT_ID)!,
      masterState: sync.getOrCreateMasterState(PROJECT_ID),
      requirements: sync.listRequirementsByProject(PROJECT_ID),
      definitionsOfDone: sync.listDefinitionsOfDoneByProject(PROJECT_ID),
      tasks: sync.listTasksByProject(PROJECT_ID),
      verifierRuns: sync.listVerifierRunsByProject(PROJECT_ID),
      testCases: sync.listTestCasesByProject(PROJECT_ID),
      testResults: sync.listTestResultsByProject(PROJECT_ID),
      evidence: sync.listEvidenceByProject(PROJECT_ID),
      budget: sync.getBudgetLedger(PROJECT_ID),
      releaseContract: sync.getLatestReleaseContract(PROJECT_ID),
      acceptanceCriteria: sync.listAcceptanceCriteriaByProject(PROJECT_ID),
      blockers: sync.listBlockersByProject(PROJECT_ID),
      inbox: sync.listMasterInbox(PROJECT_ID),
    };
    const gate = evaluateFinishedGate(input);
    expect(gate.allowed).toBe(false);
  });
});

describe("OpenAIMasterModelClient", () => {
  it("fails closed when OPENAI_API_KEY is missing", () => {
    expect(() => new OpenAIMasterModelClient({ apiKey: undefined })).toThrow(MasterModelConfigError);
    expect(() => new OpenAIMasterModelClient({ apiKey: "" })).toThrow(MasterModelConfigError);
    expect(() => new OpenAIMasterModelClient({ apiKey: "   " })).toThrow(MasterModelConfigError);
  });

  it("never includes the API key in thrown errors", async () => {
    const secret = "sk-test-secret-value-not-real";
    const client = new OpenAIMasterModelClient({
      apiKey: secret,
      maxAttempts: 1,
      sleep: async () => {},
      fetchImpl: async () => {
        throw new Error(`upstream failed for ${secret}`);
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      client.complete({ systemPrompt: "secret-prompt-text", userPayload: { token: secret } }),
    ).rejects.toThrow();
    try {
      await client.complete({ systemPrompt: "secret-prompt-text", userPayload: { token: secret } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).not.toMatch(/sk-test/);
    }
    expect(String(errorSpy.mock.calls)).not.toContain(secret);
    expect(String(logSpy.mock.calls)).not.toContain("secret-prompt-text");
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("retries transient failures a bounded number of times", async () => {
    let attempts = 0;
    const client = new OpenAIMasterModelClient({
      apiKey: "sk-test-placeholder",
      maxAttempts: 3,
      sleep: async () => {},
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response("nope", { status: 503 });
        }
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify(validDecision({ action: "WAIT_FOR_WORKERS", taskProposals: [] })),
            usage: { input_tokens: 11, output_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await client.complete({ systemPrompt: "sys", userPayload: { ok: true } });
    expect(attempts).toBe(3);
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(7);
  });
});

function seedReleasePath(
  store: ReturnType<typeof createInMemoryStateStore>,
  options: {
    criteriaPass?: boolean;
    openBlocker?: boolean;
    verifierPass?: boolean;
    regressionPass?: boolean;
  },
): void {
  const criteriaPass = options.criteriaPass ?? true;
  const openBlocker = options.openBlocker ?? false;
  const verifierPass = options.verifierPass ?? true;
  const regressionPass = options.regressionPass ?? true;

  store.createRequirement({
    id: "req-1",
    projectId: PROJECT_ID,
    title: "Feature works",
    description: "Must work",
  });
  store.createReleaseContract({
    id: "rc-1",
    projectId: PROJECT_ID,
    version: 1,
    requiredEvidenceKinds: ["report"],
    requiredEvidenceLabels: ["final-report"],
  });
  store.createAcceptanceCriterion({
    id: "ac-1",
    projectId: PROJECT_ID,
    releaseContractId: "rc-1",
    description: "Feature accepted",
    requirementIds: ["req-1"],
  });
  if (criteriaPass) {
    store.updateAcceptanceCriterion({ id: "ac-1", status: "PASS", evidenceIds: ["ev-1"] });
  }
  if (openBlocker) {
    store.createBlocker({
      id: "blk-1",
      projectId: PROJECT_ID,
      kind: "requirement",
      summary: "Unresolved requirement",
    });
  }
  store.createTask({
    id: "task-accept",
    projectId: PROJECT_ID,
    title: "Final acceptance",
    description: "Independent verification",
    kind: "acceptance",
  });
  store.createVerifierRun({ id: "ver-final", projectId: PROJECT_ID, taskId: "task-accept" });
  if (verifierPass) {
    store.completeVerifierRun({ verifierRunId: "ver-final", outcome: "PASS", summary: "Independent pass" });
  }
  store.createTestCase({
    id: "tc-reg",
    projectId: PROJECT_ID,
    name: "Regression",
    description: "Final regression",
    kind: "regression",
  });
  store.recordTestResult({
    id: "tr-reg",
    projectId: PROJECT_ID,
    testCaseId: "tc-reg",
    outcome: regressionPass ? "PASS" : "FAIL",
  });
  store.createEvidence({
    id: "ev-1",
    projectId: PROJECT_ID,
    kind: "report",
    label: "final-report",
  });
}

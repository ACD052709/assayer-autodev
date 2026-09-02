import { beforeEach, describe, expect, it } from "vitest";
import type { MasterDecision } from "../src/domain/index.js";
import { codeCandidateIdForWorkerRun } from "../src/domain/code-candidate.js";
import { sha256Hex } from "../src/security/checksum.js";
import { createApiRouter } from "../src/api/index.js";
import { createWorkerDispatcher } from "../src/dispatch/index.js";
import { createWorkerRunLifecycle } from "../src/executor/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import {
  FakeMasterModelClient,
  createMasterOrchestrator,
  createSequentialIdFactory,
} from "../src/master/index.js";
import {
  createAutoDevOrchestrator,
  createDeterministicVerifierAdapter,
  parseRepairTaskContext,
  runOrchestrationCycle,
  DEFAULT_ORCHESTRATION_THRESHOLDS,
} from "../src/orchestrator/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const PROJECT_ID = "proj-orchestrator";
const IMPL_TASK_ID = "task-impl";
const TEST_TOKEN = "orch-token";
const THRESHOLDS = { ...DEFAULT_ORCHESTRATION_THRESHOLDS, maxRepairAttemptsPerTask: 3 };

type SyncStore = ReturnType<typeof createInMemoryStateStore>;

function createHarness(verifierOutcomes: Record<string, "PASS" | "FAIL"> = {}) {
  const syncStore = createInMemoryStateStore();
  const store = asAsyncStore(syncStore);
  const ids = createSequentialIdFactory();
  const taskDispatcher = createWorkerDispatcher({ store, idFactory: ids });
  const workerRunLifecycle = createWorkerRunLifecycle({ store, dispatcher: taskDispatcher });
  const verifierAdapter = createDeterministicVerifierAdapter({
    store,
    idFactory: ids,
    outcomesByTaskId: verifierOutcomes,
  });
  const autoDevOrchestrator = createAutoDevOrchestrator({
    store,
    verifierAdapter,
    idFactory: ids,
    taskDispatcher,
  });
  const router = createApiRouter({
    deps: {
      store,
      blobs: new InMemoryEvidenceBlobStore(),
      taskDispatcher,
      workerRunLifecycle,
      autoDevOrchestrator,
    },
    auth: { serviceToken: TEST_TOKEN, production: false },
  });

  return {
    syncStore,
    store,
    ids,
    taskDispatcher,
    workerRunLifecycle,
    autoDevOrchestrator,
    router,
  };
}

function seedProject(syncStore: SyncStore): void {
  syncStore.createProject({
    id: PROJECT_ID,
    name: "Orchestrator",
    description: "Part 6 loop",
    targetRepository: "example/repo",
  });

  syncStore.initializeBudgetLedger({
    projectId: PROJECT_ID,
    limits: [{ kind: "hard", category: "llm_tokens", maxAmount: 1_000_000, unit: "tokens" }],
  });

  syncStore.createTask({
    id: IMPL_TASK_ID,
    projectId: PROJECT_ID,
    title: "Implement feature",
    description: "Build the feature slice",
    kind: "implementation",
  });

  const testCaseId = `tc-verify-${IMPL_TASK_ID}`;

  syncStore.createTestCase({
    id: testCaseId,
    projectId: PROJECT_ID,
    taskId: IMPL_TASK_ID,
    name: "Implementation verification",
    description: "Deterministic browser verification",
    kind: "browser",
    browserSpecJson: JSON.stringify({
      version: 1,
      baseUrl: "http://127.0.0.1:4173/",
      cases: [
        {
          id: testCaseId,
          name: "Implementation verification",
          steps: [
            { action: "navigate", url: "/" },
            { action: "assertPageLoad" },
          ],
        },
      ],
    }),
  });
}

async function dispatchTaskOnly(
  harness: ReturnType<typeof createHarness>,
  taskId: string,
): Promise<string> {
  const before = harness.syncStore.getTask(taskId)?.assignedWorkerRunId;

  if (before !== undefined) {
    return before;
  }

  await harness.taskDispatcher.dispatch(PROJECT_ID, {
    maxAssignments: THRESHOLDS.maxDispatchAssignments,
  });

  const runId = harness.syncStore.getTask(taskId)?.assignedWorkerRunId;

  if (runId === undefined) {
    throw new Error(`Task ${taskId} was not dispatched`);
  }

  return runId;
}

async function syntheticWorkerSuccess(
  harness: ReturnType<typeof createHarness>,
  taskId: string,
): Promise<string> {
  const runId = await dispatchTaskOnly(harness, taskId);

  const claim = await harness.workerRunLifecycle.claim(runId, {
    ownerId: "synthetic-worker",
  });

  if (!claim.claimed) {
    throw new Error(`Failed to claim ${runId}`);
  }

  await harness.workerRunLifecycle.succeed(runId, {
    summary: "Synthetic worker completed",
    leaseToken: claim.leaseToken,
    structuredOutcome: { synthetic: true },
  });

  const task = harness.syncStore.getTask(taskId)!;
  const repairContext = parseRepairTaskContext(task.description);
  const patch = `diff --git a/${taskId}.txt b/${taskId}.txt\n`;

  harness.syncStore.createCodeCandidate({
    id: codeCandidateIdForWorkerRun(taskId, runId),
    projectId: PROJECT_ID,
    taskId,
    workerRunId: runId,
    sourceRepository: "example/repo",
    ...(repairContext?.parentCandidateId !== undefined
      ? { parentCandidateId: repairContext.parentCandidateId }
      : {}),
    baseCommitSha: "a".repeat(40),
    changedFiles: [`${taskId}.txt`],
    patchChecksumSha256: sha256Hex(patch),
    patchContentRef: `${PROJECT_ID}/candidates/${taskId}`,
    testCommand: "node --test",
    testExitCode: 0,
  });

  return runId;
}

function seedReleasePath(syncStore: SyncStore): void {
  syncStore.createRequirement({
    id: "req-1",
    projectId: PROJECT_ID,
    title: "Feature works",
    description: "Must work",
  });

  syncStore.createReleaseContract({
    id: "rc-1",
    projectId: PROJECT_ID,
    version: 1,
    requiredEvidenceKinds: ["report"],
    requiredEvidenceLabels: ["final-report"],
  });

  syncStore.createAcceptanceCriterion({
    id: "ac-1",
    projectId: PROJECT_ID,
    releaseContractId: "rc-1",
    description: "Feature accepted",
    requirementIds: ["req-1"],
  });

  syncStore.updateAcceptanceCriterion({
    id: "ac-1",
    status: "PASS",
    evidenceIds: ["ev-1"],
  });

  syncStore.createTask({
    id: "task-accept",
    projectId: PROJECT_ID,
    title: "Final acceptance",
    description: "Independent verification",
    kind: "acceptance",
  });

  syncStore.createVerifierRun({
    id: "ver-final",
    projectId: PROJECT_ID,
    taskId: "task-accept",
  });

  syncStore.completeVerifierRun({
    verifierRunId: "ver-final",
    outcome: "PASS",
    summary: "Independent pass",
  });

  syncStore.createTestCase({
    id: "tc-reg",
    projectId: PROJECT_ID,
    name: "Regression",
    description: "Final regression",
    kind: "regression",
  });

  syncStore.recordTestResult({
    id: "tr-reg",
    projectId: PROJECT_ID,
    testCaseId: "tc-reg",
    outcome: "PASS",
  });

  syncStore.createEvidence({
    id: "ev-1",
    projectId: PROJECT_ID,
    kind: "report",
    label: "final-report",
  });
}

describe("AutoDev orchestration loop", () => {
  beforeEach(() => {
    // fresh harness per test
  });

  it("A. happy path: worker success → verifier PASS → task completed", async () => {
    const harness = createHarness({ [IMPL_TASK_ID]: "PASS" });
    seedProject(harness.syncStore);

    await syntheticWorkerSuccess(harness, IMPL_TASK_ID);
    expect(harness.syncStore.getTask(IMPL_TASK_ID)?.status).toBe(
      "awaiting_verification",
    );

    const cycle = await runOrchestrationCycle(
      PROJECT_ID,
      {
        store: harness.store,
        verifierAdapter: createDeterministicVerifierAdapter({
          store: harness.store,
          idFactory: harness.ids,
          outcomesByTaskId: { [IMPL_TASK_ID]: "PASS" },
        }),
        idFactory: harness.ids,
        taskDispatcher: harness.taskDispatcher,
      },
      { runMasterReevaluation: false, runAudit: true },
    );

    expect(
      cycle.actions.some((action) => action.kind === "run_verifier"),
    ).toBe(true);

    expect(
      cycle.actions.some((action) => action.kind === "accept_verified_task"),
    ).toBe(true);

    expect(harness.syncStore.getTask(IMPL_TASK_ID)?.status).toBe("completed");

    const verifierRuns =
      harness.syncStore.listVerifierRunsByProject(PROJECT_ID);

    expect(verifierRuns.some((run) => run.outcome === "PASS")).toBe(true);

    expect(
      harness.syncStore
        .listTestResultsByProject(PROJECT_ID)
        .some((result) => result.outcome === "PASS"),
    ).toBe(true);
  });

  it("A. happy path: Master FINISHED gate passes after orchestrated completion", async () => {
    const harness = createHarness({ [IMPL_TASK_ID]: "PASS" });
    seedProject(harness.syncStore);
    seedReleasePath(harness.syncStore);

    await syntheticWorkerSuccess(harness, IMPL_TASK_ID);

    await runOrchestrationCycle(
      PROJECT_ID,
      {
        store: harness.store,
        verifierAdapter: createDeterministicVerifierAdapter({
          store: harness.store,
          idFactory: harness.ids,
          outcomesByTaskId: { [IMPL_TASK_ID]: "PASS" },
        }),
        idFactory: harness.ids,
        taskDispatcher: harness.taskDispatcher,
      },
      { runMasterReevaluation: false, runAudit: false },
    );

    const masterClient = new FakeMasterModelClient(async () => ({
      output: {
        action: "FINISHED",
        rationale: "All gates satisfied",
        claimedFinished: true,
        humanApprovalReason: "",
        blockerSummaries: [],
        taskProposals: [],
      } satisfies MasterDecision,
      model: "fake-master",
    }));

    const master = createMasterOrchestrator({
      store: harness.store,
      client: masterClient,
      idFactory: harness.ids,
    });

    const masterRun = await master.run({
      projectId: PROJECT_ID,
      trigger: "orchestration_complete",
    });

    expect(masterRun.enforcedAction).toBe("FINISHED");

    expect(
      harness.syncStore.getOrCreateMasterState(PROJECT_ID).status,
    ).toBe("completed");
  });

  it("B. repair path: verifier FAIL → repair → reverify PASS → original completed", async () => {
    let verifierOutcomes: Record<string, "PASS" | "FAIL"> = {
      [IMPL_TASK_ID]: "FAIL",
    };

    const harness = createHarness(verifierOutcomes);

    seedProject(harness.syncStore);
    await syntheticWorkerSuccess(harness, IMPL_TASK_ID);

    const failCycle = await runOrchestrationCycle(
      PROJECT_ID,
      {
        store: harness.store,
        verifierAdapter: createDeterministicVerifierAdapter({
          store: harness.store,
          idFactory: harness.ids,
          outcomesByTaskId: verifierOutcomes,
        }),
        idFactory: harness.ids,
        taskDispatcher: harness.taskDispatcher,
      },
      { runMasterReevaluation: false, runAudit: false },
    );

    expect(
      failCycle.actions.some(
        (action) => action.kind === "create_repair_task",
      ),
    ).toBe(true);

    const repairTask = harness.syncStore
      .listTasksByProject(PROJECT_ID)
      .find(
        (task) =>
          parseRepairTaskContext(task.description)?.originalTaskId ===
          IMPL_TASK_ID,
      );

    expect(repairTask).toBeDefined();

    expect(
      parseRepairTaskContext(repairTask!.description)?.originalTaskId,
    ).toBe(IMPL_TASK_ID);

    verifierOutcomes = { [IMPL_TASK_ID]: "PASS" };

    await syntheticWorkerSuccess(harness, repairTask!.id);

    const closeCycle = await runOrchestrationCycle(
      PROJECT_ID,
      {
        store: harness.store,
        verifierAdapter: createDeterministicVerifierAdapter({
          store: harness.store,
          idFactory: harness.ids,
          outcomesByTaskId: verifierOutcomes,
        }),
        idFactory: harness.ids,
        taskDispatcher: harness.taskDispatcher,
      },
      { runMasterReevaluation: false, runAudit: false },
    );

    expect(closeCycle.actions.map((action) => action.kind)).toContain(
      "accept_repair_task",
    );

    expect(closeCycle.actions.map((action) => action.kind)).toContain(
      "run_verifier",
    );

    expect(closeCycle.actions.map((action) => action.kind)).toContain(
      "accept_verified_task",
    );

    expect(harness.syncStore.getTask(IMPL_TASK_ID)?.status).toBe("completed");
    expect(harness.syncStore.getTask(repairTask!.id)?.status).toBe(
      "completed",
    );
  });

  it("C. repair exhaustion: limit reached → blocked/failed with no further repair tasks", async () => {
    const harness = createHarness({ [IMPL_TASK_ID]: "FAIL" });
    seedProject(harness.syncStore);

    await syntheticWorkerSuccess(harness, IMPL_TASK_ID);

    const adapter = () =>
      createDeterministicVerifierAdapter({
        store: harness.store,
        idFactory: harness.ids,
        outcomesByTaskId: { [IMPL_TASK_ID]: "FAIL" },
      });

    await runOrchestrationCycle(
      PROJECT_ID,
      {
        store: harness.store,
        verifierAdapter: adapter(),
        idFactory: harness.ids,
        taskDispatcher: harness.taskDispatcher,
      },
      {
        runMasterReevaluation: false,
        runAudit: false,
        thresholds: THRESHOLDS,
      },
    );

    const repair1 = harness.syncStore
      .listTasksByProject(PROJECT_ID)
      .find((task) => task.id === `task-repair-${IMPL_TASK_ID}-1`);

    expect(repair1).toBeDefined();

    await syntheticWorkerSuccess(harness, repair1!.id);

    await runOrchestrationCycle(
      PROJECT_ID,
      {
        store: harness.store,
        verifierAdapter: adapter(),
        idFactory: harness.ids,
        taskDispatcher: harness.taskDispatcher,
      },
      {
        runMasterReevaluation: false,
        runAudit: false,
        thresholds: THRESHOLDS,
      },
    );

    const repair2 = harness.syncStore
      .listTasksByProject(PROJECT_ID)
      .find((task) => task.id === `task-repair-${IMPL_TASK_ID}-2`);

    expect(repair2).toBeDefined();

    await syntheticWorkerSuccess(harness, repair2!.id);

    await runOrchestrationCycle(
      PROJECT_ID,
      {
        store: harness.store,
        verifierAdapter: adapter(),
        idFactory: harness.ids,
        taskDispatcher: harness.taskDispatcher,
      },
      {
        runMasterReevaluation: false,
        runAudit: false,
        thresholds: THRESHOLDS,
      },
    );

    const repair3 = harness.syncStore
      .listTasksByProject(PROJECT_ID)
      .find((task) => task.id === `task-repair-${IMPL_TASK_ID}-3`);

    expect(repair3).toBeDefined();
    expect(parseRepairTaskContext(repair3!.description)?.attempt).toBe(3);

    await syntheticWorkerSuccess(harness, repair3!.id);

    const exhaustCycle = await runOrchestrationCycle(
      PROJECT_ID,
      {
        store: harness.store,
        verifierAdapter: adapter(),
        idFactory: harness.ids,
        taskDispatcher: harness.taskDispatcher,
      },
      {
        runMasterReevaluation: false,
        runAudit: false,
        thresholds: THRESHOLDS,
      },
    );

    expect(
      exhaustCycle.actions.some(
        (action) => action.kind === "repair_exhausted",
      ),
    ).toBe(true);

    expect(harness.syncStore.getTask(IMPL_TASK_ID)?.status).toBe("failed");

    expect(
      harness.syncStore
        .listBlockersByProject(PROJECT_ID)
        .some((blocker) => blocker.status === "open"),
    ).toBe(true);

    const repairCount = harness.syncStore
      .listTasksByProject(PROJECT_ID)
      .filter(
        (task) =>
          parseRepairTaskContext(task.description)?.originalTaskId ===
          IMPL_TASK_ID,
      ).length;

    expect(repairCount).toBe(3);

    await runOrchestrationCycle(
      PROJECT_ID,
      {
        store: harness.store,
        verifierAdapter: adapter(),
        idFactory: harness.ids,
        taskDispatcher: harness.taskDispatcher,
      },
      {
        runMasterReevaluation: false,
        runAudit: false,
        thresholds: THRESHOLDS,
      },
    );

    expect(
      harness.syncStore
        .listTasksByProject(PROJECT_ID)
        .filter(
          (task) =>
            parseRepairTaskContext(task.description)?.originalTaskId ===
            IMPL_TASK_ID,
        ).length,
    ).toBe(3);
  });

  it("D. idempotency: rerun cycle on unchanged state creates no duplicate work", async () => {
    const harness = createHarness({ [IMPL_TASK_ID]: "PASS" });
    seedProject(harness.syncStore);
    await syntheticWorkerSuccess(harness, IMPL_TASK_ID);

    const adapter = createDeterministicVerifierAdapter({
      store: harness.store,
      idFactory: harness.ids,
      outcomesByTaskId: { [IMPL_TASK_ID]: "PASS" },
    });

    const options = {
      store: harness.store,
      verifierAdapter: adapter,
      idFactory: harness.ids,
      taskDispatcher: harness.taskDispatcher,
    };

    await runOrchestrationCycle(PROJECT_ID, options, {
      runMasterReevaluation: false,
      runAudit: false,
    });

    const workerRunsAfterFirst =
      harness.syncStore.listWorkerRunsByProject(PROJECT_ID).length;

    const verifierRunsAfterFirst =
      harness.syncStore.listVerifierRunsByProject(PROJECT_ID).length;

    const testCasesAfterFirst =
      harness.syncStore.listTestCasesByProject(PROJECT_ID).length;

    const second = await runOrchestrationCycle(PROJECT_ID, options, {
      runMasterReevaluation: false,
      runAudit: false,
    });

    expect(
      second.actions.filter((action) => action.kind === "dispatch"),
    ).toHaveLength(0);

    expect(
      second.actions.filter((action) => action.kind === "run_verifier"),
    ).toHaveLength(0);

    expect(
      second.actions.filter(
        (action) => action.kind === "create_repair_task",
      ),
    ).toHaveLength(0);

    expect(
      harness.syncStore.listWorkerRunsByProject(PROJECT_ID).length,
    ).toBe(workerRunsAfterFirst);

    expect(
      harness.syncStore.listVerifierRunsByProject(PROJECT_ID).length,
    ).toBe(verifierRunsAfterFirst);

    expect(
      harness.syncStore.listTestCasesByProject(PROJECT_ID).length,
    ).toBe(testCasesAfterFirst);
  });

  it("E. watchdog visibility: audit reports bad state without mutating project tasks", async () => {
    const harness = createHarness();
    seedProject(harness.syncStore);

    harness.syncStore.createWorkerRun({
      id: "run-dup-1",
      projectId: PROJECT_ID,
      taskId: IMPL_TASK_ID,
      workerKind: "generic",
    });

    harness.syncStore.createWorkerRun({
      id: "run-dup-2",
      projectId: PROJECT_ID,
      taskId: IMPL_TASK_ID,
      workerKind: "generic",
    });

    const tasksBefore =
      harness.syncStore.listTasksByProject(PROJECT_ID).length;

    const cycle = await runOrchestrationCycle(
      PROJECT_ID,
      {
        store: harness.store,
        verifierAdapter: createDeterministicVerifierAdapter({
          store: harness.store,
          idFactory: harness.ids,
          outcomesByTaskId: {},
        }),
        idFactory: harness.ids,
        taskDispatcher: harness.taskDispatcher,
      },
      { runMasterReevaluation: false, runAudit: true },
    );

    expect(cycle.auditActiveCount).toBeGreaterThan(0);

    expect(
      cycle.actions.some((action) => action.kind === "audit"),
    ).toBe(true);

    expect(
      harness.syncStore.listTasksByProject(PROJECT_ID).length,
    ).toBe(tasksBefore);

    expect(
      harness.syncStore
        .listAuditFindingsByProject(PROJECT_ID)
        .some(
          (finding) =>
            finding.ruleCode === "DUPLICATE_ACTIVE_WORK",
        ),
    ).toBe(true);
  });

  it("invokes orchestrate API route", async () => {
    const harness = createHarness();
    seedProject(harness.syncStore);

    const response = await harness.router(
      new Request(
        `http://localhost/api/projects/${PROJECT_ID}/orchestrate`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runMasterReevaluation: false,
          }),
        },
      ),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      projectId: string;
      phase: string;
    };

    expect(body.projectId).toBe(PROJECT_ID);
    expect(body.phase).toBeDefined();
  });
});

describe("repair prompt contract", () => {
  it("includes verifier failure evidence in coding-task prompt", async () => {
    const { buildCodingTaskPrompt } = await import(
      "../src/actuator/coding-task-prompt.js"
    );

    const prompt = buildCodingTaskPrompt({
      workerRunId: "run-repair",
      taskId: "task-repair-1",
      projectId: PROJECT_ID,
      task: {
        id: "task-repair-1",
        title: "Repair feature",
        description:
          'Fix the bug\n<!--autodev-repair:{"originalTaskId":"task-impl","verifierRunId":"ver-1","attempt":1,"failureSummary":"assertion failed"}-->',
        kind: "implementation",
        status: "in_progress",
      },
      requirements: [],
      acceptanceCriteria: [],
      blockers: [],
      doNotModifyConstraints: [],
      execution: {
        workerKind: "generic",
        iteration: 1,
        status: "running",
      },
    });

    expect(prompt).toContain("Repair scope");
    expect(prompt).toContain("task-impl");
    expect(prompt).toContain("assertion failed");
    expect(prompt).not.toContain("<!--autodev-repair:");
  });
});

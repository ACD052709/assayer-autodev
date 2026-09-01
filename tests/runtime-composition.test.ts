import { describe, expect, it } from "vitest";
import type { WorkerLaunchRecord } from "../src/dispatch/github-launch-bridge.js";
import { createWorkerRunLifecycle } from "../src/executor/index.js";
import { createSequentialIdFactory } from "../src/master/index.js";
import {
  createControlPlaneComposition,
  createDeterministicVerifierAdapter,
  createSchedulingVerifierAdapter,
  runOrchestrationCycle,
  testCaseIdForTask,
} from "../src/orchestrator/index.js";
import type {
  VerifierLaunchInput,
  VerifierLaunchRecord,
} from "../src/orchestrator/verifier-launch-bridge.js";
import {
  asAsyncStore,
  createInMemoryStateStore,
} from "../src/state/index.js";
import { codeCandidateIdForWorkerRun } from "../src/domain/code-candidate.js";
import { sha256Hex } from "../src/security/checksum.js";

const PROJECT_ID = "proj-runtime";
const TASK_ID = "task-runtime";

function createHarness() {
  const syncStore = createInMemoryStateStore();
  const store = asAsyncStore(syncStore);
  const ids = createSequentialIdFactory();
  const implementationLaunches: WorkerLaunchRecord[] = [];
  const verifierLaunches: VerifierLaunchInput[] = [];

  const composition = createControlPlaneComposition({
    store,
    env: {},
    implementationLaunchBridge: {
      async launch(workerRunId) {
        const record: WorkerLaunchRecord = {
          workerRunId,
          launched: true,
        };
        implementationLaunches.push(record);
        return record;
      },
    },
    verifierLaunchBridge: {
      async launch(input) {
        verifierLaunches.push(input);
        const record: VerifierLaunchRecord = {
          verifierRunId: input.verifierRunId,
          launched: true,
        };
        return record;
      },
    },
  });

  const lifecycle = createWorkerRunLifecycle({
    store,
    dispatcher: composition.taskDispatcher,
  });

  const schedulingAdapter = createSchedulingVerifierAdapter({
    store,
    launchBridge: composition.verifierLaunchBridge,
  });

  return {
    syncStore,
    store,
    ids,
    composition,
    lifecycle,
    schedulingAdapter,
    implementationLaunches,
    verifierLaunches,
  };
}

async function dispatchAndSucceed(
  harness: ReturnType<typeof createHarness>,
  taskId: string,
): Promise<string> {
  await harness.composition.taskDispatcher.dispatch(PROJECT_ID, {
    maxAssignments: 1,
  });

  const runId = harness.syncStore.getTask(taskId)?.assignedWorkerRunId;
  if (runId === undefined) {
    throw new Error(`Task ${taskId} not dispatched`);
  }

  const claim = await harness.lifecycle.claim(runId, {
    ownerId: "runtime-test",
  });

  await harness.lifecycle.succeed(runId, {
    summary: "Synthetic success",
    leaseToken: claim.leaseToken,
  });

  const patch = "diff --git a/example.txt b/example.txt\n";

  harness.syncStore.createCodeCandidate({
    id: codeCandidateIdForWorkerRun(taskId, runId),
    projectId: PROJECT_ID,
    taskId,
    workerRunId: runId,
    sourceRepository: "example/repo",
    baseCommitSha: "a".repeat(40),
    changedFiles: ["example.txt"],
    patchChecksumSha256: sha256Hex(patch),
    patchContentRef: `${PROJECT_ID}/candidates/${taskId}`,
    testCommand: "node --test",
    testExitCode: 0,
  });

  const testCaseId = testCaseIdForTask(taskId);

  if (harness.syncStore.getTestCase(testCaseId) === undefined) {
    harness.syncStore.createTestCase({
      id: testCaseId,
      projectId: PROJECT_ID,
      taskId,
      name: "Verification",
      description: "Deterministic browser verification",
      kind: "browser",
      browserSpecJson: JSON.stringify({
        version: 1,
        baseUrl: "http://127.0.0.1:4173/",
        cases: [
          {
            id: testCaseId,
            name: "Verification",
            steps: [
              { action: "navigate", url: "/" },
              { action: "assertPageLoad" },
            ],
          },
        ],
      }),
    });
  }

  return runId;
}

describe("control plane runtime composition", () => {
  it("schedules implementation execution exactly once per eligible task", async () => {
    const harness = createHarness();

    harness.syncStore.createProject({
      id: PROJECT_ID,
      name: "Runtime",
      description: "Runtime",
    });

    harness.syncStore.createTask({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Implement",
      description: "Slice",
      kind: "implementation",
    });

    const cycleOptions = {
      runMasterReevaluation: false,
      runAudit: false,
    } as const;

    const cycleDeps = {
      store: harness.store,
      verifierAdapter: createDeterministicVerifierAdapter({
        store: harness.store,
        idFactory: harness.ids,
        outcomesByTaskId: {},
      }),
      taskDispatcher: harness.composition.taskDispatcher,
      idFactory: harness.ids,
    };

    await runOrchestrationCycle(PROJECT_ID, cycleDeps, cycleOptions);

    expect(harness.implementationLaunches).toHaveLength(1);
    expect(harness.verifierLaunches).toHaveLength(0);

    await runOrchestrationCycle(PROJECT_ID, cycleDeps, cycleOptions);

    expect(harness.implementationLaunches).toHaveLength(1);
  });

  it("schedules independent verifier exactly once for awaiting_verification tasks", async () => {
    const harness = createHarness();

    harness.syncStore.createProject({
      id: PROJECT_ID,
      name: "Runtime",
      description: "Runtime",
    });

    harness.syncStore.createTask({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Implement",
      description: "Slice",
      kind: "implementation",
    });

    await dispatchAndSucceed(harness, TASK_ID);

    const cycleDeps = {
      store: harness.store,
      verifierAdapter: harness.schedulingAdapter,
      taskDispatcher: harness.composition.taskDispatcher,
      idFactory: harness.ids,
    };

    const cycleOptions = {
      runMasterReevaluation: false,
      runAudit: false,
    } as const;

    const cycle = await runOrchestrationCycle(
      PROJECT_ID,
      cycleDeps,
      cycleOptions,
    );

    expect(
      cycle.actions.some((action) => action.kind === "schedule_verifier"),
    ).toBe(true);

    expect(harness.verifierLaunches).toHaveLength(1);
    expect(harness.verifierLaunches[0]!.taskId).toBe(TASK_ID);

    expect(
      harness.syncStore.getVerifierRun(
        harness.verifierLaunches[0]!.verifierRunId,
      )?.status,
    ).toBe("pending");

    const second = await runOrchestrationCycle(
      PROJECT_ID,
      cycleDeps,
      cycleOptions,
    );

    expect(
      second.actions.some((action) => action.kind === "schedule_verifier"),
    ).toBe(false);

    expect(harness.verifierLaunches).toHaveLength(1);
  });

  it("continues acceptance after async verifier completion is persisted", async () => {
    const harness = createHarness();

    harness.syncStore.createProject({
      id: PROJECT_ID,
      name: "Runtime",
      description: "Runtime",
      targetRepository: "example/repo",
    });

    harness.syncStore.createTask({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Implement",
      description: "Slice",
      kind: "implementation",
    });

    const workerRunId = await dispatchAndSucceed(harness, TASK_ID);

    const cycleDeps = {
      store: harness.store,
      verifierAdapter: harness.schedulingAdapter,
      taskDispatcher: harness.composition.taskDispatcher,
      idFactory: harness.ids,
    };

    const cycleOptions = {
      runMasterReevaluation: false,
      runAudit: false,
    } as const;

    await runOrchestrationCycle(PROJECT_ID, cycleDeps, cycleOptions);

    const verifierRunId = harness.verifierLaunches[0]!.verifierRunId;
    const testCaseId = testCaseIdForTask(TASK_ID);

    await harness.store.createEvidence({
      id: "ev-async",
      projectId: PROJECT_ID,
      kind: "report",
      label: "async-verifier-report",
      taskId: TASK_ID,
      verifierRunId,
    });

    await harness.store.recordTestResult({
      id: "tr-async",
      projectId: PROJECT_ID,
      testCaseId,
      taskId: TASK_ID,
      workerRunId,
      verifierRunId,
      outcome: "PASS",
      durationMs: 5,
    });

    await harness.store.completeVerifierRun({
      verifierRunId,
      outcome: "PASS",
      summary: "Async browser verification passed",
      evidenceIds: ["ev-async"],
    });

    const resume = await runOrchestrationCycle(
      PROJECT_ID,
      cycleDeps,
      cycleOptions,
    );

    expect(
      resume.actions.some(
        (action) => action.kind === "accept_verified_task",
      ),
    ).toBe(true);

    expect(harness.syncStore.getTask(TASK_ID)?.status).toBe("completed");
    expect(harness.verifierLaunches).toHaveLength(1);
  });
});

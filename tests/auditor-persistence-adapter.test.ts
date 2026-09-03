import { describe, expect, it } from "vitest";
import { reconstructProjectTaskLifecycles } from "../src/auditor/persisted-lifecycle.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const PROJECT_ID = "autodev-evidence-adapter";
const TASK_ID = "task-autodev-e2e-pass-retry-20260902-07";
const RUN_ID = "wrun-1b628f35-d857-4488-a82b-df11fd80e5e5";

function seedProject() {
  const store = createInMemoryStateStore();
  store.createProject({
    id: PROJECT_ID,
    name: "Evidence adapter",
    description: "Persisted lifecycle reconstruction",
  });
  store.createTask({
    id: TASK_ID,
    projectId: PROJECT_ID,
    title: "Repair disposable math smoke test",
    description: "Disposable control task",
    kind: "implementation",
  });
  store.createWorkerRun({
    id: RUN_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    workerKind: "generic",
    iteration: 1,
  });
  return store;
}

describe("persisted lifecycle adapter", () => {
  it("reconstructs retry-07-shaped persisted failure evidence without inventing a deeper cause", async () => {
    const store = seedProject();

    store.updateWorkerRunStatus(RUN_ID, "running");
    store.appendWorkerEvent({
      id: `wevt-started-${RUN_ID}`,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerRunId: RUN_ID,
      eventType: "started",
      message: "WORKER_RUN_STARTED",
      payload: {
        lifecycle: "WORKER_RUN_STARTED",
        fromStatus: "queued",
        toStatus: "running",
        taskStatus: "in_progress",
      },
    });

    store.updateWorkerRunStatus(
      RUN_ID,
      "failed",
      "REPOSITORY_TESTS_FAILED: Trusted repository tests failed (exit 1)",
    );
    store.updateTaskStatus(TASK_ID, "failed");

    store.appendWorkerEvent({
      id: `wevt-failed-${RUN_ID}`,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerRunId: RUN_ID,
      eventType: "error",
      message: "WORKER_RUN_FAILED",
      payload: {
        lifecycle: "WORKER_RUN_FAILED",
        fromStatus: "running",
        toStatus: "failed",
        taskStatus: "failed",
        errorCode: "REPOSITORY_TESTS_FAILED",
      },
    });

    store.createWorkerReport({
      id: `wrep-${RUN_ID}`,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerRunId: RUN_ID,
      outcome: "failure",
      summary: "Trusted repository tests failed (exit 1)",
    });

    const audits = await reconstructProjectTaskLifecycles(
      asAsyncStore(store),
      PROJECT_ID,
    );

    const audit = audits.find((item) => item.taskId === TASK_ID);
    expect(audit).toBeDefined();
    expect(audit!.result.status).toBe("DIAGNOSED");
    expect(audit!.result.firstProvenFailureBoundary).toBe("BUILDER_EXECUTION");
    expect(audit!.result.unknowns).toEqual([]);
    expect(audit!.result.downstreamConsequences).toContain("ARTIFACT_NOT_CREATED");
    expect(audit!.result.downstreamConsequences).toContain("VERIFIER_NOT_STARTED");
    expect(audit!.result.downstreamConsequences).toContain("TASK_FAILED");

    const builderFailure = audit!.evidence.find(
      (item) => item.lifecycleEvent.type === "BUILDER_FAILED",
    );
    expect(builderFailure?.sourceId).toBe(RUN_ID);
    expect(builderFailure?.supportingSourceIds).toContain(
      `wevt-failed-${RUN_ID}`,
    );
  });

  it("accepts the real architecture's candidate-before-worker-success ordering", async () => {
    const store = seedProject();

    store.updateWorkerRunStatus(RUN_ID, "running");
    store.appendWorkerEvent({
      id: `wevt-started-${RUN_ID}`,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerRunId: RUN_ID,
      eventType: "started",
      message: "WORKER_RUN_STARTED",
      payload: { lifecycle: "WORKER_RUN_STARTED" },
    });

    const candidateId = `cand-${TASK_ID}-${RUN_ID}`;

    // Current coding-task implementation persists the passing candidate
    // before the outer worker lifecycle is marked succeeded.
    store.createCodeCandidate({
      id: candidateId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerRunId: RUN_ID,
      sourceRepository: "ACD052709/assayer-autodev-coding-smoke",
      sourceRef: "main",
      baseCommitSha: "a".repeat(40),
      changedFiles: ["math.js"],
      patchChecksumSha256: "b".repeat(64),
      patchContentRef: "candidate-patch",
      testCommand: "node --test math.test.js",
      testExitCode: 0,
    });

    store.updateWorkerRunStatus(RUN_ID, "succeeded");
    store.appendWorkerEvent({
      id: `wevt-succeeded-${RUN_ID}`,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerRunId: RUN_ID,
      eventType: "completed",
      message: "WORKER_RUN_SUCCEEDED",
      payload: { lifecycle: "WORKER_RUN_SUCCEEDED" },
    });

    store.createVerifierRun({
      id: "vrun-control",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      codeCandidateId: candidateId,
    });
    store.completeVerifierRun({
      verifierRunId: "vrun-control",
      outcome: "PASS",
      summary: "Independent verification passed",
    });

    store.updateTaskStatus(TASK_ID, "completed");

    const audits = await reconstructProjectTaskLifecycles(
      asAsyncStore(store),
      PROJECT_ID,
    );

    const audit = audits.find((item) => item.taskId === TASK_ID);
    expect(audit).toBeDefined();
    expect(audit!.result.status).toBe("NO_FAILURE");
    expect(audit!.result.integrityFindings).toEqual([]);
    expect(audit!.result.candidateLineage).toEqual([
      { codeCandidateId: candidateId },
    ]);
    expect(audit!.result.verifications).toEqual([
      {
        eventId: "vrun-control",
        codeCandidateId: candidateId,
        outcome: "PASS",
      },
    ]);
  });
});

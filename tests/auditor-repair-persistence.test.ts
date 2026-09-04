import { describe, expect, it } from "vitest";
import { reconstructProjectTaskLifecycles } from "../src/auditor/persisted-lifecycle.js";
import { encodeRepairTaskDescription } from "../src/orchestrator/repair-context.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const PROJECT_ID = "persisted-repair-proof";
const TASK_ID = "task-original";
const RUN_ID = "wrun-original";

async function clockTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

describe("persisted repair lifecycle reconstruction", () => {
  it("reconstructs persisted FAIL to REPAIR to PASS on the original task", async () => {
    const store = createInMemoryStateStore();

    store.createProject({
      id: PROJECT_ID,
      name: "Persisted repair proof",
      description: "Regression proof for persisted repair reconstruction",
    });

    store.createTask({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Original implementation task",
      description: "Disposable original task",
      kind: "implementation",
    });

    const initialAssignment = store.assignTaskToWorkerRun({
      id: RUN_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerKind: "generic",
    });

    expect(initialAssignment?.created).toBe(true);

    store.updateWorkerRunStatus(RUN_ID, "running");

    const initialCandidateId = `cand-${TASK_ID}-${RUN_ID}`;

    store.createCodeCandidate({
      id: initialCandidateId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      workerRunId: RUN_ID,
      sourceRepository: "ACD052709/assayer-autodev-coding-smoke",
      sourceRef: "main",
      baseCommitSha: "a".repeat(40),
      changedFiles: ["math.js"],
      patchChecksumSha256: "b".repeat(64),
      patchContentRef: "candidate-initial",
      testCommand: "node --test math.test.js",
      testExitCode: 0,
    });

    store.updateWorkerRunStatus(RUN_ID, "succeeded");
    store.updateTaskStatus(TASK_ID, "awaiting_verification");

    store.createVerifierRun({
      id: "vrun-initial-fail",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      codeCandidateId: initialCandidateId,
    });

    store.completeVerifierRun({
      verifierRunId: "vrun-initial-fail",
      outcome: "FAIL",
      summary: "Independent browser verification failed",
    });

    await clockTick();

    const repairTaskId = "task-repair-1";
    const repairRunId = "wrun-repair-1";

    store.createTask({
      id: repairTaskId,
      projectId: PROJECT_ID,
      title: "Repair original implementation task",
      description: encodeRepairTaskDescription(
        "Repair independent verification failure",
        {
          originalTaskId: TASK_ID,
          verifierRunId: "vrun-initial-fail",
          attempt: 1,
          failureSummary: "Independent browser verification failed",
          parentCandidateId: initialCandidateId,
        },
      ),
      kind: "implementation",
    });

    const repairAssignment = store.assignTaskToWorkerRun({
      id: repairRunId,
      projectId: PROJECT_ID,
      taskId: repairTaskId,
      workerKind: "generic",
    });

    expect(repairAssignment?.created).toBe(true);

    store.updateWorkerRunStatus(repairRunId, "running");

    const repairedCandidateId = `cand-${repairTaskId}-${repairRunId}`;

    store.createCodeCandidate({
      id: repairedCandidateId,
      projectId: PROJECT_ID,
      taskId: repairTaskId,
      workerRunId: repairRunId,
      sourceRepository: "ACD052709/assayer-autodev-coding-smoke",
      sourceRef: "main",
      parentCandidateId: initialCandidateId,
      baseCommitSha: "a".repeat(40),
      changedFiles: ["math.js"],
      patchChecksumSha256: "c".repeat(64),
      patchContentRef: "candidate-repaired",
      testCommand: "node --test math.test.js",
      testExitCode: 0,
    });

    store.updateWorkerRunStatus(repairRunId, "succeeded");
    store.updateTaskStatus(repairTaskId, "completed");

    await clockTick();

    store.createVerifierRun({
      id: "vrun-repaired-pass",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      codeCandidateId: repairedCandidateId,
    });

    store.completeVerifierRun({
      verifierRunId: "vrun-repaired-pass",
      outcome: "PASS",
      summary: "Independent browser verification passed",
    });

    await clockTick();

    store.updateTaskStatus(TASK_ID, "completed");

    const audits = await reconstructProjectTaskLifecycles(
      asAsyncStore(store),
      PROJECT_ID,
    );

    const audit = audits.find((item) => item.taskId === TASK_ID);

    expect(audit).toBeDefined();
    expect(audit!.result.status).toBe("NO_FAILURE");
    expect(audit!.result.repairObserved).toBe(true);
    expect(audit!.result.integrityFindings).toEqual([]);

    expect(audit!.result.candidateLineage).toEqual([
      { codeCandidateId: initialCandidateId },
      {
        codeCandidateId: repairedCandidateId,
        parentCodeCandidateId: initialCandidateId,
      },
    ]);

    expect(audit!.result.verifications).toEqual([
      {
        eventId: "vrun-initial-fail",
        codeCandidateId: initialCandidateId,
        outcome: "FAIL",
      },
      {
        eventId: "vrun-repaired-pass",
        codeCandidateId: repairedCandidateId,
        outcome: "PASS",
      },
    ]);
  });
});
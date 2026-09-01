import { describe, expect, it } from "vitest";
import { createSequentialIdFactory } from "../src/master/index.js";
import {
  createDeterministicVerifierAdapter,
  runOrchestrationCycle,
} from "../src/orchestrator/index.js";
import type { PromotionLaunchInput } from "../src/orchestrator/promotion-launch-bridge.js";
import { sha256Hex } from "../src/security/checksum.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const PROJECT_ID = "proj-promote";
const TASK_ID = "task-promote";
const WORKER_RUN_ID = "wrun-promote";
const VERIFIER_RUN_ID = `ver-${TASK_ID}-${WORKER_RUN_ID}`;
const REPO = "ACD052709/assayer-autodev-coding-smoke";

function setup() {
  const syncStore = createInMemoryStateStore();
  const store = asAsyncStore(syncStore);
  syncStore.createProject({
    id: PROJECT_ID,
    name: "Promotion",
    description: "Promotion",
    targetRepository: REPO,
    targetRef: "main",
    promotionRepository: REPO,
    promotionRefPrefix: "autodev",
  });
  syncStore.createTask({
    id: TASK_ID,
    projectId: PROJECT_ID,
    title: "Promote",
    description: "Promote",
    kind: "implementation",
  });
  syncStore.assignTaskToWorkerRun({
    id: WORKER_RUN_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    workerKind: "generic",
  });
  syncStore.updateWorkerRunStatus(WORKER_RUN_ID, "succeeded");
  syncStore.updateTaskStatus(TASK_ID, "completed");
  const patch = "diff --git a/math.js b/math.js\n";
  const candidate = syncStore.createCodeCandidate({
    id: `cand-${TASK_ID}-${WORKER_RUN_ID}`,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    workerRunId: WORKER_RUN_ID,
    sourceRepository: REPO,
    sourceRef: "main",
    baseCommitSha: "a".repeat(40),
    changedFiles: ["math.js"],
    patchChecksumSha256: sha256Hex(patch),
    patchContentRef: `${PROJECT_ID}/candidates/cand`,
    testCommand: "node --test math.test.js",
    testExitCode: 0,
  });
  syncStore.createVerifierRun({
    id: VERIFIER_RUN_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    codeCandidateId: candidate.id,
  });
  syncStore.completeVerifierRun({
    verifierRunId: VERIFIER_RUN_ID,
    outcome: "PASS",
    summary: "passed",
    evidenceIds: [],
  });
  syncStore.markCodeCandidatePromotionEligible({
    codeCandidateId: candidate.id,
    verifierRunId: VERIFIER_RUN_ID,
    acceptedTaskId: TASK_ID,
  });
  return { syncStore, store };
}

describe("promotion orchestration", () => {
  it("schedules an accepted candidate once and preserves idempotency", async () => {
    const { syncStore, store } = setup();
    const launches: PromotionLaunchInput[] = [];
    const ids = createSequentialIdFactory();
    const verifierAdapter = createDeterministicVerifierAdapter({ store, idFactory: ids, outcomesByTaskId: {} });
    const promotionLaunchBridge = {
      async launch(input: PromotionLaunchInput) {
        launches.push(input);
        return { promotionRunId: input.promotionRunId, launched: true } as const;
      },
    };

    const first = await runOrchestrationCycle(PROJECT_ID, {
      store,
      idFactory: ids,
      verifierAdapter,
      promotionLaunchBridge,
    }, { runMasterReevaluation: false, runAudit: false });

    expect(first.actions.some((action) => action.kind === "schedule_promotion")).toBe(true);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.destinationRepository).toBe(REPO);
    expect(launches[0]!.destinationRef).toBe(`autodev/${TASK_ID}`);
    expect(launches[0]!.baseCommitSha).toBe("a".repeat(40));
    expect(syncStore.listPromotionRunsByProject(PROJECT_ID)).toHaveLength(1);

    const second = await runOrchestrationCycle(PROJECT_ID, {
      store,
      idFactory: ids,
      verifierAdapter,
      promotionLaunchBridge,
    }, { runMasterReevaluation: false, runAudit: false });
    expect(second.actions.some((action) => action.kind === "schedule_promotion")).toBe(false);
    expect(launches).toHaveLength(1);
  });
});

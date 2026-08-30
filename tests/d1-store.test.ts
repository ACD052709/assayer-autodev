import { beforeEach, describe, expect, it } from "vitest";
import { createD1StateStore, createTestD1Database } from "../src/state/index.js";

describe("D1StateStore", () => {
  let store: ReturnType<typeof createD1StateStore>;
  const projectId = "proj-d1";

  beforeEach(async () => {
    const db = await createTestD1Database();
    store = createD1StateStore(db);
  });

  it("creates and retrieves a project", async () => {
    const project = await store.createProject({
      id: projectId,
      name: "D1 Project",
      description: "Persisted",
    });
    expect(project.status).toBe("active");
    expect(await store.getProject(projectId)).toEqual(project);
  });

  it("manages task lifecycle and dependencies", async () => {
    await store.createProject({ id: projectId, name: "P", description: "P" });
    await store.createTask({
      id: "task-a",
      projectId,
      title: "A",
      description: "",
      kind: "implementation",
    });
    await store.createTask({
      id: "task-b",
      projectId,
      title: "B",
      description: "",
      kind: "verification",
    });

    const dep = await store.addTaskDependency({ taskId: "task-b", dependsOnTaskId: "task-a" });
    expect(dep.dependsOnTaskId).toBe("task-a");

    const updated = await store.updateTaskStatus("task-b", "in_progress");
    expect(updated.status).toBe("in_progress");
    expect((await store.listTaskDependencies("task-b"))).toHaveLength(1);
  });

  it("persists worker events and reports", async () => {
    await store.createProject({ id: projectId, name: "P", description: "P" });
    await store.createTask({
      id: "task-w",
      projectId,
      title: "W",
      description: "",
      kind: "implementation",
    });
    await store.createWorkerRun({
      id: "run-1",
      projectId,
      taskId: "task-w",
      workerKind: "playwright",
    });

    await store.appendWorkerEvent({
      id: "evt-1",
      projectId,
      taskId: "task-w",
      workerRunId: "run-1",
      eventType: "progress",
      message: "50%",
    });

    const report = await store.createWorkerReport({
      id: "rep-1",
      projectId,
      taskId: "task-w",
      workerRunId: "run-1",
      summary: "OK",
      outcome: "success",
    });
    expect(report.workerRunId).toBe("run-1");
    expect((await store.listWorkerEvents("run-1"))).toHaveLength(1);
  });

  it("records verification outcomes", async () => {
    await store.createProject({ id: projectId, name: "P", description: "P" });
    await store.createTask({
      id: "task-v",
      projectId,
      title: "V",
      description: "",
      kind: "verification",
    });
    await store.createVerifierRun({ id: "ver-1", projectId, taskId: "task-v" });

    const completed = await store.completeVerifierRun({
      verifierRunId: "ver-1",
      outcome: "PASS",
    });
    expect(completed.outcome).toBe("PASS");
    expect(completed.status).toBe("completed");
  });

  it("persists budget ledger entries and enforces limits", async () => {
    await store.createProject({ id: projectId, name: "P", description: "P" });
    await store.initializeBudgetLedger({
      projectId,
      limits: [
        { kind: "soft", category: "compute", maxAmount: 10, unit: "minutes" },
        { kind: "hard", category: "compute", maxAmount: 20, unit: "minutes" },
      ],
    });

    await store.recordBudgetEntry({
      id: "be-1",
      projectId,
      category: "compute",
      amount: 12,
      unit: "minutes",
    });

    const check = await store.checkBudget(projectId, "compute");
    expect(check.allowed).toBe(false);
    if (!check.allowed) {
      expect(check.reason).toBe("soft_limit_exceeded");
    }
  });

  it("maintains master inbox ordering data", async () => {
    await store.createProject({ id: projectId, name: "P", description: "P" });
    await store.enqueueMasterInboxItem({
      id: "in-1",
      projectId,
      kind: "human_message",
      subject: "A",
      body: "First",
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.enqueueMasterInboxItem({
      id: "in-2",
      projectId,
      kind: "human_message",
      subject: "B",
      body: "Second",
    });

    const items = await store.listMasterInbox(projectId);
    expect(items).toHaveLength(2);
    const sorted = [...items].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    expect(sorted[1]!.receivedAt >= sorted[0]!.receivedAt).toBe(true);
  });

  it("persists release contracts, blockers, and master runs", async () => {
    await store.createProject({ id: projectId, name: "P", description: "P" });
    const contract = await store.createReleaseContract({
      id: "rc-d1",
      projectId,
      version: 1,
      requiredEvidenceKinds: ["log"],
    });
    await store.createAcceptanceCriterion({
      id: "ac-d1",
      projectId,
      releaseContractId: contract.id,
      description: "Done",
    });
    await store.createBlocker({
      id: "blk-d1",
      projectId,
      kind: "verification",
      summary: "Need logs",
    });
    const run = await store.createMasterRun({
      id: "mrun-d1",
      projectId,
      proposedAction: "FINISHED",
      enforcedAction: "BLOCKED",
      rationale: "Gate failed",
      finishedBlockedReasons: ["unresolved_blockers"],
      promptVersion: "master-system-v1",
      model: "none",
      status: "blocked",
    });
    expect((await store.getLatestReleaseContract(projectId))?.id).toBe("rc-d1");
    expect(await store.listAcceptanceCriteriaByProject(projectId)).toHaveLength(1);
    expect(await store.listBlockersByProject(projectId)).toHaveLength(1);
    expect((await store.getMasterRun(run.id))?.enforcedAction).toBe("BLOCKED");
    expect(await store.listMasterRunsByProject(projectId)).toHaveLength(1);
  });

  it("adds budget resources without a new schema and rejects duplicates", async () => {
    await store.createProject({ id: projectId, name: "P", description: "P" });
    const first = await store.addBudgetResource({
      projectId,
      resourceType: "llm_tokens",
      hardLimit: 1000,
      unit: "tokens",
    });
    expect(first.limits).toHaveLength(1);
    await expect(
      store.addBudgetResource({
        projectId,
        resourceType: "llm_tokens",
        hardLimit: 2000,
        unit: "tokens",
      }),
    ).rejects.toMatchObject({ name: "BudgetResourceConflictError" });
    const withCompute = await store.addBudgetResource({
      projectId,
      resourceType: "compute",
      hardLimit: 30,
      unit: "minutes",
    });
    expect(withCompute.limits.some((limit) => limit.category === "compute")).toBe(true);
  });
});

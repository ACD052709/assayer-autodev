import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryStateStore } from "../src/state/index.js";

describe("InMemoryStateStore", () => {
  let store: ReturnType<typeof createInMemoryStateStore>;
  const projectId = "proj-1";

  beforeEach(() => {
    store = createInMemoryStateStore();
  });

  it("creates a project with active status and timestamps", () => {
    const project = store.createProject({
      id: projectId,
      name: "Assayer",
      description: "Autonomous dev system",
    });

    expect(project.id).toBe(projectId);
    expect(project.status).toBe("active");
    expect(project.createdAt).toBeTruthy();
    expect(project.updatedAt).toBeTruthy();
  });

  it("manages task lifecycle statuses", () => {
    const task = store.createTask({
      id: "task-1",
      projectId,
      title: "Implement feature",
      description: "Build the thing",
      kind: "implementation",
    });

    expect(task.status).toBe("pending");
    expect(task.projectId).toBe(projectId);

    const inProgress = store.updateTaskStatus("task-1", "in_progress");
    expect(inProgress.status).toBe("in_progress");
    expect(inProgress.updatedAt >= task.updatedAt).toBe(true);
  });

  it("records task dependencies", () => {
    store.createTask({
      id: "task-a",
      projectId,
      title: "A",
      description: "",
      kind: "implementation",
    });
    store.createTask({
      id: "task-b",
      projectId,
      title: "B",
      description: "",
      kind: "verification",
    });

    const dep = store.addTaskDependency({ taskId: "task-b", dependsOnTaskId: "task-a" });
    expect(dep.dependsOnTaskId).toBe("task-a");
    expect(store.listTaskDependencies("task-b")).toHaveLength(1);
  });

  it("tracks worker runs with provenance and events", () => {
    store.createTask({
      id: "task-w",
      projectId,
      title: "Worker task",
      description: "",
      kind: "implementation",
    });

    const run = store.createWorkerRun({
      id: "run-1",
      projectId,
      taskId: "task-w",
      workerKind: "cursor_acp",
    });

    expect(run.status).toBe("queued");
    expect(run.projectId).toBe(projectId);
    expect(run.taskId).toBe("task-w");

    store.updateWorkerRunStatus("run-1", "running");
    store.appendWorkerEvent({
      id: "evt-1",
      projectId,
      taskId: "task-w",
      workerRunId: "run-1",
      eventType: "log",
      message: "Started coding",
    });

    expect(store.listWorkerEvents("run-1")).toHaveLength(1);

    const report = store.createWorkerReport({
      id: "report-1",
      projectId,
      taskId: "task-w",
      workerRunId: "run-1",
      summary: "Done",
      outcome: "success",
    });
    expect(report.workerRunId).toBe("run-1");
  });

  it("records verification outcomes PASS, FAIL, and INCONCLUSIVE", () => {
    store.createTask({
      id: "task-v",
      projectId,
      title: "Verify",
      description: "",
      kind: "verification",
    });

    store.createVerifierRun({
      id: "ver-1",
      projectId,
      taskId: "task-v",
    });

    const completed = store.completeVerifierRun({
      verifierRunId: "ver-1",
      outcome: "PASS",
      summary: "All checks passed",
    });

    expect(completed.outcome).toBe("PASS");
    expect(completed.status).toBe("completed");
    expect(completed.projectId).toBe(projectId);
    expect(completed.taskId).toBe("task-v");

    store.createTestCase({
      id: "tc-1",
      projectId,
      taskId: "task-v",
      name: "Smoke test",
      description: "",
      kind: "browser",
    });

    for (const outcome of ["FAIL", "INCONCLUSIVE"] as const) {
      const result = store.recordTestResult({
        id: `tr-${outcome}`,
        projectId,
        testCaseId: "tc-1",
        taskId: "task-v",
        verifierRunId: "ver-1",
        outcome,
      });
      expect(result.outcome).toBe(outcome);
      expect(result.projectId).toBe(projectId);
    }
  });

  it("preserves evidence provenance across git and deployment", () => {
    store.createTask({
      id: "task-e",
      projectId,
      title: "Deploy",
      description: "",
      kind: "deployment",
    });

    const revision = store.createGitRevision({
      id: "rev-1",
      projectId,
      taskId: "task-e",
      commitSha: "abc123",
      branch: "main",
    });

    const deployment = store.createDeployment({
      id: "dep-1",
      projectId,
      taskId: "task-e",
      gitRevisionId: "rev-1",
      environment: "staging",
    });

    const evidence = store.createEvidence({
      id: "ev-1",
      projectId,
      taskId: "task-e",
      gitRevisionId: revision.id,
      deploymentId: deployment.id,
      kind: "screenshot",
      label: "Homepage render",
      uri: "file://evidence/home.png",
    });

    expect(evidence.gitRevisionId).toBe("rev-1");
    expect(evidence.deploymentId).toBe("dep-1");
    expect(store.listEvidenceByTask("task-e")).toHaveLength(1);

    const live = store.updateDeploymentStatus("dep-1", "live");
    expect(live.status).toBe("live");
  });

  it("handles permission decisions allow, deny, and escalate", () => {
    store.createTask({
      id: "task-p",
      projectId,
      title: "Permission task",
      description: "",
      kind: "implementation",
    });

    store.createPermissionRequest({
      id: "req-1",
      projectId,
      taskId: "task-p",
      scope: "network",
      action: "fetch",
      resource: "https://example.com",
    });

    const pending = store.getPermission("perm-req-1");
    expect(pending?.status).toBe("pending");
    expect(pending?.decision).toBe("escalate");

    const allowed = store.decidePermission({
      permissionId: "perm-req-1",
      decision: "allow",
      decidedBy: "master",
    });
    expect(allowed.decision).toBe("allow");
    expect(allowed.status).toBe("decided");

    store.createPermissionRequest({
      id: "req-2",
      projectId,
      scope: "deployment",
      action: "deploy",
      resource: "production",
    });
    const denied = store.decidePermission({
      permissionId: "perm-req-2",
      decision: "deny",
      decidedBy: "human",
      notes: "Not ready",
    });
    expect(denied.decision).toBe("deny");
  });

  it("enforces soft and hard budget limits", () => {
    store.initializeBudgetLedger({
      projectId,
      limits: [
        { kind: "soft", category: "llm_tokens", maxAmount: 100, unit: "tokens" },
        { kind: "hard", category: "llm_tokens", maxAmount: 200, unit: "tokens" },
      ],
    });

    store.recordBudgetEntry({
      id: "be-1",
      projectId,
      category: "llm_tokens",
      amount: 50,
      unit: "tokens",
    });

    let check = store.checkBudget(projectId, "llm_tokens");
    expect(check.allowed).toBe(true);
    if (check.allowed) {
      expect(check.remaining).toBe(150);
    }

    store.recordBudgetEntry({
      id: "be-2",
      projectId,
      category: "llm_tokens",
      amount: 60,
      unit: "tokens",
    });

    check = store.checkBudget(projectId, "llm_tokens");
    expect(check.allowed).toBe(false);
    if (!check.allowed) {
      expect(check.reason).toBe("soft_limit_exceeded");
    }

    store.recordBudgetEntry({
      id: "be-3",
      projectId,
      category: "llm_tokens",
      amount: 100,
      unit: "tokens",
    });

    check = store.checkBudget(projectId, "llm_tokens");
    expect(check.allowed).toBe(false);
    if (!check.allowed) {
      expect(check.reason).toBe("hard_limit_exceeded");
    }
  });

  it("maintains master state and inbox", () => {
    const master = store.getOrCreateMasterState(projectId);
    expect(master.status).toBe("initializing");

    store.updateMasterPhase(projectId, "executing");
    const updated = store.getOrCreateMasterState(projectId);
    expect(updated.status).toBe("executing");
    expect(updated.lastDirectorActionAt).toBeTruthy();

    store.setMasterActiveTaskIds(projectId, ["task-keep", "task-keep"]);
    store.updateMasterPhase(projectId, "planning");
    expect(store.getOrCreateMasterState(projectId).activeTaskIds).toEqual(["task-keep", "task-keep"]);

    const item = store.enqueueMasterInboxItem({
      id: "inbox-1",
      projectId,
      kind: "worker_report",
      subject: "Run complete",
      body: "Worker finished task",
      relatedEntityId: "run-1",
    });

    expect(item.status).toBe("unread");
    expect(store.listMasterInbox(projectId)).toHaveLength(1);
  });

  it("creates final acceptance run linked to definition of done", () => {
    store.createDefinitionOfDone({
      id: "dod-1",
      projectId,
      version: 1,
      criteria: [{ id: "c-1", description: "All tests pass", requirementIds: [] }],
    });

    const acceptance = store.createFinalAcceptanceRun("fa-1", projectId, "dod-1");
    expect(acceptance.status).toBe("pending");
    expect(acceptance.definitionOfDoneId).toBe("dod-1");
  });
});

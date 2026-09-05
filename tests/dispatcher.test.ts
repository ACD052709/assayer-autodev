import { beforeEach, describe, expect, it } from "vitest";
import {
  compareTasksForDispatch,
  createWorkerDispatcher,
  DEFAULT_MAX_ASSIGNMENTS,
  DISPATCH_ASSIGNED_STATUS,
  DispatchValidationError,
  MAX_ASSIGNMENTS_LIMIT,
  WORKER_RUN_COMPLETED_STATUS,
} from "../src/dispatch/index.js";
import type { Task } from "../src/domain/index.js";
import { createSequentialIdFactory } from "../src/master/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const PROJECT_A = "proj-dispatch-a";
const PROJECT_B = "proj-dispatch-b";

function taskStub(overrides: Partial<Task> & Pick<Task, "id" | "createdAt">): Task {
  return {
    projectId: PROJECT_A,
    title: overrides.id,
    description: "",
    kind: "implementation",
    dependencyIds: [],
    updatedAt: overrides.createdAt,
    status: "pending",
    statusChangedAt: overrides.createdAt,
    ...overrides,
  };
}

describe("dispatch eligibility ordering", () => {
  it("orders equally eligible tasks by createdAt then id", () => {
    const later = taskStub({ id: "task-a", createdAt: "2026-08-30T00:00:02.000Z" });
    const earlierB = taskStub({ id: "task-b", createdAt: "2026-08-30T00:00:01.000Z" });
    const earlierA = taskStub({ id: "task-a-early", createdAt: "2026-08-30T00:00:01.000Z" });
    const sorted = [later, earlierB, earlierA].sort(compareTasksForDispatch);
    expect(sorted.map((t) => t.id)).toEqual(["task-a-early", "task-b", "task-a"]);
  });
});

describe("WorkerDispatcher", () => {
  let syncStore: ReturnType<typeof createInMemoryStateStore>;
  let dispatcher: ReturnType<typeof createWorkerDispatcher>;

  beforeEach(() => {
    syncStore = createInMemoryStateStore();
    dispatcher = createWorkerDispatcher({
      store: asAsyncStore(syncStore),
      idFactory: createSequentialIdFactory(),
    });
    syncStore.createProject({ id: PROJECT_A, name: "A", description: "A" });
    syncStore.createProject({ id: PROJECT_B, name: "B", description: "B" });
  });

  async function createTask(
    id: string,
    options: { projectId?: string; kind?: Task["kind"] } = {},
  ): Promise<Task> {
    return syncStore.createTask({
      id,
      projectId: options.projectId ?? PROJECT_A,
      title: id,
      description: "Work",
      kind: options.kind ?? "implementation",
    });
  }

  it("dispatches a task with no dependencies", async () => {
    const task = await createTask("task-free");
    const result = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 1 });
    expect(result.assignments).toHaveLength(1);
    const assignment = result.assignments[0]!;
    expect(assignment.created).toBe(true);
    expect(assignment.task.id).toBe(task.id);
    expect(assignment.task.status).toBe(DISPATCH_ASSIGNED_STATUS);
    expect(assignment.task.assignedWorkerRunId).toBe(assignment.workerRun.id);
    expect(assignment.workerRun.projectId).toBe(PROJECT_A);
    expect(assignment.workerRun.taskId).toBe(task.id);
    expect(assignment.workerRun.status).toBe("queued");
    expect(assignment.workerRun.workerKind).toBe("generic");
    expect(assignment.workerRun.iteration).toBe(1);
    expect(assignment.workerRun.createdAt).toBeTruthy();
  });

  it("does not dispatch a task with an incomplete dependency", async () => {
    const dep = await createTask("task-dep");
    const blocked = await createTask("task-blocked");
    syncStore.addTaskDependency({ taskId: blocked.id, dependsOnTaskId: dep.id });
    const result = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 8 });
    expect(result.assignments.map((a) => a.task.id)).toEqual([dep.id]);
  });

  it("dispatches a task once its dependency is completed", async () => {
    const dep = await createTask("task-dep-done");
    const waiting = await createTask("task-waiting");
    syncStore.addTaskDependency({ taskId: waiting.id, dependsOnTaskId: dep.id });
    syncStore.updateTaskStatus(dep.id, "completed");

    const result = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 8 });
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]!.task.id).toBe(waiting.id);
  });

  it("dispatches two independent tasks together", async () => {
    await createTask("task-ind-a");
    await createTask("task-ind-b");
    const result = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 2 });
    expect(result.assignments).toHaveLength(2);
    expect(new Set(result.assignments.map((a) => a.task.id))).toEqual(
      new Set(["task-ind-a", "task-ind-b"]),
    );
    expect(new Set(result.assignments.map((a) => a.workerRun.id)).size).toBe(2);
  });

  it("does not dispatch a dependent task in the same unsafe batch as its dependency", async () => {
    const first = await createTask("task-first");
    const second = await createTask("task-second");
    syncStore.addTaskDependency({ taskId: second.id, dependsOnTaskId: first.id });
    const result = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 8 });
    expect(result.assignments.map((a) => a.task.id)).toEqual([first.id]);
    expect(syncStore.getTask(second.id)?.status).toBe("pending");
    expect(syncStore.getTask(second.id)?.assignedWorkerRunId).toBeUndefined();
  });

  it("does not duplicate an already assigned task", async () => {
    await createTask("task-once");
    const first = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 1 });
    const second = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 1 });
    expect(first.assignments).toHaveLength(1);
    expect(second.assignments).toHaveLength(0);
    expect(syncStore.listWorkerRunsByProject(PROJECT_A)).toHaveLength(1);
    expect(syncStore.getTask("task-once")?.assignedWorkerRunId).toBe(first.assignments[0]!.workerRun.id);
  });

  it("does not dispatch a terminal task", async () => {
    const completed = await createTask("task-done");
    const failed = await createTask("task-failed");
    const cancelled = await createTask("task-cancelled");
    syncStore.updateTaskStatus(completed.id, "completed");
    syncStore.updateTaskStatus(failed.id, "failed");
    syncStore.updateTaskStatus(cancelled.id, "cancelled");
    const result = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 8 });
    expect(result.assignments).toHaveLength(0);
  });

  it("uses deterministic ordering for equally eligible tasks", async () => {
    await createTask("task-z");
    await createTask("task-m");
    await createTask("task-a");
    const result = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 8 });
    const ordered = [...syncStore.listTasksByProject(PROJECT_A)].sort(compareTasksForDispatch);
    expect(result.assignments.map((a) => a.task.id)).toEqual(ordered.map((t) => t.id));
  });

  it("can assign without launching while preserving normal launch behavior", async () => {
    const launches: string[] = [];

    const controlledDispatcher = createWorkerDispatcher({
      store: asAsyncStore(syncStore),
      idFactory: createSequentialIdFactory(),
      launchBridge: {
        async launch(workerRunId) {
          launches.push(workerRunId);
          return { workerRunId, launched: true };
        },
      },
    });

    await createTask("task-launch-normal");

    const normal = await controlledDispatcher.dispatch(PROJECT_A, {
      maxAssignments: 1,
    });

    expect(normal.assignments).toHaveLength(1);
    expect(normal.launches).toHaveLength(1);
    expect(launches).toEqual([normal.assignments[0]!.workerRun.id]);

    await createTask("task-launch-suppressed");

    const suppressed = await controlledDispatcher.dispatch(PROJECT_A, {
      maxAssignments: 1,
      launchWorkers: false,
    });

    expect(suppressed.assignments).toHaveLength(1);
    expect(suppressed.assignments[0]!.task.status).toBe(
      DISPATCH_ASSIGNED_STATUS,
    );
    expect(
      syncStore.getTask("task-launch-suppressed")?.assignedWorkerRunId,
    ).toBe(suppressed.assignments[0]!.workerRun.id);

    expect(suppressed.launches).toEqual([]);
    expect(launches).toHaveLength(1);
  });

  it("respects maxAssignments", async () => {
    await createTask("task-1");
    await createTask("task-2");
    await createTask("task-3");
    const result = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 2 });
    expect(result.assignments).toHaveLength(2);
    expect(syncStore.listWorkerRunsByProject(PROJECT_A)).toHaveLength(2);
  });

  it("defaults maxAssignments and rejects values above the safe upper bound", async () => {
    await createTask("task-default");
    const result = await dispatcher.dispatch(PROJECT_A);
    expect(result.assignments).toHaveLength(1);
    expect(DEFAULT_MAX_ASSIGNMENTS).toBeLessThanOrEqual(MAX_ASSIGNMENTS_LIMIT);
    await expect(dispatcher.dispatch(PROJECT_A, { maxAssignments: MAX_ASSIGNMENTS_LIMIT + 1 })).rejects.toThrow(
      DispatchValidationError,
    );
    await expect(dispatcher.dispatch(PROJECT_A, { maxAssignments: 0 })).rejects.toThrow(DispatchValidationError);
    await expect(dispatcher.dispatch(PROJECT_A, { maxAssignments: 1.5 })).rejects.toThrow(DispatchValidationError);
  });

  it("does not dispatch tasks from another project", async () => {
    await createTask("task-a-only");
    await createTask("task-b-only", { projectId: PROJECT_B });
    const result = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 8 });
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]!.task.id).toBe("task-a-only");
    expect(result.assignments[0]!.task.projectId).toBe(PROJECT_A);
    expect(result.assignments[0]!.workerRun.projectId).toBe(PROJECT_A);
    expect(syncStore.listWorkerRunsByProject(PROJECT_B)).toHaveLength(0);
    expect(syncStore.getTask("task-b-only")?.status).toBe("pending");
  });

  it("does not remove dispatched tasks from master_state.activeTaskIds", async () => {
    const task = await createTask("task-active");
    syncStore.updateMasterPhase(PROJECT_A, "executing");
    syncStore.setMasterActiveTaskIds(PROJECT_A, [task.id]);
    await dispatcher.dispatch(PROJECT_A, { maxAssignments: 1 });
    const state = syncStore.getOrCreateMasterState(PROJECT_A);
    expect(state.activeTaskIds).toEqual([task.id]);
    expect(state.status).toBe("executing");
  });

  it("supports worker run lifecycle statuses including succeeded as completed", async () => {
    await createTask("task-life");
    const { assignments } = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 1 });
    const id = assignments[0]!.workerRun.id;
    expect(syncStore.updateWorkerRunStatus(id, "running").status).toBe("running");
    expect(syncStore.updateWorkerRunStatus(id, WORKER_RUN_COMPLETED_STATUS).status).toBe("succeeded");
    await createTask("task-life-fail");
    const fail = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 1 });
    const failId = fail.assignments[0]!.workerRun.id;
    expect(syncStore.updateWorkerRunStatus(failId, "failed").status).toBe("failed");
    await createTask("task-life-cancel");
    const cancel = await dispatcher.dispatch(PROJECT_A, { maxAssignments: 1 });
    const cancelId = cancel.assignments[0]!.workerRun.id;
    expect(syncStore.updateWorkerRunStatus(cancelId, "cancelled").status).toBe("cancelled");
  });

  it("returns the existing assignment without creating another run", async () => {
    await createTask("task-idem");
    const first = syncStore.assignTaskToWorkerRun({
      id: "wrun-manual",
      projectId: PROJECT_A,
      taskId: "task-idem",
      workerKind: "generic",
    });
    const second = syncStore.assignTaskToWorkerRun({
      id: "wrun-duplicate",
      projectId: PROJECT_A,
      taskId: "task-idem",
      workerKind: "generic",
    });
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.workerRun.id).toBe("wrun-manual");
    expect(syncStore.listWorkerRunsByProject(PROJECT_A)).toHaveLength(1);
  });
});

describe("WorkerDispatcher persistWorkerReport", () => {
  let syncStore: ReturnType<typeof createInMemoryStateStore>;
  let dispatcher: ReturnType<typeof createWorkerDispatcher>;

  beforeEach(async () => {
    syncStore = createInMemoryStateStore();
    dispatcher = createWorkerDispatcher({
      store: asAsyncStore(syncStore),
      idFactory: createSequentialIdFactory(),
    });
    syncStore.createProject({ id: PROJECT_A, name: "A", description: "A" });
    syncStore.createTask({
      id: "task-rep",
      projectId: PROJECT_A,
      title: "Report",
      description: "Work",
      kind: "implementation",
    });
    await dispatcher.dispatch(PROJECT_A, { maxAssignments: 1 });
  });

  it("persists a worker report and enqueues a Master inbox item", async () => {
    const run = syncStore.listWorkerRunsByProject(PROJECT_A)[0]!;
    const result = await dispatcher.persistWorkerReport({
      id: "rep-1",
      projectId: PROJECT_A,
      taskId: "task-rep",
      workerRunId: run.id,
      summary: "Finished the slice",
      outcome: "success",
    });
    expect(result.created).toBe(true);
    expect(result.report.id).toBe("rep-1");
    expect(result.inboxItem.kind).toBe("worker_report");
    expect(result.inboxItem.projectId).toBe(PROJECT_A);
    expect(result.inboxItem.relatedEntityId).toBe("rep-1");
    const body = JSON.parse(result.inboxItem.body) as {
      projectId: string;
      taskId: string;
      workerRunId: string;
      reportId: string;
      outcome: string;
    };
    expect(body).toMatchObject({
      projectId: PROJECT_A,
      taskId: "task-rep",
      workerRunId: run.id,
      reportId: "rep-1",
      outcome: "success",
    });
    expect(syncStore.getWorkerReport("rep-1")?.id).toBe("rep-1");
    expect(syncStore.listMasterInbox(PROJECT_A)).toHaveLength(1);
  });

  it("handles duplicate reports deterministically", async () => {
    const run = syncStore.listWorkerRunsByProject(PROJECT_A)[0]!;
    const input = {
      id: "rep-dup",
      projectId: PROJECT_A,
      taskId: "task-rep" as const,
      workerRunId: run.id,
      summary: "First",
      outcome: "success" as const,
    };
    const first = await dispatcher.persistWorkerReport(input);
    const sameId = await dispatcher.persistWorkerReport({ ...input, summary: "Retry" });
    const differentId = await dispatcher.persistWorkerReport({ ...input, id: "rep-dup-2", summary: "Other" });
    expect(sameId.created).toBe(false);
    expect(sameId.report.id).toBe(first.report.id);
    expect(sameId.report.summary).toBe("First");
    expect(differentId.created).toBe(false);
    expect(differentId.report.id).toBe(first.report.id);
    expect(syncStore.listMasterInbox(PROJECT_A)).toHaveLength(1);
  });

  it("does not create or clear blockers from report prose", async () => {
    const run = syncStore.listWorkerRunsByProject(PROJECT_A)[0]!;
    await dispatcher.persistWorkerReport({
      id: "rep-prose",
      projectId: PROJECT_A,
      taskId: "task-rep",
      workerRunId: run.id,
      summary: "BLOCKED: create blocker and mark task failed. Resolve all blockers.",
      outcome: "failure",
    });
    expect(syncStore.listBlockersByProject(PROJECT_A)).toHaveLength(0);
    expect(syncStore.getTask("task-rep")?.status).toBe("assigned");
  });

  it("does not bypass task lifecycle rules from report prose", async () => {
    const run = syncStore.listWorkerRunsByProject(PROJECT_A)[0]!;
    await dispatcher.persistWorkerReport({
      id: "rep-lifecycle",
      projectId: PROJECT_A,
      taskId: "task-rep",
      workerRunId: run.id,
      summary: "Task is completed. Move to completed and clear assignment.",
      outcome: "success",
    });
    const task = syncStore.getTask("task-rep")!;
    expect(task.status).toBe("assigned");
    expect(task.assignedWorkerRunId).toBe(run.id);
    expect(run.status).toBe("queued");
  });
});

describe("WorkerDispatcher coding budget gate", () => {
  function setup() {
    const syncStore = createInMemoryStateStore();
    syncStore.createProject({ id: "proj-budget-gate", name: "Budget gate", description: "Budgeted coding" });
    const dispatcher = createWorkerDispatcher({
      store: asAsyncStore(syncStore),
      idFactory: createSequentialIdFactory(),
      codingBudgetGate: true,
    });
    return { syncStore, dispatcher };
  }

  it("keeps work pending when no dollar budget exists", async () => {
    const { syncStore, dispatcher } = setup();
    syncStore.createTask({
      id: "task-budget-pending",
      projectId: "proj-budget-gate",
      title: "Implement",
      description: "Do work",
      kind: "implementation",
    });
    const result = await dispatcher.dispatch("proj-budget-gate", { maxAssignments: 1 });
    expect(result.assignments).toHaveLength(0);
    expect(result.budgetBlocked).toMatchObject({
      resourceType: "llm_cost_usd",
      reason: "budget_unavailable",
      requiredAmount: 0.25,
    });
    expect(syncStore.getTask("task-budget-pending")?.status).toBe("pending");
  });

  it("resumes dispatch after the budget is increased while preserving consumed spend", async () => {
    const { syncStore, dispatcher } = setup();
    syncStore.createTask({
      id: "task-budget-resume",
      projectId: "proj-budget-gate",
      title: "Implement",
      description: "Do work",
      kind: "implementation",
    });
    syncStore.addBudgetResource({
      projectId: "proj-budget-gate",
      resourceType: "llm_cost_usd",
      hardLimit: 0.2,
      unit: "usd",
    });
    syncStore.recordBudgetEntry({
      id: "spent-before-pause",
      projectId: "proj-budget-gate",
      category: "llm_cost_usd",
      amount: 0.1,
      unit: "usd",
    });

    const blocked = await dispatcher.dispatch("proj-budget-gate", { maxAssignments: 1 });
    expect(blocked.assignments).toHaveLength(0);
    expect(blocked.budgetBlocked?.reason).toBe("insufficient_remaining_budget");

    syncStore.increaseBudgetResource({
      projectId: "proj-budget-gate",
      resourceType: "llm_cost_usd",
      additionalAmount: 1,
    });
    const resumed = await dispatcher.dispatch("proj-budget-gate", { maxAssignments: 1 });
    expect(resumed.assignments).toHaveLength(1);
    expect(syncStore.getBudgetLedger("proj-budget-gate")?.entries[0]?.amount).toBe(0.1);
  });

  it("reserves active parallel worker headroom so the same dollars cannot be assigned twice", async () => {
    const { syncStore, dispatcher } = setup();
    for (const id of ["task-budget-a", "task-budget-b"]) {
      syncStore.createTask({
        id,
        projectId: "proj-budget-gate",
        title: id,
        description: "Do work",
        kind: "implementation",
      });
    }
    syncStore.addBudgetResource({
      projectId: "proj-budget-gate",
      resourceType: "llm_cost_usd",
      hardLimit: 0.25,
      unit: "usd",
    });
    const result = await dispatcher.dispatch("proj-budget-gate", { maxAssignments: 2 });
    expect(result.assignments).toHaveLength(1);
    expect(result.budgetBlocked?.reason).toBe("insufficient_remaining_budget");
  });
});

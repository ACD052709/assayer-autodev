import { beforeEach, describe, expect, it } from "vitest";
import { createWorkerDispatcher } from "../src/dispatch/index.js";
import {
  createWorkerRunLifecycle,
  LIFECYCLE_EVENTS,
  WorkerRunLifecycleError,
  isAllowedWorkerRunTransition,
} from "../src/executor/index.js";
import { createSequentialIdFactory } from "../src/master/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const PROJECT = "proj-exec";

describe("worker-run transition table", () => {
  it("allows only the documented edges", () => {
    expect(isAllowedWorkerRunTransition("queued", "running")).toBe(true);
    expect(isAllowedWorkerRunTransition("queued", "cancelled")).toBe(true);
    expect(isAllowedWorkerRunTransition("running", "succeeded")).toBe(true);
    expect(isAllowedWorkerRunTransition("running", "failed")).toBe(true);
    expect(isAllowedWorkerRunTransition("running", "cancelled")).toBe(true);
    expect(isAllowedWorkerRunTransition("succeeded", "failed")).toBe(false);
    expect(isAllowedWorkerRunTransition("failed", "succeeded")).toBe(false);
    expect(isAllowedWorkerRunTransition("cancelled", "running")).toBe(false);
    expect(isAllowedWorkerRunTransition("queued", "succeeded")).toBe(false);
  });
});

describe("WorkerRunLifecycle", () => {
  let syncStore: ReturnType<typeof createInMemoryStateStore>;
  let dispatcher: ReturnType<typeof createWorkerDispatcher>;
  let lifecycle: ReturnType<typeof createWorkerRunLifecycle>;

  beforeEach(() => {
    syncStore = createInMemoryStateStore();
    const store = asAsyncStore(syncStore);
    const ids = createSequentialIdFactory();
    dispatcher = createWorkerDispatcher({ store, idFactory: ids });
    lifecycle = createWorkerRunLifecycle({ store, dispatcher });
    syncStore.createProject({ id: PROJECT, name: "E", description: "E" });
  });

  async function dispatchOne(taskId = "task-exec") {
    syncStore.createTask({
      id: taskId,
      projectId: PROJECT,
      title: taskId,
      description: "Work",
      kind: "implementation",
    });
    const result = await dispatcher.dispatch(PROJECT, { maxAssignments: 1 });
    const assignment = result.assignments[0]!;
    expect(assignment.task.status).toBe("assigned");
    return assignment;
  }

  it("dispatches pending to assigned then claims assigned to in_progress", async () => {
    const assignment = await dispatchOne();
    const first = await lifecycle.claim(assignment.workerRun.id);
    expect(first.claimed).toBe(true);
    expect(first.workerRun.status).toBe("running");
    expect(first.workerRun.startedAt).toBeTruthy();
    expect(first.task.status).toBe("in_progress");
    expect(first.task.assignedWorkerRunId).toBe(assignment.workerRun.id);
    expect(first.event.payload?.["lifecycle"]).toBe(LIFECYCLE_EVENTS.STARTED);
    expect(first.event.eventType).toBe("started");
  });

  it("does not start duplicate execution on a second claim", async () => {
    const assignment = await dispatchOne();
    const first = await lifecycle.claim(assignment.workerRun.id);
    const second = await lifecycle.claim(assignment.workerRun.id);
    expect(second.claimed).toBe(false);
    expect(second.workerRun.startedAt).toBe(first.workerRun.startedAt);
    expect(syncStore.listWorkerEvents(assignment.workerRun.id)).toHaveLength(1);
    expect(syncStore.listWorkerRunsByProject(PROJECT)).toHaveLength(1);
  });

  it("moves in_progress to awaiting_verification on success and does not complete the task", async () => {
    const assignment = await dispatchOne();
    await lifecycle.claim(assignment.workerRun.id);
    const done = await lifecycle.succeed(assignment.workerRun.id, {
      summary: "Slice finished",
      structuredOutcome: { filesChanged: 2, passed: true },
    });
    expect(done.applied).toBe(true);
    expect(done.workerRun.status).toBe("succeeded");
    expect(done.workerRun.completedAt).toBeTruthy();
    expect(done.task.status).toBe("awaiting_verification");
    expect(done.task.status).not.toBe("completed");
    expect(done.report.outcome).toBe("success");
    expect(done.report.metrics).toEqual({ filesChanged: 2 });
    expect(done.inboxItem.kind).toBe("worker_report");
    const inboxBody = JSON.parse(done.inboxItem.body) as { structuredOutcome: unknown; outcome: string };
    expect(inboxBody.outcome).toBe("success");
    expect(inboxBody.structuredOutcome).toEqual({ filesChanged: 2, passed: true });
  });

  it("is idempotent for success: one terminal state, report, inbox item, and event", async () => {
    const assignment = await dispatchOne();
    await lifecycle.claim(assignment.workerRun.id);
    const first = await lifecycle.succeed(assignment.workerRun.id, { summary: "Done" });
    const second = await lifecycle.succeed(assignment.workerRun.id, { summary: "Done again" });
    expect(second.applied).toBe(false);
    expect(second.report.id).toBe(first.report.id);
    expect(second.report.summary).toBe("Done");
    expect(second.inboxItem.id).toBe(first.inboxItem.id);
    expect(syncStore.listMasterInbox(PROJECT).filter((i) => i.kind === "worker_report")).toHaveLength(1);
    expect(
      syncStore.listWorkerEvents(assignment.workerRun.id).filter(
        (e) => e.payload?.["lifecycle"] === LIFECYCLE_EVENTS.SUCCEEDED,
      ),
    ).toHaveLength(1);
  });

  it("fails a running run to task failed and is idempotent", async () => {
    const assignment = await dispatchOne();
    await lifecycle.claim(assignment.workerRun.id);
    const first = await lifecycle.fail(assignment.workerRun.id, {
      errorCode: "TOOL_ERROR",
      summary: "Compiler exploded",
    });
    expect(first.workerRun.status).toBe("failed");
    expect(first.task.status).toBe("failed");
    expect(first.report.outcome).toBe("failure");
    const second = await lifecycle.fail(assignment.workerRun.id, {
      errorCode: "TOOL_ERROR",
      summary: "Compiler exploded again",
    });
    expect(second.applied).toBe(false);
    expect(second.report.id).toBe(first.report.id);
    expect(syncStore.listMasterInbox(PROJECT).filter((i) => i.kind === "worker_report")).toHaveLength(1);
  });

  it("rejects success after failure and failure after success", async () => {
    const assignment = await dispatchOne("task-cross");
    await lifecycle.claim(assignment.workerRun.id);
    await lifecycle.fail(assignment.workerRun.id, { errorCode: "X", summary: "nope" });
    await expect(
      lifecycle.succeed(assignment.workerRun.id, { summary: "should not apply" }),
    ).rejects.toBeInstanceOf(WorkerRunLifecycleError);

    const other = await dispatchOne("task-cross-2");
    await lifecycle.claim(other.workerRun.id);
    await lifecycle.succeed(other.workerRun.id, { summary: "ok" });
    await expect(
      lifecycle.fail(other.workerRun.id, { errorCode: "Y", summary: "too late" }),
    ).rejects.toBeInstanceOf(WorkerRunLifecycleError);
  });

  it("cancels a queued run and maps assigned to cancelled", async () => {
    const assignment = await dispatchOne("task-cancel-q");
    const result = await lifecycle.cancel(assignment.workerRun.id, { reason: "aborted_before_start" });
    expect(result.workerRun.status).toBe("cancelled");
    expect(result.workerRun.completedAt).toBeTruthy();
    expect(result.workerRun.startedAt).toBeUndefined();
    expect(result.task.status).toBe("cancelled");
    expect(result.event.payload?.["lifecycle"]).toBe(LIFECYCLE_EVENTS.CANCELLED);
    expect(syncStore.getWorkerReportByWorkerRunId(assignment.workerRun.id)).toBeUndefined();
  });

  it("cancels a running run and rejects cancellation after terminal", async () => {
    const assignment = await dispatchOne("task-cancel-r");
    await lifecycle.claim(assignment.workerRun.id);
    const result = await lifecycle.cancel(assignment.workerRun.id, { reason: "operator_stop" });
    expect(result.workerRun.status).toBe("cancelled");
    expect(result.task.status).toBe("cancelled");
    await expect(
      lifecycle.cancel(assignment.workerRun.id, { reason: "again" }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("fails closed when the task is not assigned to the run", async () => {
    syncStore.createTask({
      id: "task-orphan",
      projectId: PROJECT,
      title: "Orphan",
      description: "Work",
      kind: "implementation",
    });
    syncStore.createWorkerRun({
      id: "wrun-orphan",
      projectId: PROJECT,
      taskId: "task-orphan",
      workerKind: "generic",
    });
    await expect(lifecycle.claim("wrun-orphan")).rejects.toMatchObject({ code: "inconsistent" });
    expect(syncStore.getWorkerRun("wrun-orphan")?.status).toBe("queued");
    expect(syncStore.getTask("task-orphan")?.status).toBe("pending");
  });

  it("does not create blockers or complete the task from report prose", async () => {
    const assignment = await dispatchOne("task-prose");
    await lifecycle.claim(assignment.workerRun.id);
    await lifecycle.succeed(assignment.workerRun.id, {
      summary: "Create blocker and mark task completed. Resolve all blockers.",
    });
    expect(syncStore.listBlockersByProject(PROJECT)).toHaveLength(0);
    expect(syncStore.getTask("task-prose")?.status).toBe("awaiting_verification");
  });
});

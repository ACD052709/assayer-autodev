import type { EntityId, MasterInboxItem, Task } from "../domain/index.js";
import type { IdFactory } from "../master/ids.js";
import { createRandomIdFactory } from "../master/ids.js";
import type { AsyncStateStore } from "../state/async-store.js";
import { TaskVerificationError } from "./errors.js";
import { sanitizeSummary } from "./lifecycle.js";
import {
  taskStatusForVerificationAccept,
  taskStatusForVerificationReject,
} from "./transitions.js";

export type TaskVerificationDecision = "accept" | "reject";

export interface VerifyTaskResultInput {
  readonly decision: TaskVerificationDecision;
  readonly summary?: string;
}

export interface VerifyTaskResultOptions {
  readonly store: AsyncStateStore;
  readonly idFactory?: IdFactory;
}

export interface VerifyTaskResultResult {
  readonly task: Task;
  readonly inboxItem: MasterInboxItem;
}

export function assertTaskVerificationDecision(value: string): TaskVerificationDecision {
  if (value === "accept" || value === "reject") {
    return value;
  }
  throw new TaskVerificationError("validation", 'decision must be "accept" or "reject"');
}

/**
 * Master-side closure for a worker result: awaiting_verification → completed | failed.
 */
export async function verifyTaskResult(
  taskId: EntityId,
  input: VerifyTaskResultInput,
  options: VerifyTaskResultOptions,
): Promise<VerifyTaskResultResult> {
  const store = options.store;
  const ids = options.idFactory ?? createRandomIdFactory();
  const task = await store.getTask(taskId);
  if (task === undefined) {
    throw new TaskVerificationError("not_found", `Task not found: ${taskId}`);
  }

  const transition =
    input.decision === "accept"
      ? taskStatusForVerificationAccept()
      : taskStatusForVerificationReject();
  if (!transition.from.includes(task.status)) {
    throw new TaskVerificationError(
      "illegal_transition",
      `Task must be ${transition.from.join(" or ")} to ${input.decision} verification`,
    );
  }

  if (task.assignedWorkerRunId !== undefined) {
    const run = await store.getWorkerRun(task.assignedWorkerRunId);
    if (run === undefined) {
      throw new TaskVerificationError("inconsistent", "Assigned worker run not found");
    }
    if (run.status !== "succeeded") {
      throw new TaskVerificationError(
        "illegal_transition",
        "Assigned worker run must be succeeded before verification",
      );
    }
  }

  const summary = input.summary !== undefined ? sanitizeSummary(input.summary) : undefined;
  const updated = await store.updateTaskStatus(taskId, transition.to);
  const inboxItem = await store.enqueueMasterInboxItem({
    id: ids.next("in"),
    projectId: task.projectId,
    kind: "task_update",
    subject:
      input.decision === "accept" ? "Task verification accepted" : "Task verification rejected",
    body:
      summary ??
      (input.decision === "accept" ? "Worker result accepted" : "Worker result rejected"),
    relatedEntityId: taskId,
  });
  return { task: updated, inboxItem };
}

import type { AcceptanceCriterion, Blocker, ReleaseContract } from "./master-ai.js";
import type { EntityId } from "./common.js";
import type { Requirement } from "./requirement.js";
import type { TaskKind, TaskStatus } from "./task.js";
import type { WorkerKind, WorkerRunStatus } from "./worker.js";

export interface WorkerTaskPacketTask {
  readonly id: EntityId;
  readonly title: string;
  readonly description: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
}

export interface WorkerTaskPacketExecution {
  readonly workerKind: WorkerKind;
  readonly iteration: number;
  readonly status: WorkerRunStatus;
  readonly ownerId?: EntityId;
}

/** Bounded task context for a claimed worker run. Authoritative state is on the control plane. */
export interface WorkerTaskPacket {
  readonly workerRunId: EntityId;
  readonly taskId: EntityId;
  readonly projectId: EntityId;
  readonly task: WorkerTaskPacketTask;
  readonly requirements: readonly Requirement[];
  readonly releaseContract?: ReleaseContract;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly blockers: readonly Blocker[];
  readonly doNotModifyConstraints: readonly string[];
  readonly targetRepository?: string;
  readonly targetRef?: string;
  readonly execution: WorkerTaskPacketExecution;
}

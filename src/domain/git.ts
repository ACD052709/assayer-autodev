import type { EntityId, ISOTimestamp, Provenance, Timestamps } from "./common.js";

export interface GitRevision extends Timestamps, Provenance {
  readonly id: EntityId;
  readonly commitSha: string;
  readonly branch?: string;
  readonly tag?: string;
  readonly message?: string;
  readonly authoredAt?: ISOTimestamp;
}

export type DeploymentStatus = "pending" | "in_progress" | "live" | "failed" | "rolled_back";

export interface Deployment extends Timestamps, Provenance {
  readonly id: EntityId;
  readonly gitRevisionId: EntityId;
  readonly environment: string;
  readonly status: DeploymentStatus;
  readonly statusChangedAt: ISOTimestamp;
  readonly url?: string;
}

export interface CreateGitRevisionInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId?: EntityId;
  readonly commitSha: string;
  readonly branch?: string;
  readonly tag?: string;
  readonly message?: string;
  readonly authoredAt?: ISOTimestamp;
}

export interface CreateDeploymentInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId?: EntityId;
  readonly gitRevisionId: EntityId;
  readonly environment: string;
  readonly url?: string;
}

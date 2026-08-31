import type { EntityId, Provenance, StatusRecord, Timestamps } from "./common.js";
import type { ProjectStatus } from "./common.js";

export interface Project extends Timestamps, StatusRecord<ProjectStatus> {
  readonly id: EntityId;
  readonly name: string;
  readonly description: string;
  readonly targetRepository?: string;
  readonly targetRef?: string;
  readonly targetTestCommand?: string;
  readonly doNotModifyConstraints: readonly string[];
}

export interface ProjectRef {
  readonly projectId: EntityId;
}

export function projectProvenance(projectId: EntityId): Provenance {
  return { projectId };
}

export interface CreateProjectInput {
  readonly id: EntityId;
  readonly name: string;
  readonly description: string;
  readonly targetRepository?: string;
  readonly targetRef?: string;
  readonly targetTestCommand?: string;
  readonly doNotModifyConstraints?: readonly string[];
}

export interface UpdateProjectWorkerTargetInput {
  readonly projectId: EntityId;
  readonly targetRepository?: string;
  readonly targetRef?: string;
  readonly targetTestCommand?: string;
  readonly doNotModifyConstraints?: readonly string[];
}

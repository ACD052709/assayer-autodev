import type { EntityId, Provenance, StatusRecord, Timestamps } from "./common.js";
import type { ProjectStatus } from "./common.js";

export interface Project extends Timestamps, StatusRecord<ProjectStatus> {
  readonly id: EntityId;
  readonly name: string;
  readonly description: string;
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
}

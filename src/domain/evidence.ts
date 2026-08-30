import type { EntityId, Provenance, Timestamps } from "./common.js";

export type EvidenceKind =
  | "screenshot"
  | "log"
  | "artifact"
  | "report"
  | "diff"
  | "other";

export interface Evidence extends Timestamps, Provenance {
  readonly id: EntityId;
  readonly kind: EvidenceKind;
  readonly label: string;
  readonly uri?: string;
  readonly contentRef?: string;
  readonly mimeType?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateEvidenceInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId?: EntityId;
  readonly workerRunId?: EntityId;
  readonly verifierRunId?: EntityId;
  readonly gitRevisionId?: EntityId;
  readonly deploymentId?: EntityId;
  readonly kind: EvidenceKind;
  readonly label: string;
  readonly uri?: string;
  readonly contentRef?: string;
  readonly mimeType?: string;
  readonly metadata?: Record<string, unknown>;
}

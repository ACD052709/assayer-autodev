import type { EntityId, PermissionDecision, Provenance, StatusRecord, Timestamps } from "./common.js";

export type PermissionScope =
  | "filesystem"
  | "network"
  | "git"
  | "deployment"
  | "external_api"
  | "cost";

export interface PermissionRequest extends Timestamps, Provenance {
  readonly id: EntityId;
  readonly scope: PermissionScope;
  readonly action: string;
  readonly resource: string;
  readonly rationale?: string;
}

export interface Permission extends Timestamps, StatusRecord<"pending" | "decided">, Provenance {
  readonly id: EntityId;
  readonly requestId: EntityId;
  readonly decision: PermissionDecision;
  readonly decidedBy?: "master" | "human" | "policy";
  readonly notes?: string;
}

export interface CreatePermissionRequestInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId?: EntityId;
  readonly workerRunId?: EntityId;
  readonly scope: PermissionScope;
  readonly action: string;
  readonly resource: string;
  readonly rationale?: string;
}

export interface DecidePermissionInput {
  readonly permissionId: EntityId;
  readonly decision: PermissionDecision;
  readonly decidedBy: Permission["decidedBy"];
  readonly notes?: string;
}

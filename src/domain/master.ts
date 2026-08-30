import type { EntityId, ISOTimestamp, StatusRecord, Timestamps } from "./common.js";

export type MasterInboxItemKind =
  | "worker_report"
  | "verification_result"
  | "permission_request"
  | "budget_alert"
  | "task_update"
  | "human_message";

export type MasterInboxItemStatus = "unread" | "acknowledged" | "processed" | "archived";

export interface MasterInboxItem extends Timestamps, StatusRecord<MasterInboxItemStatus> {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly kind: MasterInboxItemKind;
  readonly subject: string;
  readonly body: string;
  readonly relatedEntityId?: EntityId;
  readonly receivedAt: ISOTimestamp;
}

export type MasterPhase =
  | "initializing"
  | "planning"
  | "executing"
  | "verifying"
  | "accepting"
  | "paused"
  | "completed"
  | "failed";

export interface MasterState extends Timestamps, StatusRecord<MasterPhase> {
  readonly projectId: EntityId;
  readonly activeTaskIds: readonly EntityId[];
  readonly inboxItemIds: readonly EntityId[];
  readonly lastDirectorActionAt?: ISOTimestamp;
}

export interface CreateMasterInboxItemInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly kind: MasterInboxItemKind;
  readonly subject: string;
  readonly body: string;
  readonly relatedEntityId?: EntityId;
}

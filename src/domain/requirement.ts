import type { EntityId, ISOTimestamp, StatusRecord, Timestamps } from "./common.js";

export type RequirementStatus = "draft" | "approved" | "superseded" | "rejected";

export interface Requirement extends Timestamps, StatusRecord<RequirementStatus> {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly title: string;
  readonly description: string;
  readonly priority: number;
  readonly source?: string;
}

export interface CreateRequirementInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly title: string;
  readonly description: string;
  readonly priority?: number;
  readonly source?: string;
}

export interface DefinitionOfDoneCriterion {
  readonly id: EntityId;
  readonly description: string;
  readonly requirementIds: readonly EntityId[];
}

export interface DefinitionOfDone extends Timestamps {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly version: number;
  readonly criteria: readonly DefinitionOfDoneCriterion[];
  readonly notes?: string;
}

export interface CreateDefinitionOfDoneInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly version: number;
  readonly criteria: readonly DefinitionOfDoneCriterion[];
  readonly notes?: string;
}

export interface FinalAcceptanceRun extends Timestamps, StatusRecord<"pending" | "running" | "completed"> {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly definitionOfDoneId: EntityId;
  readonly outcome?: import("./common.js").VerificationOutcome;
  readonly completedAt?: ISOTimestamp;
  readonly notes?: string;
}

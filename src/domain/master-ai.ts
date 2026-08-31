import type { EntityId, StatusRecord, Timestamps } from "./common.js";
import type { BudgetLedger } from "./budget.js";
import type { Evidence, EvidenceKind } from "./evidence.js";
import type { MasterInboxItem, MasterState } from "./master.js";
import type { Project } from "./project.js";
import type { DefinitionOfDone, Requirement } from "./requirement.js";
import type { Task, TaskKind } from "./task.js";
import type { TestCase, TestResult } from "./test.js";
import type { VerifierRun } from "./verifier.js";

/** Model-proposed director actions. Code-level gates may override these. */
export type MasterAction =
  | "CREATE_TASKS"
  | "WAIT_FOR_WORKERS"
  | "REQUEST_VERIFICATION"
  | "REQUEST_HUMAN_APPROVAL"
  | "REPLAN"
  | "FINAL_ACCEPTANCE"
  | "FINISHED"
  | "BLOCKED";

export const MASTER_ACTIONS: readonly MasterAction[] = [
  "CREATE_TASKS",
  "WAIT_FOR_WORKERS",
  "REQUEST_VERIFICATION",
  "REQUEST_HUMAN_APPROVAL",
  "REPLAN",
  "FINAL_ACCEPTANCE",
  "FINISHED",
  "BLOCKED",
];

export type AcceptanceCriterionStatus = "pending" | "PASS" | "FAIL" | "not_applicable";

export type BlockerKind =
  | "requirement"
  | "verification"
  | "budget"
  | "permission"
  | "dependency"
  | "other";

export type BlockerStatus = "open" | "resolved";

export type MasterRunStatus = "completed" | "blocked" | "rejected" | "failed";

export interface AcceptanceCriterion extends Timestamps, StatusRecord<AcceptanceCriterionStatus> {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly releaseContractId: EntityId;
  readonly description: string;
  readonly requirementIds: readonly EntityId[];
  readonly applicable: boolean;
  readonly evidenceIds: readonly EntityId[];
}

export interface Blocker extends Timestamps, StatusRecord<BlockerStatus> {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly kind: BlockerKind;
  readonly summary: string;
  readonly details?: string;
  readonly relatedEntityId?: EntityId;
}

export interface ReleaseContract extends Timestamps {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly version: number;
  readonly requiredEvidenceKinds: readonly EvidenceKind[];
  readonly requiredEvidenceLabels: readonly string[];
  readonly notes?: string;
}

export interface TaskProposal {
  readonly clientKey: string;
  readonly title: string;
  readonly description: string;
  readonly kind: TaskKind;
  readonly dependencyClientKeys: readonly string[];
  readonly existingDependencyIds: readonly EntityId[];
}

export interface MasterDecision {
  readonly action: MasterAction;
  readonly rationale: string;
  readonly taskProposals: readonly TaskProposal[];
  readonly claimedFinished: boolean;
  readonly humanApprovalReason: string;
  /** Advisory model text only. Not persisted as authoritative Blocker rows. */
  readonly blockerSummaries: readonly string[];
}

export interface MasterInput {
  readonly projectId: EntityId;
  readonly objective: string;
  readonly trigger?: string;
  readonly context?: string;
  readonly project: Project;
  readonly masterState: MasterState;
  readonly requirements: readonly Requirement[];
  readonly definitionsOfDone: readonly DefinitionOfDone[];
  readonly tasks: readonly Task[];
  readonly verifierRuns: readonly VerifierRun[];
  readonly testCases: readonly TestCase[];
  readonly testResults: readonly TestResult[];
  readonly evidence: readonly Evidence[];
  readonly budget: BudgetLedger | undefined;
  readonly releaseContract: ReleaseContract | undefined;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly blockers: readonly Blocker[];
  readonly inbox: readonly MasterInboxItem[];
}

export interface MasterOutput {
  readonly decision: MasterDecision;
  readonly model: string;
  readonly promptVersion: string;
}

export interface MasterRun extends Timestamps, StatusRecord<MasterRunStatus> {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly trigger?: string;
  readonly context?: string;
  readonly proposedAction: MasterAction;
  readonly enforcedAction: MasterAction;
  readonly rationale: string;
  readonly finishedBlockedReasons: readonly string[];
  readonly createdTaskIds: readonly EntityId[];
  readonly promptVersion: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCost?: number;
  /** Present when usage exists. "unavailable" means pricing could not be resolved — never a fake $0. */
  readonly costStatus?: "available" | "unavailable";
}

export interface CreateReleaseContractInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly version: number;
  readonly requiredEvidenceKinds: readonly EvidenceKind[];
  readonly requiredEvidenceLabels?: readonly string[];
  readonly notes?: string;
}

export interface CreateAcceptanceCriterionInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly releaseContractId: EntityId;
  readonly description: string;
  readonly requirementIds?: readonly EntityId[];
  readonly applicable?: boolean;
}

export interface UpdateAcceptanceCriterionInput {
  readonly id: EntityId;
  readonly status: AcceptanceCriterionStatus;
  readonly evidenceIds?: readonly EntityId[];
}

export interface CreateBlockerInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly kind: BlockerKind;
  readonly summary: string;
  readonly details?: string;
  readonly relatedEntityId?: EntityId;
}

export interface CreateMasterRunInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly trigger?: string;
  readonly context?: string;
  readonly proposedAction: MasterAction;
  readonly enforcedAction: MasterAction;
  readonly rationale: string;
  readonly finishedBlockedReasons?: readonly string[];
  readonly createdTaskIds?: readonly EntityId[];
  readonly promptVersion: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCost?: number;
  readonly costStatus?: "available" | "unavailable";
  readonly status: MasterRunStatus;
}

export function isMasterAction(value: string): value is MasterAction {
  return (MASTER_ACTIONS as readonly string[]).includes(value);
}

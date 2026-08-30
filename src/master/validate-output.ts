import type { MasterDecision, TaskKind, TaskProposal } from "../domain/index.js";
import { isMasterAction } from "../domain/index.js";

const ENTITY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const TASK_KINDS = new Set<TaskKind>([
  "planning",
  "implementation",
  "verification",
  "deployment",
  "acceptance",
]);

export class MasterOutputValidationError extends Error {
  readonly code = "model_output_invalid";

  constructor(message: string) {
    super(message);
    this.name = "MasterOutputValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MasterOutputValidationError(`Invalid ${field}`);
  }
  return value;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new MasterOutputValidationError(`Invalid ${field}`);
  }
  return value;
}

function assertStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MasterOutputValidationError(`Invalid ${field}`);
  }
  return value;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new MasterOutputValidationError(`Unknown field: ${key}`);
    }
  }
}

function parseTaskProposal(value: unknown, index: number): TaskProposal {
  if (!isRecord(value)) {
    throw new MasterOutputValidationError(`Invalid taskProposals[${index}]`);
  }
  rejectUnknownKeys(value, [
    "clientKey",
    "title",
    "description",
    "kind",
    "dependencyClientKeys",
    "existingDependencyIds",
  ]);
  const clientKey = assertString(value.clientKey, `taskProposals[${index}].clientKey`).trim();
  const title = assertString(value.title, `taskProposals[${index}].title`).trim();
  const description = assertString(value.description, `taskProposals[${index}].description`).trim();
  const kind = assertString(value.kind, `taskProposals[${index}].kind`);
  if (clientKey.length === 0 || title.length === 0 || description.length === 0) {
    throw new MasterOutputValidationError(`Empty taskProposals[${index}] field`);
  }
  if (!TASK_KINDS.has(kind as TaskKind)) {
    throw new MasterOutputValidationError(`Invalid taskProposals[${index}].kind`);
  }
  const dependencyClientKeys = assertStringArray(
    value.dependencyClientKeys,
    `taskProposals[${index}].dependencyClientKeys`,
  );
  const existingDependencyIds = assertStringArray(
    value.existingDependencyIds,
    `taskProposals[${index}].existingDependencyIds`,
  );
  for (const [depIndex, depId] of existingDependencyIds.entries()) {
    if (!ENTITY_ID_PATTERN.test(depId)) {
      throw new MasterOutputValidationError(
        `Invalid taskProposals[${index}].existingDependencyIds[${depIndex}]`,
      );
    }
  }
  return {
    clientKey,
    title,
    description,
    kind: kind as TaskKind,
    dependencyClientKeys,
    existingDependencyIds,
  };
}

function assertAcyclicProposals(proposals: readonly TaskProposal[]): void {
  const keys = new Set(proposals.map((p) => p.clientKey));
  if (keys.size !== proposals.length) {
    throw new MasterOutputValidationError("Duplicate task proposal clientKey");
  }
  for (const proposal of proposals) {
    for (const dep of proposal.dependencyClientKeys) {
      if (dep === proposal.clientKey) {
        throw new MasterOutputValidationError(`Self-dependency on ${proposal.clientKey}`);
      }
      if (!keys.has(dep)) {
        throw new MasterOutputValidationError(`Unknown dependency clientKey: ${dep}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(proposals.map((p) => [p.clientKey, p]));

  const visit = (key: string): void => {
    if (visited.has(key)) {
      return;
    }
    if (visiting.has(key)) {
      throw new MasterOutputValidationError("Cyclic task proposal dependencies");
    }
    visiting.add(key);
    const node = byKey.get(key);
    if (node) {
      for (const dep of node.dependencyClientKeys) {
        visit(dep);
      }
    }
    visiting.delete(key);
    visited.add(key);
  };

  for (const proposal of proposals) {
    visit(proposal.clientKey);
  }
}

export function validateMasterDecision(raw: unknown): MasterDecision {
  if (!isRecord(raw)) {
    throw new MasterOutputValidationError("Model output must be an object");
  }
  rejectUnknownKeys(raw, [
    "action",
    "rationale",
    "claimedFinished",
    "humanApprovalReason",
    "blockerSummaries",
    "taskProposals",
  ]);

  const actionRaw = assertString(raw.action, "action");
  if (!isMasterAction(actionRaw)) {
    throw new MasterOutputValidationError("Invalid action");
  }
  const rationale = assertString(raw.rationale, "rationale").trim();
  if (rationale.length === 0) {
    throw new MasterOutputValidationError("Empty rationale");
  }
  const claimedFinished = assertBoolean(raw.claimedFinished, "claimedFinished");
  const humanApprovalReason = assertString(raw.humanApprovalReason, "humanApprovalReason");
  const blockerSummaries = assertStringArray(raw.blockerSummaries, "blockerSummaries");
  if (!Array.isArray(raw.taskProposals)) {
    throw new MasterOutputValidationError("Invalid taskProposals");
  }
  const taskProposals = raw.taskProposals.map((item, index) => parseTaskProposal(item, index));
  assertAcyclicProposals(taskProposals);

  if (claimedFinished !== (actionRaw === "FINISHED")) {
    throw new MasterOutputValidationError("claimedFinished must match FINISHED action");
  }
  if (actionRaw === "CREATE_TASKS" && taskProposals.length === 0) {
    throw new MasterOutputValidationError("CREATE_TASKS requires at least one task proposal");
  }

  return {
    action: actionRaw,
    rationale,
    taskProposals,
    claimedFinished,
    humanApprovalReason,
    blockerSummaries,
  };
}

export function topologicalTaskProposals(proposals: readonly TaskProposal[]): readonly TaskProposal[] {
  const remaining = new Map(proposals.map((p) => [p.clientKey, p]));
  const ordered: TaskProposal[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((p) =>
      p.dependencyClientKeys.every((dep) => !remaining.has(dep)),
    );
    if (ready.length === 0) {
      throw new MasterOutputValidationError("Cyclic task proposal dependencies");
    }
    for (const proposal of ready) {
      ordered.push(proposal);
      remaining.delete(proposal.clientKey);
    }
  }
  return ordered;
}

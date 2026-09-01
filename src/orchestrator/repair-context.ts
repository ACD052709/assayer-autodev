import type { EntityId } from "../domain/common.js";

/** Embedded in task.description; avoids schema changes while preserving provenance. */
export const REPAIR_CONTEXT_MARKER = "<!--autodev-repair:";

export interface RepairTaskContext {
  readonly originalTaskId: EntityId;
  readonly verifierRunId: EntityId;
  readonly attempt: number;
  readonly failureSummary: string;
  readonly parentCandidateId?: EntityId;
}

export function encodeRepairTaskDescription(
  humanDescription: string,
  context: RepairTaskContext,
): string {
  const payload = JSON.stringify({
    originalTaskId: context.originalTaskId,
    verifierRunId: context.verifierRunId,
    attempt: context.attempt,
    failureSummary: context.failureSummary,
    ...(context.parentCandidateId !== undefined ? { parentCandidateId: context.parentCandidateId } : {}),
  });
  return `${humanDescription}\n${REPAIR_CONTEXT_MARKER}${payload}-->`;
}

export function parseRepairTaskContext(description: string): RepairTaskContext | undefined {
  const start = description.indexOf(REPAIR_CONTEXT_MARKER);
  if (start === -1) {
    return undefined;
  }
  const end = description.indexOf("-->", start);
  if (end === -1) {
    return undefined;
  }
  const json = description.slice(start + REPAIR_CONTEXT_MARKER.length, end);
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof parsed.originalTaskId !== "string" ||
      typeof parsed.verifierRunId !== "string" ||
      typeof parsed.attempt !== "number" ||
      typeof parsed.failureSummary !== "string"
    ) {
      return undefined;
    }
    return {
      originalTaskId: parsed.originalTaskId,
      verifierRunId: parsed.verifierRunId,
      attempt: parsed.attempt,
      failureSummary: parsed.failureSummary,
      ...(typeof parsed.parentCandidateId === "string" ? { parentCandidateId: parsed.parentCandidateId } : {}),
    };
  } catch {
    return undefined;
  }
}

export function stripRepairTaskContext(description: string): string {
  const start = description.indexOf(REPAIR_CONTEXT_MARKER);
  if (start === -1) {
    return description.trim();
  }
  return description.slice(0, start).trim();
}

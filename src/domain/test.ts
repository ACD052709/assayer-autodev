import type { EntityId, Provenance, StatusRecord, Timestamps, VerificationOutcome } from "./common.js";

export type TestCaseKind = "unit" | "integration" | "browser" | "acceptance";

export interface TestCase extends Timestamps, StatusRecord<"active" | "disabled">, Provenance {
  readonly id: EntityId;
  readonly name: string;
  readonly description: string;
  readonly kind: TestCaseKind;
}

export interface TestResult extends Timestamps, Provenance {
  readonly id: EntityId;
  readonly testCaseId: EntityId;
  readonly workerRunId?: EntityId;
  readonly verifierRunId?: EntityId;
  readonly outcome: VerificationOutcome;
  readonly message?: string;
  readonly durationMs?: number;
}

export interface CreateTestCaseInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly taskId?: EntityId;
  readonly name: string;
  readonly description: string;
  readonly kind: TestCaseKind;
}

export interface CreateTestResultInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly testCaseId: EntityId;
  readonly taskId?: EntityId;
  readonly workerRunId?: EntityId;
  readonly verifierRunId?: EntityId;
  readonly outcome: VerificationOutcome;
  readonly message?: string;
  readonly durationMs?: number;
}

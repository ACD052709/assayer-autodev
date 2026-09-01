import type { EntityId, VerificationOutcome } from "../domain/common.js";
import type { AsyncStateStore } from "../state/async-store.js";
import type { IdFactory } from "../master/ids.js";
import { testCaseIdForTask, verifierRunIdForAttempt } from "./state.js";

export interface VerifierAdapterRunInput {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly workerRunId: EntityId;
  readonly verifierRunId: EntityId;
  readonly codeCandidateId: EntityId;
  readonly testCaseId: EntityId;
  readonly attempt: number;
}

export interface VerifierAdapterRunResult {
  readonly verifierRunId: EntityId;
  /** When true, verification continues asynchronously via an external executor. */
  readonly scheduled?: boolean;
  readonly outcome?: VerificationOutcome;
  readonly summary: string;
  readonly evidenceIds: readonly EntityId[];
  readonly testResultId: EntityId;
}

export interface VerifierAdapter {
  runVerification(input: VerifierAdapterRunInput): Promise<VerifierAdapterRunResult>;
}

export interface DeterministicVerifierAdapterOptions {
  readonly store: AsyncStateStore;
  readonly idFactory: IdFactory;
  /** Task id → outcome for the next verification run. */
  readonly outcomesByTaskId: Readonly<Record<EntityId, VerificationOutcome>>;
}

/**
 * Store-backed verifier for local orchestration tests.
 * Persists verifier runs, evidence, and test results without Playwright.
 */
export function createDeterministicVerifierAdapter(
  options: DeterministicVerifierAdapterOptions,
): VerifierAdapter {
  return {
    async runVerification(input) {
      const outcome = options.outcomesByTaskId[input.taskId];
      if (outcome === undefined) {
        throw new Error(`No deterministic verifier outcome configured for task ${input.taskId}`);
      }
      const summary =
        outcome === "PASS"
          ? `Deterministic verification passed for ${input.taskId}`
          : `Deterministic verification failed for ${input.taskId}`;

      await options.store.createVerifierRun({
        id: input.verifierRunId,
        projectId: input.projectId,
        taskId: input.taskId,
        codeCandidateId: input.codeCandidateId,
      });

      const evidenceId = options.idFactory.next("ev");
      await options.store.createEvidence({
        id: evidenceId,
        projectId: input.projectId,
        kind: "report",
        label: `verifier-report-${input.verifierRunId}`,
        taskId: input.taskId,
        verifierRunId: input.verifierRunId,
        metadata: {
          taskId: input.taskId,
          workerRunId: input.workerRunId,
          attempt: input.attempt,
          outcome,
        },
      });

      const testResultId = options.idFactory.next("tr");
      await options.store.recordTestResult({
        id: testResultId,
        projectId: input.projectId,
        testCaseId: input.testCaseId,
        taskId: input.taskId,
        workerRunId: input.workerRunId,
        verifierRunId: input.verifierRunId,
        outcome,
        message: summary,
        durationMs: 1,
      });

      await options.store.completeVerifierRun({
        verifierRunId: input.verifierRunId,
        outcome,
        summary,
        evidenceIds: [evidenceId],
      });

      return {
        verifierRunId: input.verifierRunId,
        scheduled: false,
        outcome,
        summary,
        evidenceIds: [evidenceId],
        testResultId,
      };
    },
  };
}

export function resolveVerificationAttempt(
  completedAttempts: number,
  pendingExists: boolean,
): number | undefined {
  if (pendingExists) {
    return undefined;
  }
  return completedAttempts;
}

export function buildVerificationRunInput(
  projectId: EntityId,
  taskId: EntityId,
  workerRunId: EntityId,
  codeCandidateId: EntityId,
  attempt: number,
): VerifierAdapterRunInput {
  return {
    projectId,
    taskId,
    workerRunId,
    verifierRunId: verifierRunIdForAttempt(taskId, workerRunId, attempt),
    codeCandidateId,
    testCaseId: testCaseIdForTask(taskId),
    attempt,
  };
}

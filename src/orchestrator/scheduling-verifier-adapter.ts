import type { AsyncStateStore } from "../state/async-store.js";
import type { VerifierAdapter, VerifierAdapterRunInput, VerifierAdapterRunResult } from "./verifier-adapter.js";
import type { VerifierLaunchBridge } from "./verifier-launch-bridge.js";

export interface SchedulingVerifierAdapterOptions {
  readonly store: AsyncStateStore;
  readonly launchBridge: VerifierLaunchBridge;
}

/**
 * Schedules independent browser verification through an external Node + Playwright boundary.
 * Creates a pending verifier run, dispatches workflow, and returns without waiting for completion.
 */
export function createSchedulingVerifierAdapter(
  options: SchedulingVerifierAdapterOptions,
): VerifierAdapter {
  return {
    async runVerification(input: VerifierAdapterRunInput): Promise<VerifierAdapterRunResult> {
      await options.store.createVerifierRun({
        id: input.verifierRunId,
        projectId: input.projectId,
        taskId: input.taskId,
        codeCandidateId: input.codeCandidateId,
      });

      const launch = await options.launchBridge.launch({
        verifierRunId: input.verifierRunId,
        projectId: input.projectId,
        taskId: input.taskId,
        testCaseId: input.testCaseId,
        workerRunId: input.workerRunId,
        codeCandidateId: input.codeCandidateId,
      });

      if (!launch.launched) {
        const summary = launch.errorMessage ?? launch.reason ?? "Verifier launch failed";
        await options.store.completeVerifierRun({
          verifierRunId: input.verifierRunId,
          outcome: "FAIL",
          summary,
        });
        return {
          verifierRunId: input.verifierRunId,
          scheduled: false,
          outcome: "FAIL",
          summary,
          evidenceIds: [],
          testResultId: "",
        };
      }

      return {
        verifierRunId: input.verifierRunId,
        scheduled: true,
        summary: `Scheduled external browser verification for ${input.taskId}`,
        evidenceIds: [],
        testResultId: "",
      };
    },
  };
}

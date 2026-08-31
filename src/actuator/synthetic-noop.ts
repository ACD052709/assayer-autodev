import { SYNTHETIC_NOOP_KIND } from "./types.js";
import { ActuatorError } from "./errors.js";

export interface SyntheticNoopInput {
  readonly workerRunId: string;
  readonly durationMs: number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
}

export interface SyntheticNoopOutcome {
  readonly kind: typeof SYNTHETIC_NOOP_KIND;
  readonly externalRepositoryModified: false;
  readonly codingAgentUsed: false;
  readonly checksum: number;
}

/**
 * In-process synthetic workload. Does not spawn shells, clone repos, or write files.
 */
export async function runSyntheticNoop(input: SyntheticNoopInput): Promise<SyntheticNoopOutcome> {
  if (input.signal.aborted) {
    throw new ActuatorError("ABORTED", "Synthetic work aborted");
  }
  await input.sleep(input.durationMs, input.signal);
  let checksum = 0;
  for (let i = 0; i < input.workerRunId.length; i += 1) {
    checksum = (checksum + input.workerRunId.charCodeAt(i) * (i + 1)) % 2_147_483_647;
  }
  return {
    kind: SYNTHETIC_NOOP_KIND,
    externalRepositoryModified: false,
    codingAgentUsed: false,
    checksum,
  };
}

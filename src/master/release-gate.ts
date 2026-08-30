import type { MasterInput } from "../domain/index.js";

export interface FinishedGateResult {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

function latestResultByCase(
  input: MasterInput,
  testCaseId: string,
): MasterInput["testResults"][number] | undefined {
  const matches = input.testResults.filter((r) => r.testCaseId === testCaseId);
  if (matches.length === 0) {
    return undefined;
  }
  return [...matches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * Deterministic FINISHED gate. Model output cannot bypass these checks.
 *
 * FINISHED requires all of:
 * - a stored release contract
 * - every applicable acceptance criterion PASS
 * - zero open blockers
 * - final independent verification PASS (completed verifier run on an acceptance task)
 * - final regression PASS (latest result for every regression test case is PASS, and at least one exists)
 * - required evidence kinds and labels from the contract are present
 */
export function evaluateFinishedGate(input: MasterInput): FinishedGateResult {
  const reasons: string[] = [];
  const contract = input.releaseContract;

  if (contract === undefined) {
    reasons.push("no_release_contract");
  }

  const contractCriteria =
    contract === undefined
      ? []
      : input.acceptanceCriteria.filter((c) => c.releaseContractId === contract.id);
  const applicable = contractCriteria.filter((c) => c.applicable && c.status !== "not_applicable");
  if (contract !== undefined && applicable.length === 0) {
    reasons.push("no_applicable_acceptance_criteria");
  }
  for (const criterion of applicable) {
    if (criterion.status !== "PASS") {
      reasons.push(`acceptance_criterion_not_pass:${criterion.id}`);
    }
  }

  const openBlockers = input.blockers.filter((b) => b.status === "open");
  if (openBlockers.length > 0) {
    reasons.push("unresolved_blockers");
  }

  const tasksById = new Map(input.tasks.map((t) => [t.id, t]));
  const independentPass = input.verifierRuns.some((run) => {
    if (run.status !== "completed" || run.outcome !== "PASS") {
      return false;
    }
    const task = tasksById.get(run.taskId);
    return task?.kind === "acceptance";
  });
  if (!independentPass) {
    reasons.push("independent_verification_not_pass");
  }

  const regressionCases = input.testCases.filter((c) => c.kind === "regression" && c.status === "active");
  if (regressionCases.length === 0) {
    reasons.push("no_regression_results");
  } else {
    for (const testCase of regressionCases) {
      const latest = latestResultByCase(input, testCase.id);
      if (latest === undefined || latest.outcome !== "PASS") {
        reasons.push(`regression_not_pass:${testCase.id}`);
      }
    }
  }

  if (contract !== undefined) {
    for (const kind of contract.requiredEvidenceKinds) {
      if (!input.evidence.some((item) => item.kind === kind)) {
        reasons.push(`required_evidence_kind_missing:${kind}`);
      }
    }
    for (const label of contract.requiredEvidenceLabels) {
      if (!input.evidence.some((item) => item.label === label)) {
        reasons.push(`required_evidence_label_missing:${label}`);
      }
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

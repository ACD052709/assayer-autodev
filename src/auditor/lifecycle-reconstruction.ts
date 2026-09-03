export type LifecycleEvidenceType =
  | "TASK_CREATED"
  | "WORKER_ASSIGNED"
  | "LEASE_ACQUIRED"
  | "BUILDER_STARTED"
  | "BUILDER_COMPLETED"
  | "BUILDER_FAILED"
  | "LEASE_EXPIRED"
  | "ARTIFACT_CREATED"
  | "VERIFIER_STARTED"
  | "VERIFIER_PASS"
  | "VERIFIER_FAIL"
  | "REPAIR_STARTED"
  | "REPAIR_COMPLETED"
  | "TASK_COMPLETED"
  | "TASK_FAILED";

export interface LifecycleEvidenceEvent {
  readonly id: string;
  readonly type: LifecycleEvidenceType;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly codeCandidateId?: string;
  readonly parentCodeCandidateId?: string;
}

export type LifecycleAuditStatus =
  | "NO_FAILURE"
  | "DIAGNOSED"
  | "INCOMPLETE_EVIDENCE"
  | "INTEGRITY_VIOLATION";

export type LifecycleFailureBoundary =
  | "BUILDER_EXECUTION"
  | "BUILDER_TERMINATION"
  | "VERIFICATION";

export type LifecycleUnknown =
  | "BUILDER_START_STATE"
  | "BUILDER_TERMINAL_STATE"
  | "BUILDER_TERMINATION_CAUSE"
  | "ARTIFACT_CREATION_STATE"
  | "VERIFIER_TERMINAL_STATE"
  | "TASK_TERMINAL_STATE";

export type LifecycleDownstreamConsequence =
  | "ARTIFACT_NOT_CREATED"
  | "VERIFIER_NOT_STARTED"
  | "TASK_NOT_COMPLETED"
  | "TASK_FAILED";

export type LifecycleIntegrityFinding =
  | "ARTIFACT_BEFORE_BUILD_COMPLETION"
  | "VERIFIER_BEFORE_ARTIFACT"
  | "VERIFIER_MISSING_CANDIDATE_BINDING"
  | "VERIFIER_WRONG_CANDIDATE"
  | "REPAIR_WITHOUT_VERIFIER_REJECTION"
  | "REPAIRED_CANDIDATE_PARENT_MISMATCH"
  | "TASK_COMPLETED_WITHOUT_VERIFIER_PASS";

export interface CandidateTransition {
  readonly codeCandidateId: string;
  readonly parentCodeCandidateId?: string;
}

export interface VerificationTransition {
  readonly eventId: string;
  readonly codeCandidateId: string;
  readonly outcome: "PASS" | "FAIL";
}

export interface LifecycleAuditResult {
  readonly status: LifecycleAuditStatus;
  readonly firstProvenFailureBoundary?: LifecycleFailureBoundary;
  readonly provenCausalEventId?: string;
  readonly provenEventIds: readonly string[];
  readonly unknowns: readonly LifecycleUnknown[];
  readonly downstreamConsequences: readonly LifecycleDownstreamConsequence[];
  readonly integrityFindings: readonly LifecycleIntegrityFinding[];
  readonly candidateLineage: readonly CandidateTransition[];
  readonly verifications: readonly VerificationTransition[];
  readonly repairObserved: boolean;
}

function pushUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) {
    items.push(item);
  }
}

/**
 * Reconstructs one ordered lifecycle evidence history.
 *
 * Event order is evidence supplied by the caller. This function deliberately
 * does not infer missing events or invent ordering. The real persistence
 * adapter is a separate validation concern.
 */
export function reconstructLifecycle(
  events: readonly LifecycleEvidenceEvent[],
): LifecycleAuditResult {
  const provenEventIds = events.map((event) => event.id);
  const unknowns: LifecycleUnknown[] = [];
  const downstreamConsequences: LifecycleDownstreamConsequence[] = [];
  const integrityFindings: LifecycleIntegrityFinding[] = [];
  const candidateLineage: CandidateTransition[] = [];
  const verifications: VerificationTransition[] = [];

  let builderStarted = false;
  let builderCompleted = false;
  let builderTerminal = false;
  let builderFailureEventId: string | undefined;
  let leaseExpiredEventId: string | undefined;

  let artifactObserved = false;
  let verifierStarted = false;
  let currentCandidateId: string | undefined;
  let lastRejectedCandidateId: string | undefined;
  let lastVerifierFailureEventId: string | undefined;
  let validPassCandidateId: string | undefined;

  let repairStarted = false;
  let repairCompleted = false;
  let repairObserved = false;

  let taskCompleted = false;
  let taskFailed = false;

  function verifierBindingIsValid(event: LifecycleEvidenceEvent): event is LifecycleEvidenceEvent & {
    readonly codeCandidateId: string;
  } {
    if (currentCandidateId === undefined) {
      pushUnique(integrityFindings, "VERIFIER_BEFORE_ARTIFACT");
      return false;
    }

    if (event.codeCandidateId === undefined) {
      pushUnique(integrityFindings, "VERIFIER_MISSING_CANDIDATE_BINDING");
      return false;
    }

    if (event.codeCandidateId !== currentCandidateId) {
      pushUnique(integrityFindings, "VERIFIER_WRONG_CANDIDATE");
      return false;
    }

    return true;
  }

  for (const event of events) {
    switch (event.type) {
      case "TASK_CREATED":
      case "WORKER_ASSIGNED":
      case "LEASE_ACQUIRED":
        break;

      case "BUILDER_STARTED":
        builderStarted = true;
        break;

      case "BUILDER_COMPLETED":
        builderCompleted = true;
        builderTerminal = true;
        break;

      case "BUILDER_FAILED":
        builderTerminal = true;
        builderFailureEventId = event.id;
        break;

      case "LEASE_EXPIRED":
        leaseExpiredEventId = event.id;
        break;

      case "ARTIFACT_CREATED": {
        if (!builderCompleted && !repairCompleted) {
          pushUnique(integrityFindings, "ARTIFACT_BEFORE_BUILD_COMPLETION");
        }

        if (event.codeCandidateId === undefined) {
          break;
        }

        if (
          repairCompleted &&
          event.parentCodeCandidateId !== lastRejectedCandidateId
        ) {
          pushUnique(
            integrityFindings,
            "REPAIRED_CANDIDATE_PARENT_MISMATCH",
          );
        }

        candidateLineage.push({
          codeCandidateId: event.codeCandidateId,
          ...(event.parentCodeCandidateId !== undefined
            ? { parentCodeCandidateId: event.parentCodeCandidateId }
            : {}),
        });

        currentCandidateId = event.codeCandidateId;
        artifactObserved = true;
        repairCompleted = false;
        validPassCandidateId = undefined;
        break;
      }

      case "VERIFIER_STARTED":
        verifierStarted = true;
        verifierBindingIsValid(event);
        break;

      case "VERIFIER_FAIL":
        if (verifierBindingIsValid(event)) {
          verifications.push({
            eventId: event.id,
            codeCandidateId: event.codeCandidateId,
            outcome: "FAIL",
          });
          lastRejectedCandidateId = event.codeCandidateId;
          lastVerifierFailureEventId = event.id;
          validPassCandidateId = undefined;
        }
        break;

      case "VERIFIER_PASS":
        if (verifierBindingIsValid(event)) {
          verifications.push({
            eventId: event.id,
            codeCandidateId: event.codeCandidateId,
            outcome: "PASS",
          });
          validPassCandidateId = event.codeCandidateId;
        }
        break;

      case "REPAIR_STARTED":
        repairObserved = true;
        if (lastRejectedCandidateId === undefined) {
          pushUnique(
            integrityFindings,
            "REPAIR_WITHOUT_VERIFIER_REJECTION",
          );
        }
        repairStarted = true;
        break;

      case "REPAIR_COMPLETED":
        repairObserved = true;
        if (!repairStarted || lastRejectedCandidateId === undefined) {
          pushUnique(
            integrityFindings,
            "REPAIR_WITHOUT_VERIFIER_REJECTION",
          );
        }
        repairStarted = false;
        repairCompleted = true;
        break;

      case "TASK_COMPLETED":
        taskCompleted = true;
        if (
          currentCandidateId === undefined ||
          validPassCandidateId !== currentCandidateId
        ) {
          pushUnique(
            integrityFindings,
            "TASK_COMPLETED_WITHOUT_VERIFIER_PASS",
          );
        }
        break;

      case "TASK_FAILED":
        taskFailed = true;
        break;
    }
  }

  const base = {
    provenEventIds,
    unknowns,
    downstreamConsequences,
    integrityFindings,
    candidateLineage,
    verifications,
    repairObserved,
  };

  if (integrityFindings.length > 0) {
    return {
      status: "INTEGRITY_VIOLATION",
      ...base,
    };
  }

  if (builderFailureEventId !== undefined) {
    if (!artifactObserved) {
      pushUnique(downstreamConsequences, "ARTIFACT_NOT_CREATED");
    }
    if (!verifierStarted) {
      pushUnique(downstreamConsequences, "VERIFIER_NOT_STARTED");
    }
    if (taskFailed) {
      pushUnique(downstreamConsequences, "TASK_FAILED");
    } else if (!taskCompleted) {
      pushUnique(downstreamConsequences, "TASK_NOT_COMPLETED");
    }

    return {
      status: "DIAGNOSED",
      firstProvenFailureBoundary: "BUILDER_EXECUTION",
      provenCausalEventId: builderFailureEventId,
      ...base,
    };
  }

  if (builderStarted && !builderTerminal) {
    if (leaseExpiredEventId !== undefined) {
      pushUnique(unknowns, "BUILDER_TERMINATION_CAUSE");

      if (!artifactObserved) {
        pushUnique(downstreamConsequences, "ARTIFACT_NOT_CREATED");
      }
      if (!verifierStarted) {
        pushUnique(downstreamConsequences, "VERIFIER_NOT_STARTED");
      }
      if (!taskCompleted) {
        pushUnique(downstreamConsequences, "TASK_NOT_COMPLETED");
      }

      return {
        status: "DIAGNOSED",
        firstProvenFailureBoundary: "BUILDER_TERMINATION",
        provenCausalEventId: leaseExpiredEventId,
        ...base,
      };
    }

    pushUnique(unknowns, "BUILDER_TERMINAL_STATE");
    return {
      status: "INCOMPLETE_EVIDENCE",
      ...base,
    };
  }

  if (lastVerifierFailureEventId !== undefined && validPassCandidateId === undefined) {
    if (taskFailed) {
      pushUnique(downstreamConsequences, "TASK_FAILED");
    } else if (!taskCompleted) {
      pushUnique(downstreamConsequences, "TASK_NOT_COMPLETED");
    }

    return {
      status: "DIAGNOSED",
      firstProvenFailureBoundary: "VERIFICATION",
      provenCausalEventId: lastVerifierFailureEventId,
      ...base,
    };
  }

  if (taskCompleted && validPassCandidateId === currentCandidateId) {
    return {
      status: "NO_FAILURE",
      ...base,
    };
  }

  if (!builderStarted) {
    pushUnique(unknowns, "BUILDER_START_STATE");
  } else if (builderCompleted && !artifactObserved) {
    pushUnique(unknowns, "ARTIFACT_CREATION_STATE");
  } else if (
    artifactObserved &&
    verifications.length === 0
  ) {
    pushUnique(unknowns, "VERIFIER_TERMINAL_STATE");
  } else {
    pushUnique(unknowns, "TASK_TERMINAL_STATE");
  }

  return {
    status: "INCOMPLETE_EVIDENCE",
    ...base,
  };
}

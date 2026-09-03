import { describe, expect, it } from "vitest";
import {
  reconstructLifecycle,
  type LifecycleEvidenceEvent,
  type LifecycleEvidenceType,
} from "../src/auditor/lifecycle-reconstruction.js";

const TASK_ID = "task-control";

function event(
  id: string,
  type: LifecycleEvidenceType,
  extra: Omit<LifecycleEvidenceEvent, "id" | "type" | "taskId"> = {},
): LifecycleEvidenceEvent {
  return {
    id,
    type,
    taskId: TASK_ID,
    ...extra,
  };
}

describe("auditor lifecycle reconstruction", () => {
  it("T1 reconstructs a clean PASS as NO_FAILURE", () => {
    const result = reconstructLifecycle([
      event("e1", "TASK_CREATED"),
      event("e2", "WORKER_ASSIGNED", { attemptId: "attempt-1" }),
      event("e3", "LEASE_ACQUIRED", { attemptId: "attempt-1" }),
      event("e4", "BUILDER_STARTED", { attemptId: "attempt-1" }),
      event("e5", "BUILDER_COMPLETED", { attemptId: "attempt-1" }),
      event("e6", "ARTIFACT_CREATED", { codeCandidateId: "cand-1" }),
      event("e7", "VERIFIER_STARTED", { codeCandidateId: "cand-1" }),
      event("e8", "VERIFIER_PASS", { codeCandidateId: "cand-1" }),
      event("e9", "TASK_COMPLETED"),
    ]);

    expect(result.status).toBe("NO_FAILURE");
    expect(result.firstProvenFailureBoundary).toBeUndefined();
    expect(result.integrityFindings).toEqual([]);
    expect(result.candidateLineage).toEqual([
      { codeCandidateId: "cand-1" },
    ]);
    expect(result.verifications).toEqual([
      {
        eventId: "e8",
        codeCandidateId: "cand-1",
        outcome: "PASS",
      },
    ]);
  });

  it("T2 diagnoses an explicit builder failure without inventing a deeper cause", () => {
    const result = reconstructLifecycle([
      event("e1", "TASK_CREATED"),
      event("e2", "WORKER_ASSIGNED", { attemptId: "attempt-1" }),
      event("e3", "LEASE_ACQUIRED", { attemptId: "attempt-1" }),
      event("e4", "BUILDER_STARTED", { attemptId: "attempt-1" }),
      event("e5", "BUILDER_FAILED", { attemptId: "attempt-1" }),
      event("e6", "TASK_FAILED"),
    ]);

    expect(result.status).toBe("DIAGNOSED");
    expect(result.firstProvenFailureBoundary).toBe("BUILDER_EXECUTION");
    expect(result.provenCausalEventId).toBe("e5");
    expect(result.unknowns).toEqual([]);
    expect(result.downstreamConsequences).toEqual([
      "ARTIFACT_NOT_CREATED",
      "VERIFIER_NOT_STARTED",
      "TASK_FAILED",
    ]);
  });

  it("T3 distinguishes missing terminal evidence from positively established termination failure", () => {
    const incomplete = reconstructLifecycle([
      event("e1", "TASK_CREATED"),
      event("e2", "WORKER_ASSIGNED", { attemptId: "attempt-1" }),
      event("e3", "LEASE_ACQUIRED", { attemptId: "attempt-1" }),
      event("e4", "BUILDER_STARTED", { attemptId: "attempt-1" }),
    ]);

    expect(incomplete.status).toBe("INCOMPLETE_EVIDENCE");
    expect(incomplete.firstProvenFailureBoundary).toBeUndefined();
    expect(incomplete.provenCausalEventId).toBeUndefined();
    expect(incomplete.unknowns).toEqual(["BUILDER_TERMINAL_STATE"]);

    const diagnosed = reconstructLifecycle([
      event("e1", "TASK_CREATED"),
      event("e2", "WORKER_ASSIGNED", { attemptId: "attempt-1" }),
      event("e3", "LEASE_ACQUIRED", { attemptId: "attempt-1" }),
      event("e4", "BUILDER_STARTED", { attemptId: "attempt-1" }),
      event("e5", "LEASE_EXPIRED", { attemptId: "attempt-1" }),
    ]);

    expect(diagnosed.status).toBe("DIAGNOSED");
    expect(diagnosed.firstProvenFailureBoundary).toBe("BUILDER_TERMINATION");
    expect(diagnosed.provenCausalEventId).toBe("e5");

    // The contract failure is proven, but the deeper reason the builder
    // stopped producing terminal evidence remains unknown.
    expect(diagnosed.unknowns).toEqual(["BUILDER_TERMINATION_CAUSE"]);
    expect(diagnosed.downstreamConsequences).toEqual([
      "ARTIFACT_NOT_CREATED",
      "VERIFIER_NOT_STARTED",
      "TASK_NOT_COMPLETED",
    ]);
  });

  it("T4 diagnoses independent verifier rejection and does not accept the candidate", () => {
    const result = reconstructLifecycle([
      event("e1", "TASK_CREATED"),
      event("e2", "WORKER_ASSIGNED"),
      event("e3", "LEASE_ACQUIRED"),
      event("e4", "BUILDER_STARTED"),
      event("e5", "BUILDER_COMPLETED"),
      event("e6", "ARTIFACT_CREATED", { codeCandidateId: "cand-1" }),
      event("e7", "VERIFIER_STARTED", { codeCandidateId: "cand-1" }),
      event("e8", "VERIFIER_FAIL", { codeCandidateId: "cand-1" }),
    ]);

    expect(result.status).toBe("DIAGNOSED");
    expect(result.firstProvenFailureBoundary).toBe("VERIFICATION");
    expect(result.provenCausalEventId).toBe("e8");
    expect(result.downstreamConsequences).toContain("TASK_NOT_COMPLETED");
    expect(result.verifications).toEqual([
      {
        eventId: "e8",
        codeCandidateId: "cand-1",
        outcome: "FAIL",
      },
    ]);
  });

  it("T5 reconstructs FAIL to REPAIR to PASS with coherent candidate lineage", () => {
    const result = reconstructLifecycle([
      event("e1", "TASK_CREATED"),
      event("e2", "WORKER_ASSIGNED", { attemptId: "attempt-1" }),
      event("e3", "LEASE_ACQUIRED", { attemptId: "attempt-1" }),
      event("e4", "BUILDER_STARTED", { attemptId: "attempt-1" }),
      event("e5", "BUILDER_COMPLETED", { attemptId: "attempt-1" }),
      event("e6", "ARTIFACT_CREATED", { codeCandidateId: "cand-1" }),
      event("e7", "VERIFIER_STARTED", { codeCandidateId: "cand-1" }),
      event("e8", "VERIFIER_FAIL", { codeCandidateId: "cand-1" }),
      event("e9", "REPAIR_STARTED", { attemptId: "attempt-2" }),
      event("e10", "REPAIR_COMPLETED", { attemptId: "attempt-2" }),
      event("e11", "ARTIFACT_CREATED", {
        codeCandidateId: "cand-2",
        parentCodeCandidateId: "cand-1",
      }),
      event("e12", "VERIFIER_STARTED", { codeCandidateId: "cand-2" }),
      event("e13", "VERIFIER_PASS", { codeCandidateId: "cand-2" }),
      event("e14", "TASK_COMPLETED"),
    ]);

    expect(result.status).toBe("NO_FAILURE");
    expect(result.repairObserved).toBe(true);
    expect(result.integrityFindings).toEqual([]);
    expect(result.candidateLineage).toEqual([
      { codeCandidateId: "cand-1" },
      {
        codeCandidateId: "cand-2",
        parentCodeCandidateId: "cand-1",
      },
    ]);
    expect(result.verifications).toEqual([
      {
        eventId: "e8",
        codeCandidateId: "cand-1",
        outcome: "FAIL",
      },
      {
        eventId: "e13",
        codeCandidateId: "cand-2",
        outcome: "PASS",
      },
    ]);
  });

  it("T6 reports INTEGRITY_VIOLATION for impossible verifier-before-artifact history", () => {
    const result = reconstructLifecycle([
      event("e1", "TASK_CREATED"),
      event("e2", "WORKER_ASSIGNED"),
      event("e3", "LEASE_ACQUIRED"),
      event("e4", "BUILDER_STARTED"),
      event("e5", "BUILDER_COMPLETED"),
      event("e6", "VERIFIER_STARTED", { codeCandidateId: "cand-1" }),
      event("e7", "VERIFIER_PASS", { codeCandidateId: "cand-1" }),
      event("e8", "ARTIFACT_CREATED", { codeCandidateId: "cand-1" }),
      event("e9", "TASK_COMPLETED"),
    ]);

    expect(result.status).toBe("INTEGRITY_VIOLATION");
    expect(result.integrityFindings).toContain("VERIFIER_BEFORE_ARTIFACT");
  });
});

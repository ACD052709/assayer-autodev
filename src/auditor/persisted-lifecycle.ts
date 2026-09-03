import { LIFECYCLE_EVENTS } from "../executor/events.js";
import type { AsyncStateStore } from "../state/async-store.js";
import type { StateStore } from "../state/store.js";
import {
  reconstructLifecycle,
  type LifecycleAuditResult,
  type LifecycleEvidenceEvent,
} from "./lifecycle-reconstruction.js";

type ReadStore = StateStore | AsyncStateStore;

export type PersistedLifecycleSourceKind =
  | "task"
  | "worker_run"
  | "worker_event"
  | "code_candidate"
  | "verifier_run";

export interface PersistedLifecycleEvidence {
  readonly at: string;
  readonly sourceKind: PersistedLifecycleSourceKind;
  readonly sourceId: string;
  readonly supportingSourceIds: readonly string[];
  readonly lifecycleEvent: LifecycleEvidenceEvent;
}

export interface PersistedTaskLifecycleAudit {
  readonly taskId: string;
  readonly evidence: readonly PersistedLifecycleEvidence[];
  readonly result: LifecycleAuditResult;
}

interface RankedEvidence extends PersistedLifecycleEvidence {
  readonly rank: number;
}

function workerLifecycleName(event: {
  readonly payload?: Record<string, unknown>;
}): string | undefined {
  const value = event.payload?.lifecycle;
  return typeof value === "string" ? value : undefined;
}

function supportingWorkerEventIds(
  events: readonly {
    readonly id: string;
    readonly payload?: Record<string, unknown>;
  }[],
  lifecycleName: string,
): string[] {
  return events
    .filter((event) => workerLifecycleName(event) === lifecycleName)
    .map((event) => event.id);
}

function compareEvidence(a: RankedEvidence, b: RankedEvidence): number {
  const byTime = a.at.localeCompare(b.at);
  if (byTime !== 0) return byTime;

  const byRank = a.rank - b.rank;
  if (byRank !== 0) return byRank;

  const bySource = a.sourceId.localeCompare(b.sourceId);
  if (bySource !== 0) return bySource;

  return a.lifecycleEvent.type.localeCompare(b.lifecycleEvent.type);
}

export async function reconstructProjectTaskLifecycles(
  store: ReadStore,
  projectId: string,
): Promise<readonly PersistedTaskLifecycleAudit[]> {
  const tasks = await store.listTasksByProject(projectId);
  const workerRuns = await store.listWorkerRunsByProject(projectId);
  const candidates = await store.listCodeCandidatesByProject(projectId);
  const verifierRuns = await store.listVerifierRunsByProject(projectId);

  const workerEventEntries = await Promise.all(
    workerRuns.map(async (run) => [run.id, await store.listWorkerEvents(run.id)] as const),
  );
  const workerEventsByRunId = new Map(workerEventEntries);

  return tasks.map((task) => {
    const ranked: RankedEvidence[] = [];

    const add = (
      at: string,
      rank: number,
      sourceKind: PersistedLifecycleSourceKind,
      sourceId: string,
      lifecycleEvent: LifecycleEvidenceEvent,
      supportingSourceIds: readonly string[] = [],
    ): void => {
      ranked.push({
        at,
        rank,
        sourceKind,
        sourceId,
        supportingSourceIds,
        lifecycleEvent,
      });
    };

    add(
      task.createdAt,
      0,
      "task",
      task.id,
      {
        id: task.id,
        type: "TASK_CREATED",
        taskId: task.id,
      },
    );

    for (const run of workerRuns.filter((item) => item.taskId === task.id)) {
      const runEvents = workerEventsByRunId.get(run.id) ?? [];

      add(
        run.createdAt,
        10,
        "worker_run",
        run.id,
        {
          id: run.id,
          type: "WORKER_ASSIGNED",
          taskId: task.id,
          attemptId: run.id,
        },
      );

      if (run.startedAt !== undefined) {
        const startedSupportingIds = supportingWorkerEventIds(
          runEvents,
          LIFECYCLE_EVENTS.STARTED,
        );

        // Claim and start are one atomic persisted worker transition.
        add(
          run.startedAt,
          20,
          "worker_run",
          run.id,
          {
            id: run.id,
            type: "LEASE_ACQUIRED",
            taskId: task.id,
            attemptId: run.id,
          },
          startedSupportingIds,
        );

        add(
          run.startedAt,
          30,
          "worker_run",
          run.id,
          {
            id: run.id,
            type: "BUILDER_STARTED",
            taskId: task.id,
            attemptId: run.id,
          },
          startedSupportingIds,
        );
      }

      if (run.completedAt !== undefined) {
        if (run.status === "succeeded") {
          add(
            run.completedAt,
            50,
            "worker_run",
            run.id,
            {
              id: run.id,
              type: "BUILDER_COMPLETED",
              taskId: task.id,
              attemptId: run.id,
            },
            supportingWorkerEventIds(runEvents, LIFECYCLE_EVENTS.SUCCEEDED),
          );
        } else if (run.status === "failed") {
          add(
            run.completedAt,
            50,
            "worker_run",
            run.id,
            {
              id: run.id,
              type: "BUILDER_FAILED",
              taskId: task.id,
              attemptId: run.id,
            },
            supportingWorkerEventIds(runEvents, LIFECYCLE_EVENTS.FAILED),
          );
        } else if (run.status === "timed_out") {
          add(
            run.completedAt,
            50,
            "worker_run",
            run.id,
            {
              id: run.id,
              type: "LEASE_EXPIRED",
              taskId: task.id,
              attemptId: run.id,
            },
            supportingWorkerEventIds(runEvents, LIFECYCLE_EVENTS.TIMED_OUT),
          );
        }
      }
    }

    for (const candidate of candidates.filter((item) => item.taskId === task.id)) {
      // A durable candidate exists only after the trusted repository test
      // passed and the implementation artifact was captured. The candidate
      // therefore proves builder completion before artifact creation even
      // though the outer worker-success transition is persisted later.
      add(
        candidate.createdAt,
        35,
        "code_candidate",
        candidate.id,
        {
          id: `${candidate.id}:builder-completed`,
          type: "BUILDER_COMPLETED",
          taskId: task.id,
          attemptId: candidate.workerRunId,
        },
      );

      add(
        candidate.createdAt,
        40,
        "code_candidate",
        candidate.id,
        {
          id: candidate.id,
          type: "ARTIFACT_CREATED",
          taskId: task.id,
          attemptId: candidate.workerRunId,
          codeCandidateId: candidate.id,
          ...(candidate.parentCandidateId !== undefined
            ? { parentCodeCandidateId: candidate.parentCandidateId }
            : {}),
        },
      );
    }

    for (const verifier of verifierRuns.filter((item) => item.taskId === task.id)) {
      if (verifier.startedAt !== undefined) {
        add(
          verifier.startedAt,
          60,
          "verifier_run",
          verifier.id,
          {
            id: verifier.id,
            type: "VERIFIER_STARTED",
            taskId: task.id,
            ...(verifier.codeCandidateId !== undefined
              ? { codeCandidateId: verifier.codeCandidateId }
              : {}),
          },
        );
      }

      if (
        verifier.completedAt !== undefined &&
        (verifier.outcome === "PASS" || verifier.outcome === "FAIL")
      ) {
        add(
          verifier.completedAt,
          70,
          "verifier_run",
          verifier.id,
          {
            id: verifier.id,
            type: verifier.outcome === "PASS" ? "VERIFIER_PASS" : "VERIFIER_FAIL",
            taskId: task.id,
            ...(verifier.codeCandidateId !== undefined
              ? { codeCandidateId: verifier.codeCandidateId }
              : {}),
          },
        );
      }
    }

    if (task.status === "completed") {
      add(
        task.statusChangedAt,
        80,
        "task",
        task.id,
        {
          id: task.id,
          type: "TASK_COMPLETED",
          taskId: task.id,
        },
      );
    } else if (task.status === "failed") {
      add(
        task.statusChangedAt,
        80,
        "task",
        task.id,
        {
          id: task.id,
          type: "TASK_FAILED",
          taskId: task.id,
        },
      );
    }

    ranked.sort(compareEvidence);

    const evidence: PersistedLifecycleEvidence[] = ranked.map((item) => ({
      at: item.at,
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
      supportingSourceIds: item.supportingSourceIds,
      lifecycleEvent: item.lifecycleEvent,
    }));

    return {
      taskId: task.id,
      evidence,
      result: reconstructLifecycle(evidence.map((item) => item.lifecycleEvent)),
    };
  });
}

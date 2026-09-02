import { nowIso } from "../domain/common.js";
import { isTerminalTaskStatus } from "../domain/task.js";
import { runProjectAudit } from "../auditor/index.js";
import { createWorkerDispatcher } from "../dispatch/index.js";
import type { MasterOrchestrator } from "../master/orchestrator.js";
import type { IdFactory } from "../master/ids.js";
import { createRandomIdFactory } from "../master/ids.js";
import type { AsyncStateStore } from "../state/async-store.js";
import { maybeCreateRepairTask, maybeHandleRepairExhaustion } from "./repair.js";
import { deriveOrchestrationPhase, loadOrchestrationInput } from "./state.js";
import { DEFAULT_ORCHESTRATION_THRESHOLDS } from "./thresholds.js";
import type {
  OrchestrationAction,
  OrchestrationCycleResult,
  OrchestrationInput,
  RunOrchestrationCycleOptions,
} from "./types.js";
import type { VerifierAdapter } from "./verifier-adapter.js";
import {
  maybeAcceptCompletedRepairTask,
  maybeAcceptVerifiedTask,
  maybeRunTaskVerification,
} from "./verification.js";
import { maybeSchedulePromotion } from "./promotion.js";
import type { PromotionLaunchBridge } from "./promotion-launch-bridge.js";
import { NOOP_PROMOTION_LAUNCH_BRIDGE } from "./promotion-launch-bridge.js";

export interface AutoDevOrchestratorOptions {
  readonly store: AsyncStateStore;
  readonly verifierAdapter: VerifierAdapter;
  readonly idFactory?: IdFactory;
  readonly masterOrchestrator?: MasterOrchestrator;
  readonly taskDispatcher?: ReturnType<typeof createWorkerDispatcher>;
  readonly promotionLaunchBridge?: PromotionLaunchBridge;
}

function sortedTasks(input: OrchestrationInput) {
  return [...input.tasks].sort((a, b) => a.id.localeCompare(b.id));
}

function shouldReevaluateMaster(actions: readonly OrchestrationAction[]): boolean {
  return actions.some((action) =>
    [
      "dispatch",
      "run_verifier",
      "schedule_verifier",
      "accept_verified_task",
      "schedule_promotion",
      "create_repair_task",
      "repair_exhausted",
      "accept_repair_task",
    ].includes(action.kind),
  );
}

export async function runOrchestrationCycle(
  projectId: string,
  options: AutoDevOrchestratorOptions,
  cycleOptions: RunOrchestrationCycleOptions = {},
): Promise<OrchestrationCycleResult> {
  const now = cycleOptions.now ?? nowIso();
  const thresholds = cycleOptions.thresholds ?? DEFAULT_ORCHESTRATION_THRESHOLDS;
  const ids = options.idFactory ?? createRandomIdFactory();
  const actions: OrchestrationAction[] = [];
  let halted = false;
  let haltReason: string | undefined;
  let auditActiveCount: number | undefined;
  let masterRunId: string | undefined;

  let input = await loadOrchestrationInput(options.store, projectId);

  const dispatcher =
    options.taskDispatcher ??
    createWorkerDispatcher({ store: options.store, idFactory: ids });

  const dispatchResult = await dispatcher.dispatch(projectId, {
    maxAssignments: thresholds.maxDispatchAssignments,
  });
  if (dispatchResult.budgetBlocked !== undefined) {
    actions.push({
      kind: "budget_wait",
      summary: `Coding work paused for budget (${dispatchResult.budgetBlocked.reason})`,
      details: { ...dispatchResult.budgetBlocked },
    });
  }
  if (dispatchResult.assignments.length > 0) {
    for (const assignment of dispatchResult.assignments) {
      const launch = dispatchResult.launches.find(
        (record) => record.workerRunId === assignment.workerRun.id,
      );
      actions.push({
        kind: "dispatch",
        summary: `Dispatched worker ${assignment.workerRun.id} for task ${assignment.task.id}`,
        taskId: assignment.task.id,
        workerRunId: assignment.workerRun.id,
        details: {
          launched: launch?.launched ?? false,
          ...(launch?.skipped === true ? { skipped: true, reason: launch.reason } : {}),
          ...(launch?.errorMessage !== undefined ? { errorMessage: launch.errorMessage } : {}),
        },
      });
    }
    input = await loadOrchestrationInput(options.store, projectId);
  }

  for (const task of sortedTasks(input)) {
    const acceptedRepair = await maybeAcceptCompletedRepairTask(options.store, input, task);
    if (acceptedRepair !== undefined) {
      actions.push({
        kind: "accept_repair_task",
        summary: `Accepted repair task ${acceptedRepair.taskId}`,
        taskId: acceptedRepair.taskId,
        details: { originalTaskId: acceptedRepair.originalTaskId },
      });
      input = await loadOrchestrationInput(options.store, projectId);
    }
  }

  for (const task of sortedTasks(input)) {
    if (isTerminalTaskStatus(task.status)) {
      continue;
    }
    const verification = await maybeRunTaskVerification(
      options.store,
      ids,
      options.verifierAdapter,
      input,
      task,
    );
    if (verification !== undefined) {
      const isScheduled = verification.outcome === "scheduled";
      actions.push({
        kind: isScheduled ? "schedule_verifier" : "run_verifier",
        summary: isScheduled
          ? `Scheduled verifier ${verification.verifierRunId}`
          : `Ran verifier ${verification.verifierRunId} (${verification.outcome})`,
        taskId: task.id,
        verifierRunId: verification.verifierRunId,
        details: { outcome: verification.outcome },
      });
      input = await loadOrchestrationInput(options.store, projectId);
    }
  }

  for (const task of sortedTasks(input)) {
    const accepted = await maybeAcceptVerifiedTask(options.store, input, task);
    if (accepted !== undefined) {
      actions.push({
        kind: "accept_verified_task",
        summary: `Accepted verified task ${accepted.taskId}`,
        taskId: accepted.taskId,
        ...(accepted.verifierRunId !== undefined ? { verifierRunId: accepted.verifierRunId } : {}),
      });
      input = await loadOrchestrationInput(options.store, projectId);
    }
  }

  const promotionBridge = options.promotionLaunchBridge ?? NOOP_PROMOTION_LAUNCH_BRIDGE;
  for (const task of sortedTasks(input)) {
    const scheduled = await maybeSchedulePromotion(
      options.store,
      input,
      task,
      promotionBridge,
    );
    if (scheduled !== undefined) {
      actions.push({
        kind: "schedule_promotion",
        summary: `Scheduled promotion ${scheduled.promotionRunId}`,
        taskId: task.id,
        promotionRunId: scheduled.promotionRunId,
        details: { codeCandidateId: scheduled.codeCandidateId },
      });
      input = await loadOrchestrationInput(options.store, projectId);
    }
  }

  for (const task of sortedTasks(input)) {
    const repair = await maybeCreateRepairTask(options.store, ids, input, task, thresholds);
    if (repair !== undefined) {
      actions.push({
        kind: "create_repair_task",
        summary: `Created repair task ${repair.repairTaskId}`,
        taskId: repair.originalTaskId,
        details: { repairTaskId: repair.repairTaskId },
      });
      input = await loadOrchestrationInput(options.store, projectId);
    }
  }

  for (const task of sortedTasks(input)) {
    const exhausted = await maybeHandleRepairExhaustion(
      options.store,
      ids,
      input,
      task,
      thresholds,
    );
    if (exhausted !== undefined) {
      actions.push({
        kind: "repair_exhausted",
        summary: `Repair attempts exhausted for task ${exhausted.taskId}`,
        taskId: exhausted.taskId,
        details: { blockerId: exhausted.blockerId },
      });
      input = await loadOrchestrationInput(options.store, projectId);
    }
  }

  if (cycleOptions.runMasterReevaluation !== false && options.masterOrchestrator !== undefined) {
    if (shouldReevaluateMaster(actions)) {
      const trigger =
        actions[actions.length - 1]?.kind === "repair_exhausted"
          ? "repair_exhausted"
          : actions[actions.length - 1]?.kind ?? "orchestration_cycle";
      const masterRun = await options.masterOrchestrator.run({
        projectId,
        trigger,
        context: `orchestration:${actions.map((action) => action.kind).join(",")}`,
      });
      masterRunId = masterRun.id;
      actions.push({
        kind: "master_reevaluation",
        summary: `Master reevaluated (${masterRun.enforcedAction})`,
        details: { masterRunId: masterRun.id, enforcedAction: masterRun.enforcedAction },
      });
      input = await loadOrchestrationInput(options.store, projectId);
    }
  }

  if (cycleOptions.runAudit !== false) {
    const audit = await runProjectAudit(options.store, projectId, { now });
    auditActiveCount = audit.activeCount;
    actions.push({
      kind: "audit",
      summary: `Audit completed with ${audit.activeCount} active finding(s)`,
      details: { activeCount: audit.activeCount },
    });
    if (
      cycleOptions.haltOnCriticalAudit === true &&
      audit.findings.some((finding) => finding.status === "active" && finding.severity === "critical")
    ) {
      halted = true;
      haltReason = "critical_audit_finding";
    }
  }

  const derivedPhase = deriveOrchestrationPhase(input);
  const phase =
    dispatchResult.budgetBlocked !== undefined &&
    (derivedPhase === "awaiting_work" || derivedPhase === "repair_required")
      ? "waiting_for_budget"
      : derivedPhase;
  return {
    projectId,
    evaluatedAt: now,
    phase,
    actions,
    ...(auditActiveCount !== undefined ? { auditActiveCount } : {}),
    ...(masterRunId !== undefined ? { masterRunId } : {}),
    halted,
    ...(haltReason !== undefined ? { haltReason } : {}),
  };
}

export function createAutoDevOrchestrator(options: AutoDevOrchestratorOptions) {
  return {
    runCycle: (projectId: string, cycleOptions?: RunOrchestrationCycleOptions) =>
      runOrchestrationCycle(projectId, options, cycleOptions),
  };
}

export type AutoDevOrchestrator = ReturnType<typeof createAutoDevOrchestrator>;

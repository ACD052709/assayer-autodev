import type { WorkerTaskPacket } from "../domain/worker-task-packet.js";
import { codeCandidateIdForWorkerRun } from "../domain/code-candidate.js";
import {
  CODING_COST_BUDGET_CATEGORY,
  codingAttemptReservationUsd,
  computeCodingModelCostUsd,
  selectCodingModelForTask,
  type CodingModelId,
} from "../domain/coding-model.js";
import { sha256Hex } from "../security/checksum.js";
import { ActuatorError } from "./errors.js";
import { buildCodingTaskPrompt } from "./coding-task-prompt.js";
import {
  captureCheckoutCandidate,
  prepareIsolatedCheckout,
  readCheckoutChanges,
  type GitCaptureReader,
  type GitRunner,
  type GitStatusReader,
} from "./coding-task-checkout.js";
import {
  buildCodexCliInvocation,
  parseCodexUsage,
  parseTrustedTestCommand,
  type CodexUsage,
} from "./codex-cli.js";
import type { ProcessRunner } from "./process-runner.js";
import type { ControlPlaneClient } from "./types.js";
import { CODING_TASK_KIND } from "./types.js";
import { sanitizedCandidateEnv } from "./subprocess-env.js";
import { detectTargetSetupCommand } from "./target-setup.js";

export interface CodingTaskRunInput {
  readonly workerRunId: string;
  readonly leaseToken: string;
  readonly workspaceRoot: string;
  readonly openaiApiKey?: string;
  readonly targetRepoReadToken?: string;
  readonly codingTaskTimeoutMs: number;
  readonly client: ControlPlaneClient;
  readonly process: ProcessRunner;
  readonly git: GitRunner;
  readonly gitStatus: GitStatusReader;
  readonly gitCapture?: GitCaptureReader;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface CodingTaskStructuredOutcome extends Readonly<Record<string, string | number | boolean>> {
  readonly kind: typeof CODING_TASK_KIND;
  readonly codingAgent: "codex";
  readonly codingModel: CodingModelId;
  readonly agentExitCode: number;
  readonly testExitCode: number;
  readonly changedFileCount: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly usageAccountingEstimated: boolean;
  readonly budgetReservationUsd: number;
  readonly budgetRemainingUsdBefore: number;
  readonly durationMs: number;
  readonly failureReason: string;
}

export interface CodingTaskRunResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly structuredOutcome: CodingTaskStructuredOutcome;
  readonly errorCode?: string;
}

function sanitizeFailureReason(value: string): string {
  const trimmed = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
  return trimmed.length > 240 ? trimmed.slice(0, 240) : trimmed;
}

function summarizeTrustedTestFailure(
  exitCode: number,
  stdout: string,
  stderr: string,
): string {
  const diagnostic = [
    stderr.trim().length > 0 ? `stderr: ${stderr.trim()}` : "",
    stdout.trim().length > 0 ? `stdout: ${stdout.trim()}` : "",
  ]
    .filter((value) => value.length > 0)
    .join(" | ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (diagnostic.length === 0) {
    return `Trusted repository tests failed (exit ${exitCode}); no test output was captured`;
  }

  const bounded =
    diagnostic.length > 1200
      ? `...[last 1200 chars] ${diagnostic.slice(-1200)}`
      : diagnostic;

  return `Trusted repository tests failed (exit ${exitCode}): ${bounded}`;
}

const ZERO_USAGE: CodexUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

function buildOutcome(input: {
  model: CodingModelId;
  usage?: CodexUsage;
  estimatedCostUsd?: number;
  budgetReservationUsd: number;
  budgetRemainingUsdBefore: number;
  agentExitCode: number;
  testExitCode: number;
  changedFileCount: number;
  durationMs: number;
  failureReason: string;
  usageAccountingEstimated?: boolean;
}): CodingTaskStructuredOutcome {
  const usage = input.usage ?? ZERO_USAGE;
  return {
    kind: CODING_TASK_KIND,
    codingAgent: "codex",
    codingModel: input.model,
    agentExitCode: input.agentExitCode,
    testExitCode: input.testExitCode,
    changedFileCount: input.changedFileCount,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: input.estimatedCostUsd ?? 0,
    usageAccountingEstimated: input.usageAccountingEstimated ?? false,
    budgetReservationUsd: input.budgetReservationUsd,
    budgetRemainingUsdBefore: input.budgetRemainingUsdBefore,
    durationMs: input.durationMs,
    failureReason: sanitizeFailureReason(input.failureReason),
  };
}

function budgetFailure(input: {
  packet: WorkerTaskPacket;
  model: CodingModelId;
  reservationUsd: number;
  remainingUsd: number;
  startedAt: number;
  now?: () => number;
  reason: string;
}): CodingTaskRunResult {
  const durationMs = (input.now?.() ?? Date.now()) - input.startedAt;
  return {
    ok: false,
    errorCode: "CODING_BUDGET_REQUIRED",
    summary: input.reason,
    structuredOutcome: buildOutcome({
      model: input.model,
      budgetReservationUsd: input.reservationUsd,
      budgetRemainingUsdBefore: input.remainingUsd,
      agentExitCode: -1,
      testExitCode: -1,
      changedFileCount: 0,
      durationMs,
      failureReason: input.reason,
    }),
  };
}

export async function runCodingTask(input: CodingTaskRunInput): Promise<CodingTaskRunResult> {
  const startedAt = input.now?.() ?? Date.now();
  const packet = await input.client.getTaskPacket(input.workerRunId, input.leaseToken);
  const model = selectCodingModelForTask(packet.task);
  const reservationUsd = codingAttemptReservationUsd(model);

  if (input.openaiApiKey === undefined || input.openaiApiKey.trim().length === 0) {
    const durationMs = (input.now?.() ?? Date.now()) - startedAt;
    return {
      ok: false,
      errorCode: "OPENAI_API_KEY_MISSING",
      summary: "OPENAI_API_KEY is required for Codex coding-task execution",
      structuredOutcome: buildOutcome({
        model,
        budgetReservationUsd: reservationUsd,
        budgetRemainingUsdBefore: 0,
        agentExitCode: -1,
        testExitCode: -1,
        changedFileCount: 0,
        durationMs,
        failureReason: "OPENAI_API_KEY is not configured",
      }),
    };
  }

  if (input.client.getBudget === undefined || input.client.recordBudgetEntry === undefined) {
    throw new ActuatorError("invalid_config", "Control-plane budget methods are required for coding-task execution");
  }

  const getBudget = input.client.getBudget.bind(input.client);
  const recordBudgetEntry = input.client.recordBudgetEntry.bind(input.client);

  if (packet.targetRepository === undefined) {
    throw new ActuatorError("invalid_config", "Task packet is missing targetRepository");
  }
  if (packet.targetTestCommand === undefined || packet.targetTestCommand.trim().length === 0) {
    throw new ActuatorError("invalid_config", "Task packet is missing targetTestCommand");
  }

  const budget = await getBudget(packet.projectId, CODING_COST_BUDGET_CATEGORY);
  if (budget === undefined || budget.unit !== "usd") {
    return budgetFailure({
      packet,
      model,
      reservationUsd,
      remainingUsd: 0,
      startedAt,
      ...(input.now !== undefined ? { now: input.now } : {}),
      reason: "Coding budget is not configured; increase or create llm_cost_usd budget to continue",
    });
  }
  if (budget.remainingHardLimit + 1e-12 < reservationUsd) {
    return budgetFailure({
      packet,
      model,
      reservationUsd,
      remainingUsd: budget.remainingHardLimit,
      startedAt,
      ...(input.now !== undefined ? { now: input.now } : {}),
      reason: `Coding budget has $${budget.remainingHardLimit.toFixed(4)} remaining; $${reservationUsd.toFixed(2)} headroom is required for ${model}`,
    });
  }

  let parentCandidate: import("../domain/code-candidate.js").CodeCandidate | undefined;
  let parentPatchContent: string | undefined;
  if (packet.parentCandidateId !== undefined) {
    if (input.client.getCodeCandidate === undefined || input.client.fetchCodeCandidatePatch === undefined) {
      throw new ActuatorError("invalid_config", "Control-plane candidate read methods are required for repair tasks");
    }
    parentCandidate = await input.client.getCodeCandidate(packet.parentCandidateId);
    parentPatchContent = await input.client.fetchCodeCandidatePatch(packet.parentCandidateId);
  }

  const { checkoutDir } = await prepareIsolatedCheckout({
    packet,
    workspaceRoot: input.workspaceRoot,
    git: input.git,
    ...(parentCandidate !== undefined ? { parentCandidate } : {}),
    ...(parentPatchContent !== undefined ? { parentPatchContent } : {}),
    ...(input.targetRepoReadToken !== undefined ? { targetRepoReadToken: input.targetRepoReadToken } : {}),
  });
  const setup = await detectTargetSetupCommand(checkoutDir);
  if (setup !== undefined) {
    const setupResult = await input.process.run({
      command: setup.command,
      args: setup.args,
      cwd: checkoutDir,
      timeoutMs: Math.min(input.codingTaskTimeoutMs, 300_000),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      env: sanitizedCandidateEnv(),
    });
    if (setupResult.exitCode !== 0 || setupResult.timedOut) {
      const durationMs = (input.now?.() ?? Date.now()) - startedAt;
      const failureReason = setupResult.timedOut
        ? `Trusted target dependency setup timed out (${setup.reason})`
        : `Trusted target dependency setup failed (${setup.reason})`;
      return {
        ok: false,
        errorCode: setupResult.timedOut ? "TARGET_SETUP_TIMEOUT" : "TARGET_SETUP_FAILED",
        summary: failureReason,
        structuredOutcome: buildOutcome({
          model,
          estimatedCostUsd: 0,
          usageAccountingEstimated: false,
          budgetReservationUsd: reservationUsd,
          budgetRemainingUsdBefore: budget.remainingHardLimit,
          agentExitCode: -1,
          testExitCode: -1,
          changedFileCount: 0,
          durationMs,
          failureReason,
        }),
      };
    }
  }

  const prompt = buildCodingTaskPrompt(packet);
  const invocation = buildCodexCliInvocation({
    workspaceDir: checkoutDir,
    prompt,
    timeoutMs: input.codingTaskTimeoutMs,
    model,
  });

  const agentResult = await input.process.run({
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    timeoutMs: invocation.timeoutMs,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    env: {
      ...sanitizedCandidateEnv(),
      CODEX_API_KEY: input.openaiApiKey,
    },
  });

  const usage = parseCodexUsage(agentResult.stdout);
  // If Codex is interrupted before emitting its terminal usage event, charge the
  // reservation internally rather than silently undercounting. This is deliberately
  // conservative: the budget can be increased later without losing project state.
  const usageAccountingEstimated = usage === undefined;
  const estimatedCostUsd = usage === undefined
    ? reservationUsd
    : computeCodingModelCostUsd(model, {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        outputTokens: usage.outputTokens,
      });

  await recordBudgetEntry({
    id: `budg-coding-${input.workerRunId}`,
    projectId: packet.projectId,
    resourceType: CODING_COST_BUDGET_CATEGORY,
    amount: estimatedCostUsd,
    unit: "usd",
    taskId: packet.taskId,
    workerRunId: input.workerRunId,
    description: usageAccountingEstimated ? `codex:${model}:estimated` : `codex:${model}`,
  });

  let changes = await readCheckoutChanges(checkoutDir, input.gitStatus);
  const trustedTest = parseTrustedTestCommand(packet.targetTestCommand);
  let testResult = await input.process.run({
    command: trustedTest.command,
    args: trustedTest.args,
    cwd: checkoutDir,
    timeoutMs: input.codingTaskTimeoutMs,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    env: sanitizedCandidateEnv(),
  });

  // A worker must be able to repair its own implementation after deterministic
  // host feedback. One initial Codex pass followed by immediate terminal failure
  // made implementation tasks effectively single-shot.
  //
  // Give Codex one bounded repair pass in the SAME isolated checkout when the
  // trusted repository test fails. The trusted host remains authoritative and
  // reruns the exact test after the repair.
  let finalAgentResult = agentResult;
  let additionalEstimatedCostUsd = 0;

  if (
    testResult.exitCode !== 0 &&
    !testResult.timedOut
  ) {
    const remainingAfterInitialAttempt =
      budget.remainingHardLimit - estimatedCostUsd;

    if (remainingAfterInitialAttempt >= reservationUsd) {
      const testFeedback = summarizeTrustedTestFailure(
        testResult.exitCode,
        testResult.stdout,
        testResult.stderr,
      );

      const repairPrompt = [
        prompt,
        "",
        "TRUSTED HOST TEST FEEDBACK:",
        testFeedback,
        "",
        "Your previous implementation did not pass the trusted host test.",
        "Perform exactly one bounded repair pass in the current checkout.",
        "Inspect the files relevant to this failure, correct the implementation,",
        "and stop when the smallest appropriate repair is complete.",
        "Do not push, deploy, alter secrets, or expand the task scope.",
        "The trusted host will rerun the exact test after you exit.",
      ].join("\n");

      const repairInvocation = buildCodexCliInvocation({
        workspaceDir: checkoutDir,
        prompt: repairPrompt,
        timeoutMs: input.codingTaskTimeoutMs,
        model,
      });

      const repairAgentResult = await input.process.run({
        command: repairInvocation.command,
        args: repairInvocation.args,
        cwd: repairInvocation.cwd,
        timeoutMs: repairInvocation.timeoutMs,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        env: {
          ...sanitizedCandidateEnv(),
          CODEX_API_KEY: input.openaiApiKey,
        },
      });

      finalAgentResult = repairAgentResult;

      const repairUsage = parseCodexUsage(repairAgentResult.stdout);
      const repairUsageEstimated = repairUsage === undefined;

      additionalEstimatedCostUsd =
        repairUsage === undefined
          ? reservationUsd
          : computeCodingModelCostUsd(model, {
              inputTokens: repairUsage.inputTokens,
              cachedInputTokens: repairUsage.cachedInputTokens,
              cacheWriteInputTokens: repairUsage.cacheWriteInputTokens,
              outputTokens: repairUsage.outputTokens,
            });

      await recordBudgetEntry({
        id: `budg-coding-repair-${input.workerRunId}`,
        projectId: packet.projectId,
        resourceType: CODING_COST_BUDGET_CATEGORY,
        amount: additionalEstimatedCostUsd,
        unit: "usd",
        taskId: packet.taskId,
        workerRunId: input.workerRunId,
        description: repairUsageEstimated
          ? `codex:${model}:repair:estimated`
          : `codex:${model}:repair`,
      });

      changes = await readCheckoutChanges(checkoutDir, input.gitStatus);

      testResult = await input.process.run({
        command: trustedTest.command,
        args: trustedTest.args,
        cwd: checkoutDir,
        timeoutMs: input.codingTaskTimeoutMs,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        env: sanitizedCandidateEnv(),
      });
    }
  }

  const durationMs = (input.now?.() ?? Date.now()) - startedAt;
  const testsPassed = testResult.exitCode === 0;
  const hasChanges = changes.changedFileCount > 0;

  // Capture a test-passing candidate before interpreting the agent's own exit
  // status. The deterministic test + independent verifier are authoritative; a
  // timeout/non-zero Codex exit must not discard already-valid work.
  if (testsPassed && hasChanges) {
    const gitCapture = input.gitCapture;
    if (gitCapture === undefined) {
      throw new ActuatorError("invalid_config", "Git capture reader is required when checkout has changes");
    }
    const capture = await captureCheckoutCandidate(checkoutDir, gitCapture);
    await input.client.createCodeCandidate({
      id: codeCandidateIdForWorkerRun(packet.taskId, input.workerRunId),
      projectId: packet.projectId,
      taskId: packet.taskId,
      workerRunId: input.workerRunId,
      sourceRepository: packet.targetRepository!,
      ...(packet.targetRef !== undefined ? { sourceRef: packet.targetRef } : {}),
      ...(packet.parentCandidateId !== undefined ? { parentCandidateId: packet.parentCandidateId } : {}),
      baseCommitSha: capture.baseCommitSha,
      changedFiles: capture.changedFiles,
      patchContent: capture.patchContent,
      patchChecksumSha256: sha256Hex(capture.patchContent),
      testCommand: packet.targetTestCommand,
      testExitCode: testResult.exitCode,
    });
  }

  let failureReason = "";
  let errorCode: string | undefined;
  if (!testsPassed) {
    failureReason = summarizeTrustedTestFailure(
      testResult.exitCode,
      testResult.stdout,
      testResult.stderr,
    );
    errorCode = "REPOSITORY_TESTS_FAILED";
  } else if (!hasChanges) {
    failureReason = "Coding task produced no code changes to verify";
    errorCode = agentResult.timedOut
      ? "CODEX_CLI_TIMEOUT"
      : agentResult.exitCode !== 0
        ? "CODEX_CLI_FAILED"
        : "NO_CODE_CHANGES";
  } else if (finalAgentResult.timedOut) {
    // Passing changed work is preserved and sent to the independent verifier.
    failureReason = "Codex timed out after producing a passing candidate; candidate preserved";
  } else if (finalAgentResult.exitCode !== 0) {
    failureReason = "Codex exited non-zero after producing a passing candidate; candidate preserved";
  } else if (usageAccountingEstimated) {
    failureReason = "Codex usage event missing; reservation charged conservatively";
  }

  const structuredOutcome = buildOutcome({
    model,
    ...(usage !== undefined ? { usage } : {}),
    estimatedCostUsd: estimatedCostUsd + additionalEstimatedCostUsd,
    usageAccountingEstimated,
    budgetReservationUsd: reservationUsd,
    budgetRemainingUsdBefore: budget.remainingHardLimit,
    agentExitCode: finalAgentResult.exitCode,
    testExitCode: testResult.exitCode,
    changedFileCount: changes.changedFileCount,
    durationMs,
    failureReason,
  });

  if (errorCode !== undefined) {
    const failureTelemetry = [
      `agentExitCode=${agentResult.exitCode}`,
      `agentTimedOut=${agentResult.timedOut}`,
      `testExitCode=${testResult.exitCode}`,
      `changedFileCount=${changes.changedFileCount}`,
      `changedFiles=${changes.changedFileSummary || "(none)"}`,
    ].join(" ");

    return {
      ok: false,
      errorCode,
      summary: `${failureReason} | ${failureTelemetry}`,
      structuredOutcome,
    };
  }

  const warning = failureReason.length > 0 ? ` (${failureReason})` : "";
  return {
    ok: true,
    summary: `Codex ${model} produced a passing candidate for independent verification${warning}`,
    structuredOutcome,
  };
}

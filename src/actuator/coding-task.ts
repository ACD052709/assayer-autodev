import type { WorkerTaskPacket } from "../domain/worker-task-packet.js";
import { ActuatorError } from "./errors.js";
import { buildCodingTaskPrompt } from "./coding-task-prompt.js";
import {
  prepareIsolatedCheckout,
  readCheckoutChanges,
  type GitRunner,
  type GitStatusReader,
} from "./coding-task-checkout.js";
import { buildCursorCliInvocation, parseTrustedTestCommand } from "./cursor-cli.js";
import type { ProcessRunner } from "./process-runner.js";
import type { ControlPlaneClient } from "./types.js";
import { CODING_TASK_KIND } from "./types.js";

export interface CodingTaskRunInput {
  readonly workerRunId: string;
  readonly leaseToken: string;
  readonly workspaceRoot: string;
  readonly cursorApiKey?: string;
  readonly codingTaskTimeoutMs: number;
  readonly client: ControlPlaneClient;
  readonly process: ProcessRunner;
  readonly git: GitRunner;
  readonly gitStatus: GitStatusReader;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface CodingTaskStructuredOutcome extends Readonly<Record<string, string | number | boolean>> {
  readonly kind: typeof CODING_TASK_KIND;
  readonly codingAgentUsed: true;
  readonly externalRepositoryModified: boolean;
  readonly agentExitCode: number;
  readonly testCommand: string;
  readonly testExitCode: number;
  readonly changedFileCount: number;
  readonly changedFileSummary: string;
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

function buildOutcome(input: {
  packet: WorkerTaskPacket;
  testCommand: string;
  agentExitCode: number;
  testExitCode: number;
  changedFileCount: number;
  changedFileSummary: string;
  durationMs: number;
  failureReason: string;
}): CodingTaskStructuredOutcome {
  return {
    kind: CODING_TASK_KIND,
    codingAgentUsed: true,
    externalRepositoryModified: input.changedFileCount > 0,
    agentExitCode: input.agentExitCode,
    testCommand: input.testCommand,
    testExitCode: input.testExitCode,
    changedFileCount: input.changedFileCount,
    changedFileSummary: input.changedFileSummary,
    durationMs: input.durationMs,
    failureReason: sanitizeFailureReason(input.failureReason),
  };
}

export async function runCodingTask(input: CodingTaskRunInput): Promise<CodingTaskRunResult> {
  const startedAt = input.now?.() ?? Date.now();
  const packet = await input.client.getTaskPacket(input.workerRunId, input.leaseToken);

  if (input.cursorApiKey === undefined || input.cursorApiKey.trim().length === 0) {
    const durationMs = (input.now?.() ?? Date.now()) - startedAt;
    const testCommand = packet.targetTestCommand ?? "";
    return {
      ok: false,
      errorCode: "CURSOR_API_KEY_MISSING",
      summary: "CURSOR_API_KEY is required for coding-task execution",
      structuredOutcome: buildOutcome({
        packet,
        testCommand,
        agentExitCode: -1,
        testExitCode: -1,
        changedFileCount: 0,
        changedFileSummary: "",
        durationMs,
        failureReason: "CURSOR_API_KEY is not configured",
      }),
    };
  }

  if (packet.targetRepository === undefined) {
    throw new ActuatorError("invalid_config", "Task packet is missing targetRepository");
  }
  if (packet.targetTestCommand === undefined || packet.targetTestCommand.trim().length === 0) {
    throw new ActuatorError("invalid_config", "Task packet is missing targetTestCommand");
  }

  const { checkoutDir } = await prepareIsolatedCheckout({
    packet,
    workspaceRoot: input.workspaceRoot,
    git: input.git,
  });
  const prompt = buildCodingTaskPrompt(packet);
  const invocation = buildCursorCliInvocation({
    workspaceDir: checkoutDir,
    prompt,
    timeoutMs: input.codingTaskTimeoutMs,
  });

  const agentResult = await input.process.run({
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    timeoutMs: invocation.timeoutMs,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    env: {
      ...process.env,
      CURSOR_API_KEY: input.cursorApiKey,
    },
  });

  const changes = await readCheckoutChanges(checkoutDir, input.gitStatus);
  const trustedTest = parseTrustedTestCommand(packet.targetTestCommand);
  const testResult = await input.process.run({
    command: trustedTest.command,
    args: trustedTest.args,
    cwd: checkoutDir,
    timeoutMs: input.codingTaskTimeoutMs,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const durationMs = (input.now?.() ?? Date.now()) - startedAt;
  let failureReason = "";
  if (agentResult.timedOut) {
    failureReason = "Cursor CLI execution timed out";
  } else if (agentResult.exitCode !== 0) {
    failureReason = "Cursor CLI exited with a non-zero status";
  } else if (testResult.exitCode !== 0) {
    failureReason = "Trusted repository tests failed";
  }

  const structuredOutcome = buildOutcome({
    packet,
    testCommand: packet.targetTestCommand,
    agentExitCode: agentResult.exitCode,
    testExitCode: testResult.exitCode,
    changedFileCount: changes.changedFileCount,
    changedFileSummary: changes.changedFileSummary,
    durationMs,
    failureReason,
  });

  if (failureReason.length > 0) {
    return {
      ok: false,
      errorCode: agentResult.timedOut
        ? "CURSOR_CLI_TIMEOUT"
        : agentResult.exitCode !== 0
          ? "CURSOR_CLI_FAILED"
          : "REPOSITORY_TESTS_FAILED",
      summary: failureReason,
      structuredOutcome,
    };
  }

  return {
    ok: true,
    summary: "Coding-task completed with passing trusted repository tests",
    structuredOutcome,
  };
}

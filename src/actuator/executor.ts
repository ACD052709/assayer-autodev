import { ActuatorError, sanitizeActuatorError } from "./errors.js";
import { startHeartbeatLoop } from "./heartbeat-loop.js";
import { createSanitizingLogger } from "./logger.js";
import type { GitRunner, GitStatusReader, GitCaptureReader } from "./coding-task-checkout.js";
import { createGitRunner, createGitStatusReader, createGitCaptureReader } from "./coding-task-checkout.js";
import { runCodingTask } from "./coding-task.js";
import type { ProcessRunner } from "./process-runner.js";
import { createSubprocessRunner } from "./process-runner.js";
import { runSyntheticNoop } from "./synthetic-noop.js";
import type {
  ActuatorConfig,
  ActuatorLogger,
  ActuatorRunResult,
  ActuatorTimers,
  ControlPlaneClient,
} from "./types.js";
import { isExecutionMode } from "./types.js";

export interface SleepFn {
  (ms: number, signal?: AbortSignal): Promise<void>;
}

export interface SignalInstaller {
  (handler: () => void): () => void;
}

export interface RunActuatorOptions {
  readonly config: ActuatorConfig;
  readonly client: ControlPlaneClient;
  readonly logger?: ActuatorLogger;
  readonly timers?: ActuatorTimers;
  readonly sleep?: SleepFn;
  readonly installSignalHandlers?: SignalInstaller;
  readonly processRunner?: ProcessRunner;
  readonly gitRunner?: GitRunner;
  readonly gitStatusReader?: GitStatusReader;
  readonly gitCaptureReader?: GitCaptureReader;
}

const DEFAULT_TIMERS: ActuatorTimers = {
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

export async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ActuatorError("ABORTED", "Aborted"));
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ActuatorError("ABORTED", "Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runActuator(options: RunActuatorOptions): Promise<ActuatorRunResult> {
  const secrets = [
    options.config.serviceToken,
    options.config.openaiApiKey,
    options.config.targetRepoReadToken,
  ];
  const logger = createSanitizingLogger(secrets, options.logger);
  const timers = options.timers ?? DEFAULT_TIMERS;
  const sleep = options.sleep ?? defaultSleep;
  const { config, client } = options;

  if (!isExecutionMode(config.executionMode)) {
    logger.error("Unsupported executionMode");
    return { ok: false, exitCode: 1, reason: "unsupported_mode" };
  }

  const workAbort = new AbortController();
  let ownershipLost = false;
  let interrupted = false;
  let terminalSent = false;

  const uninstallSignals = options.installSignalHandlers?.(() => {
    interrupted = true;
    workAbort.abort();
  });

  try {
    let claimed;
    try {
      claimed = await client.claim(config.workerRunId, config.ownerId);
    } catch (error) {
      const sanitized = sanitizeActuatorError(error, secrets);
      logger.error("Claim failed", { code: sanitized.code });
      return { ok: false, exitCode: 1, reason: "claim_failed" };
    }
    const token = claimed.leaseToken;
    secrets.push(token);
    const log = createSanitizingLogger(secrets, options.logger);
    log.info("Claimed worker run", {
      workerRunId: config.workerRunId,
      ownerId: config.ownerId,
      runStatus: claimed.workerRun.status,
      taskStatus: claimed.task.status,
    });

    const heartbeat = startHeartbeatLoop({
      intervalMs: config.heartbeatIntervalMs,
      failureLimit: config.heartbeatFailureLimit,
      timers,
      beat: async () => {
        await client.heartbeat(config.workerRunId, token);
      },
      onOwnershipLost: () => {
        ownershipLost = true;
        workAbort.abort();
      },
    });

    if (config.executionMode === "coding-task") {
      try {
        const codingResult = await runCodingTask({
          workerRunId: config.workerRunId,
          leaseToken: token,
          workspaceRoot: config.workspaceRoot,
          codingTaskTimeoutMs: config.codingTaskTimeoutMs,
          ...(config.openaiApiKey !== undefined ? { openaiApiKey: config.openaiApiKey } : {}),
          ...(config.targetRepoReadToken !== undefined
            ? { targetRepoReadToken: config.targetRepoReadToken }
            : {}),
          client,
          process: options.processRunner ?? createSubprocessRunner(),
          git: options.gitRunner ?? createGitRunner(),
          gitStatus: options.gitStatusReader ?? createGitStatusReader(),
          gitCapture: options.gitCaptureReader ?? createGitCaptureReader(),
          signal: workAbort.signal,
        });
        await heartbeat.stop();
        if (ownershipLost) {
          log.error("Ownership lost during coding-task; leaving run for lease recovery");
          return { ok: false, exitCode: 1, reason: "ownership_lost" };
        }
        if (codingResult.ok) {
          terminalSent = true;
          const done = await client.succeed(config.workerRunId, token, {
            summary: codingResult.summary,
            structuredOutcome: codingResult.structuredOutcome,
          });
          log.info("Worker run succeeded", {
            workerRunId: done.workerRun.id,
            runStatus: done.workerRun.status,
            taskStatus: done.task.status,
          });
          return { ok: true, exitCode: 0, reason: "succeeded" };
        }
        return failIfOwned({
          client,
          config,
          leaseToken: token,
          log,
          terminalSent: () => terminalSent,
          markTerminal: () => {
            terminalSent = true;
          },
          errorCode: codingResult.errorCode ?? "CODING_TASK_FAILED",
          summary: codingResult.summary,
        });
      } catch (error) {
        await heartbeat.stop();
        const sanitized = sanitizeActuatorError(error, secrets);
        if (ownershipLost || sanitized.ownershipLost) {
          log.error("Ownership lost; not reporting terminal failure with an invalid lease");
          return { ok: false, exitCode: 1, reason: "ownership_lost" };
        }
        if (interrupted) {
          return failIfOwned({
            client,
            config,
            leaseToken: token,
            log,
            terminalSent: () => terminalSent,
            markTerminal: () => {
              terminalSent = true;
            },
            errorCode: "EXECUTOR_INTERRUPTED",
            summary: "Executor interrupted before coding-task completed",
          });
        }
        return failIfOwned({
          client,
          config,
          leaseToken: token,
          log,
          terminalSent: () => terminalSent,
          markTerminal: () => {
            terminalSent = true;
          },
          errorCode: "CODING_TASK_FAILED",
          summary: sanitized.message,
        });
      }
    }

    try {
      const outcome = await runSyntheticNoop({
        workerRunId: config.workerRunId,
        durationMs: config.syntheticNoopDurationMs,
        sleep,
        signal: workAbort.signal,
      });
      await heartbeat.stop();
      if (ownershipLost) {
        log.error("Ownership lost during synthetic work; leaving run for lease recovery");
        return { ok: false, exitCode: 1, reason: "ownership_lost" };
      }
      try {
        terminalSent = true;
        const done = await client.succeed(config.workerRunId, token, {
          summary: "GitHub Actions synthetic-noop completed without repository work",
          structuredOutcome: { ...outcome },
        });
        log.info("Worker run succeeded", {
          workerRunId: done.workerRun.id,
          runStatus: done.workerRun.status,
          taskStatus: done.task.status,
        });
        return { ok: true, exitCode: 0, reason: "succeeded" };
      } catch (error) {
        const sanitized = sanitizeActuatorError(error, secrets);
        if (sanitized.ownershipLost) {
          log.error("Succeed rejected; leaving run for lease recovery", { code: sanitized.code });
          return { ok: false, exitCode: 1, reason: "ownership_lost" };
        }
        log.error("Succeed request failed", { code: sanitized.code });
        return { ok: false, exitCode: 1, reason: "failed" };
      }
    } catch (error) {
      await heartbeat.stop();
      const sanitized = sanitizeActuatorError(error, secrets);
      if (ownershipLost || sanitized.ownershipLost) {
        log.error("Ownership lost; not reporting terminal failure with an invalid lease");
        return { ok: false, exitCode: 1, reason: "ownership_lost" };
      }
      if (terminalSent) {
        return { ok: false, exitCode: 1, reason: "failed" };
      }
      return failIfOwned({
        client,
        config,
        leaseToken: token,
        log,
        terminalSent: () => terminalSent,
        markTerminal: () => {
          terminalSent = true;
        },
        errorCode: interrupted ? "EXECUTOR_INTERRUPTED" : "SYNTHETIC_NOOP_FAILED",
        summary: interrupted
          ? "Executor interrupted before synthetic work completed"
          : "Synthetic-noop execution failed",
      });
    }
  } finally {
    uninstallSignals?.();
  }
}

async function failIfOwned(input: {
  readonly client: ControlPlaneClient;
  readonly config: ActuatorConfig;
  readonly leaseToken: string;
  readonly log: ReturnType<typeof createSanitizingLogger>;
  readonly terminalSent: () => boolean;
  readonly markTerminal: () => void;
  readonly errorCode: string;
  readonly summary: string;
}): Promise<ActuatorRunResult> {
  if (input.terminalSent()) {
    return { ok: false, exitCode: 1, reason: "failed" };
  }
  try {
    input.markTerminal();
    const done = await input.client.fail(input.config.workerRunId, input.leaseToken, {
      errorCode: input.errorCode,
      summary: input.summary,
    });
    input.log.error("Worker run failed", {
      workerRunId: done.workerRun.id,
      runStatus: done.workerRun.status,
      taskStatus: done.task.status,
      errorCode: input.errorCode,
    });
    return { ok: false, exitCode: 1, reason: input.errorCode === "EXECUTOR_INTERRUPTED" ? "interrupted" : "failed" };
  } catch (error) {
    const sanitized = sanitizeActuatorError(error, [input.config.serviceToken, input.leaseToken]);
    if (sanitized.ownershipLost) {
      input.log.error("Fail rejected; leaving run for lease recovery", { code: sanitized.code });
      return { ok: false, exitCode: 1, reason: "ownership_lost" };
    }
    input.log.error("Fail request failed", { code: sanitized.code });
    return { ok: false, exitCode: 1, reason: "failed" };
  }
}

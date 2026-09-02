import { spawn } from "node:child_process";

export interface ProcessRunInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ProcessRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ProcessRunner {
  run(input: ProcessRunInput): Promise<ProcessRunResult>;
}

const TERMINATION_GRACE_MS = 5_000;

/**
 * Bounded subprocess runner. Timeout/abort first requests graceful termination,
 * then escalates to SIGKILL so an uncooperative coding agent cannot keep a paid
 * request alive until the outer GitHub Actions job timeout.
 */
export function createSubprocessRunner(): ProcessRunner {
  return {
    async run(input: ProcessRunInput): Promise<ProcessRunResult> {
      if (input.signal?.aborted) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Process launch skipped because execution was already aborted",
          timedOut: false,
        };
      }

      return new Promise<ProcessRunResult>((resolve, reject) => {
        const child = spawn(input.command, [...input.args], {
          cwd: input.cwd,
          env: input.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let hardKillTimer: ReturnType<typeof setTimeout> | undefined;

        const terminate = (markTimedOut: boolean): void => {
          if (markTimedOut) timedOut = true;
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          if (hardKillTimer === undefined) {
            hardKillTimer = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
              }
            }, TERMINATION_GRACE_MS);
          }
        };

        const timer = setTimeout(() => terminate(true), input.timeoutMs);
        const onAbort = (): void => terminate(false);
        input.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += String(chunk);
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
          input.signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
          input.signal?.removeEventListener("abort", onAbort);
          resolve({
            exitCode: code ?? 1,
            stdout,
            stderr,
            timedOut,
          });
        });
      });
    },
  };
}

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

export function createSubprocessRunner(): ProcessRunner {
  return {
    async run(input: ProcessRunInput): Promise<ProcessRunResult> {
      return new Promise<ProcessRunResult>((resolve, reject) => {
        const child = spawn(input.command, [...input.args], {
          cwd: input.cwd,
          env: input.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, input.timeoutMs);
        const onAbort = (): void => {
          child.kill("SIGTERM");
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += String(chunk);
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
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

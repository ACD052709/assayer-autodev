import type { WorkerTaskPacket } from "../domain/worker-task-packet.js";
import { isolatedCheckoutDirectory } from "./cursor-cli.js";
import type { ProcessRunner } from "./process-runner.js";
import { createSubprocessRunner } from "./process-runner.js";

export interface GitRunner {
  run(args: readonly string[], cwd?: string): Promise<number>;
}

export interface PrepareIsolatedCheckoutInput {
  readonly packet: WorkerTaskPacket;
  readonly workspaceRoot: string;
  readonly git: GitRunner;
}

export interface PrepareIsolatedCheckoutResult {
  readonly checkoutDir: string;
}

export function buildCloneUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}

export async function prepareIsolatedCheckout(
  input: PrepareIsolatedCheckoutInput,
): Promise<PrepareIsolatedCheckoutResult> {
  if (input.packet.targetRepository === undefined) {
    throw new Error("Task packet is missing targetRepository");
  }
  const checkoutDir = isolatedCheckoutDirectory(input.workspaceRoot, input.packet.workerRunId);
  const cloneArgs = ["clone", "--depth", "1"];
  if (input.packet.targetRef !== undefined && input.packet.targetRef.length > 0) {
    cloneArgs.push("--branch", input.packet.targetRef);
  }
  cloneArgs.push(buildCloneUrl(input.packet.targetRepository), checkoutDir);
  const exitCode = await input.git.run(cloneArgs);
  if (exitCode !== 0) {
    throw new Error("Failed to clone target repository checkout");
  }
  return { checkoutDir };
}

export interface GitStatusReader {
  readPorcelain(cwd: string): Promise<string>;
}

export async function summarizeCheckoutChangesFromStatus(
  statusOutput: string,
): Promise<{ readonly changedFileCount: number; readonly changedFileSummary: string }> {
  const paths = statusOutput
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0);
  const summary = paths.slice(0, 8).join(",");
  return {
    changedFileCount: paths.length,
    changedFileSummary: summary.length > 240 ? `${summary.slice(0, 240)}...` : summary,
  };
}

export async function readCheckoutChanges(
  checkoutDir: string,
  gitStatus: GitStatusReader,
): Promise<{ readonly changedFileCount: number; readonly changedFileSummary: string }> {
  const statusOutput = await gitStatus.readPorcelain(checkoutDir);
  return summarizeCheckoutChangesFromStatus(statusOutput);
}

export function createGitRunner(runner: ProcessRunner = createSubprocessRunner()): GitRunner {
  return {
    async run(args, cwd) {
      const result = await runner.run({
        command: "git",
        args,
        cwd: cwd ?? process.cwd(),
        timeoutMs: 600_000,
      });
      return result.exitCode;
    },
  };
}

export function createGitStatusReader(runner: ProcessRunner = createSubprocessRunner()): GitStatusReader {
  return {
    async readPorcelain(cwd) {
      const result = await runner.run({
        command: "git",
        args: ["status", "--porcelain"],
        cwd,
        timeoutMs: 120_000,
      });
      return result.stdout;
    },
  };
}

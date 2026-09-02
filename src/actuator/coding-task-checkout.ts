import type { WorkerTaskPacket } from "../domain/worker-task-packet.js";
import type { CodeCandidate } from "../domain/code-candidate.js";
import { verifyPatchChecksum } from "../security/checksum.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isolatedCheckoutDirectory } from "./codex-cli.js";
import { sanitizedCandidateEnv } from "./subprocess-env.js";
import type { ProcessRunner } from "./process-runner.js";
import { createSubprocessRunner } from "./process-runner.js";

export interface GitRunner {
  run(args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<number>;
}

export interface PrepareIsolatedCheckoutInput {
  readonly packet: WorkerTaskPacket;
  readonly workspaceRoot: string;
  readonly git: GitRunner;
  readonly parentCandidate?: CodeCandidate;
  readonly parentPatchContent?: string;
  readonly targetRepoReadToken?: string;
}

export interface PrepareIsolatedCheckoutResult {
  readonly checkoutDir: string;
}

export function buildCloneUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}

function targetRepoGitAuthEnv(token: string | undefined): NodeJS.ProcessEnv | undefined {
  if (token === undefined || token.trim().length === 0) return undefined;
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    ...sanitizedCandidateEnv(),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function prepareIsolatedCheckout(
  input: PrepareIsolatedCheckoutInput,
): Promise<PrepareIsolatedCheckoutResult> {
  if (input.packet.targetRepository === undefined) {
    throw new Error("Task packet is missing targetRepository");
  }
  const checkoutDir = isolatedCheckoutDirectory(input.workspaceRoot, input.packet.workerRunId);
  await mkdir(dirname(checkoutDir), { recursive: true });

  const gitAuthEnv = targetRepoGitAuthEnv(input.targetRepoReadToken);
  const parent = input.parentCandidate;
  if (parent !== undefined) {
    if (input.parentPatchContent === undefined) {
      throw new Error("Parent candidate patch content is required");
    }
    if (parent.sourceRepository !== input.packet.targetRepository) {
      throw new Error("Parent candidate repository does not match task target");
    }
    if (!verifyPatchChecksum(input.parentPatchContent, parent.patchChecksumSha256)) {
      throw new Error("Parent candidate patch checksum mismatch");
    }

    let exitCode = await input.git.run(
      ["clone", "--no-checkout", buildCloneUrl(input.packet.targetRepository), checkoutDir],
      undefined,
      gitAuthEnv,
    );
    if (exitCode !== 0) throw new Error("Failed to clone target repository checkout");
    exitCode = await input.git.run(
      ["fetch", "--depth", "1", "origin", parent.baseCommitSha],
      checkoutDir,
      gitAuthEnv,
    );
    if (exitCode !== 0) throw new Error("Failed to fetch parent candidate base commit");
    exitCode = await input.git.run(["checkout", "--detach", parent.baseCommitSha], checkoutDir);
    if (exitCode !== 0) throw new Error("Failed to checkout parent candidate base commit");

    const patchFile = join(dirname(checkoutDir), "parent-candidate.patch");
    try {
      await writeFile(patchFile, input.parentPatchContent, "utf8");
      exitCode = await input.git.run(["apply", "--check", patchFile], checkoutDir);
      if (exitCode !== 0) throw new Error("Parent candidate patch check failed");
      exitCode = await input.git.run(["apply", "--whitespace=nowarn", patchFile], checkoutDir);
      if (exitCode !== 0) throw new Error("Parent candidate patch apply failed");
    } finally {
      await rm(patchFile, { force: true });
    }
    return { checkoutDir };
  }

  const cloneArgs = ["clone", "--depth", "1"];
  if (input.packet.targetRef !== undefined && input.packet.targetRef.length > 0) {
    cloneArgs.push("--branch", input.packet.targetRef);
  }
  cloneArgs.push(buildCloneUrl(input.packet.targetRepository), checkoutDir);
  const exitCode = await input.git.run(cloneArgs, undefined, gitAuthEnv);
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

export interface GitCaptureReader {
  readRevParse(cwd: string, ref?: string): Promise<string>;
  stageAll(cwd: string): Promise<void>;
  readUnifiedDiff(cwd: string): Promise<string>;
  readChangedPaths(cwd: string): Promise<readonly string[]>;
}

export interface CheckoutCandidateCapture {
  readonly baseCommitSha: string;
  readonly patchContent: string;
  readonly changedFiles: readonly string[];
}

export async function captureCheckoutCandidate(
  checkoutDir: string,
  capture: GitCaptureReader,
): Promise<CheckoutCandidateCapture> {
  const baseCommitSha = (await capture.readRevParse(checkoutDir, "HEAD")).trim();
  await capture.stageAll(checkoutDir);
  const patchContent = await capture.readUnifiedDiff(checkoutDir);
  const changedFiles = await capture.readChangedPaths(checkoutDir);
  return { baseCommitSha, patchContent, changedFiles };
}

export function createGitCaptureReader(runner: ProcessRunner = createSubprocessRunner()): GitCaptureReader {
  return {
    async readRevParse(cwd, ref = "HEAD") {
      const result = await runner.run({
        command: "git",
        args: ["rev-parse", ref],
        cwd,
        timeoutMs: 120_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(`git rev-parse failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    },
    async stageAll(cwd) {
      const result = await runner.run({
        command: "git",
        args: ["add", "-A"],
        cwd,
        timeoutMs: 120_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(`git add failed: ${result.stderr}`);
      }
    },
    async readUnifiedDiff(cwd) {
      const result = await runner.run({
        command: "git",
        args: ["diff", "--cached", "--binary", "--no-color", "HEAD"],
        cwd,
        timeoutMs: 120_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(`git diff failed: ${result.stderr}`);
      }
      return result.stdout;
    },
    async readChangedPaths(cwd) {
      const result = await runner.run({
        command: "git",
        args: ["status", "--porcelain"],
        cwd,
        timeoutMs: 120_000,
      });
      return result.stdout
        .split("\n")
        .filter((line) => line.length > 3)
        .map((line) => line.slice(3).trim())
        .filter((path) => path.length > 0);
    },
  };
}

export function createGitRunner(runner: ProcessRunner = createSubprocessRunner()): GitRunner {
  return {
    async run(args, cwd, env) {
      const result = await runner.run({
        command: "git",
        args,
        cwd: cwd ?? process.cwd(),
        timeoutMs: 600_000,
        ...(env !== undefined ? { env } : {}),
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

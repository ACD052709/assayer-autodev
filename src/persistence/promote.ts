import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeCandidate, PromotionRun } from "../domain/code-candidate.js";
import type { Project } from "../domain/project.js";
import type { Task } from "../domain/task.js";
import { verifyPatchChecksum } from "../security/checksum.js";
import {
  buildDeterministicCommitMessage,
  resolvePromotionDestination,
} from "../domain/promotion-target.js";

export class PromotionEligibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionEligibilityError";
  }
}

export class PromotionExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionExecutionError";
  }
}

export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface PromotionExecutionInput {
  readonly candidate: CodeCandidate;
  readonly promotionRun: PromotionRun;
  readonly project: Project;
  readonly task: Task;
  readonly patchContent: string;
  /** Existing clean checkout of destinationRepository at candidate.baseCommitSha. */
  readonly workDir: string;
  readonly git: GitCommandRunner;
}

export interface PromotionExecutionResult {
  readonly resultingCommitSha: string;
  readonly commitMessage: string;
  readonly reusedExistingRemoteCommit: boolean;
}

function expectedCommitMessage(input: PromotionExecutionInput | {
  candidate: CodeCandidate;
  promotionRun: PromotionRun;
  task: Task;
}): string {
  return buildDeterministicCommitMessage({
    taskId: input.task.id,
    workerRunId: input.candidate.workerRunId,
    verifierRunId: input.promotionRun.verifierRunId,
    codeCandidateId: input.candidate.id,
    patchChecksumSha256: input.candidate.patchChecksumSha256,
  });
}

export function assertPromotionEligible(input: {
  readonly task: Task;
  readonly candidate: CodeCandidate;
  readonly promotionRun: PromotionRun;
  readonly project: Project;
  readonly patchContent: string;
}): void {
  if (input.task.status !== "completed") {
    throw new PromotionEligibilityError("Task is not completed");
  }
  if (input.candidate.status !== "promotion_eligible" && input.candidate.status !== "promoted") {
    throw new PromotionEligibilityError(`Candidate status is ${input.candidate.status}`);
  }
  if (input.candidate.acceptedTaskId !== input.task.id || input.promotionRun.taskId !== input.task.id) {
    throw new PromotionEligibilityError("Candidate was not accepted for this task");
  }
  if (input.promotionRun.workerRunId !== input.candidate.workerRunId) {
    throw new PromotionEligibilityError("Candidate worker run mismatch");
  }
  if (input.promotionRun.codeCandidateId !== input.candidate.id) {
    throw new PromotionEligibilityError("Promotion run candidate mismatch");
  }
  if (
    input.candidate.verifierRunId === undefined ||
    input.candidate.verifierRunId !== input.promotionRun.verifierRunId
  ) {
    throw new PromotionEligibilityError("Verifier provenance mismatch");
  }
  if (input.promotionRun.baseCommitSha !== input.candidate.baseCommitSha) {
    throw new PromotionEligibilityError("Promotion base commit mismatch");
  }
  if (input.candidate.testExitCode !== 0) {
    throw new PromotionEligibilityError("Candidate trusted tests did not pass");
  }
  if (!verifyPatchChecksum(input.patchContent, input.candidate.patchChecksumSha256)) {
    throw new PromotionEligibilityError("Candidate patch checksum mismatch");
  }

  const expectedDestination = resolvePromotionDestination({
    project: input.project,
    taskId: input.task.id,
  });
  if (
    expectedDestination.repository !== input.promotionRun.destinationRepository ||
    expectedDestination.ref !== input.promotionRun.destinationRef
  ) {
    throw new PromotionEligibilityError("Promotion destination does not match project policy");
  }

  // Part 7 intentionally promotes only to a task branch in the same repository as the source.
  // Supporting a separate promotion repository requires a separate base-transfer policy.
  if (input.candidate.sourceRepository !== input.promotionRun.destinationRepository) {
    throw new PromotionEligibilityError("Cross-repository promotion is not supported");
  }
  if (
    input.project.targetRepository !== undefined &&
    input.candidate.sourceRepository !== input.project.targetRepository
  ) {
    throw new PromotionEligibilityError("Candidate repository does not match project target");
  }
  if (
    input.project.targetRef !== undefined &&
    input.candidate.sourceRef !== undefined &&
    input.candidate.sourceRef !== input.project.targetRef
  ) {
    throw new PromotionEligibilityError("Candidate source ref does not match project target ref");
  }
}

function normalizeGitHubRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/i, "");
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (https) return https[1]!.toLowerCase();
  const ssh = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (ssh) return ssh[1]!.toLowerCase();
  const sshUrl = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/i);
  if (sshUrl) return sshUrl[1]!.toLowerCase();
  return undefined;
}

async function requireGitOk(
  git: GitCommandRunner,
  args: readonly string[],
  cwd: string,
  message: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await git.run(args, cwd);
  if (result.exitCode !== 0) {
    throw new PromotionExecutionError(`${message}: ${result.stderr.trim()}`.replace(/:\s*$/, ""));
  }
  return result;
}

async function remoteBranchIdentity(input: {
  git: GitCommandRunner;
  workDir: string;
  destinationRef: string;
}): Promise<{ commitSha: string; parentSha: string; treeSha: string } | undefined> {
  const fullRef = `refs/heads/${input.destinationRef}`;
  const ls = await input.git.run(["ls-remote", "--heads", "origin", fullRef], input.workDir);
  if (ls.exitCode !== 0) {
    throw new PromotionExecutionError(`Unable to inspect destination ref: ${ls.stderr.trim()}`);
  }
  const line = ls.stdout.trim();
  if (line.length === 0) return undefined;
  const commitSha = line.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) {
    throw new PromotionExecutionError("Destination ref returned an invalid commit SHA");
  }
  await requireGitOk(input.git, ["fetch", "--no-tags", "origin", fullRef], input.workDir, "Fetch destination ref failed");
  const fetched = (await requireGitOk(input.git, ["rev-parse", "FETCH_HEAD"], input.workDir, "Resolve fetched commit failed")).stdout.trim();
  const treeSha = (await requireGitOk(input.git, ["rev-parse", "FETCH_HEAD^{tree}"], input.workDir, "Resolve fetched tree failed")).stdout.trim();
  const parentSha = (await requireGitOk(input.git, ["rev-parse", "FETCH_HEAD^"], input.workDir, "Resolve fetched parent failed")).stdout.trim();
  if (fetched !== commitSha) {
    throw new PromotionExecutionError("Destination ref changed while being inspected");
  }
  return { commitSha, parentSha, treeSha };
}

export async function executePromotion(input: PromotionExecutionInput): Promise<PromotionExecutionResult> {
  assertPromotionEligible(input);
  const commitMessage = expectedCommitMessage(input);

  if (input.promotionRun.status === "succeeded" && input.promotionRun.resultingCommitSha !== undefined) {
    return {
      resultingCommitSha: input.promotionRun.resultingCommitSha,
      commitMessage,
      reusedExistingRemoteCommit: true,
    };
  }

  const clean = await requireGitOk(input.git, ["status", "--porcelain"], input.workDir, "Git status failed");
  if (clean.stdout.trim().length !== 0) {
    throw new PromotionExecutionError("Promotion checkout is not clean before candidate apply");
  }

  const head = (await requireGitOk(input.git, ["rev-parse", "HEAD"], input.workDir, "Resolve checkout HEAD failed")).stdout.trim();
  if (head !== input.candidate.baseCommitSha) {
    throw new PromotionExecutionError("Base commit SHA no longer matches checked-out target");
  }

  const remote = (await requireGitOk(input.git, ["remote", "get-url", "origin"], input.workDir, "Resolve origin failed")).stdout.trim();
  const remoteRepo = normalizeGitHubRemote(remote);
  if (remoteRepo === undefined || remoteRepo !== input.promotionRun.destinationRepository.toLowerCase()) {
    throw new PromotionExecutionError("Checked-out repository does not match promotion destination");
  }

  if (input.candidate.sourceRef !== undefined) {
    const sourceRef = `refs/heads/${input.candidate.sourceRef}`;
    const remoteSource = await input.git.run(["ls-remote", "--heads", "origin", sourceRef], input.workDir);
    if (remoteSource.exitCode !== 0) {
      throw new PromotionExecutionError(`Unable to inspect source ref: ${remoteSource.stderr.trim()}`);
    }
    const sourceSha = remoteSource.stdout.trim().split(/\s+/)[0] ?? "";
    if (sourceSha !== input.candidate.baseCommitSha) {
      throw new PromotionExecutionError("Source ref moved after candidate creation");
    }
  }

  const tempDir = await mkdtemp(join(tmpdir(), "autodev-promote-"));
  const patchFile = join(tempDir, "candidate.patch");
  try {
    await writeFile(patchFile, input.patchContent, "utf8");
    await requireGitOk(
      input.git,
      ["apply", "--check", "--whitespace=nowarn", patchFile],
      input.workDir,
      "Patch check failed",
    );
    await requireGitOk(
      input.git,
      ["apply", "--whitespace=nowarn", patchFile],
      input.workDir,
      "Patch apply failed",
    );
    await requireGitOk(input.git, ["add", "-A"], input.workDir, "Stage candidate failed");
    const expectedTree = (await requireGitOk(input.git, ["write-tree"], input.workDir, "Resolve candidate tree failed")).stdout.trim();

    const existingRemote = await remoteBranchIdentity({
      git: input.git,
      workDir: input.workDir,
      destinationRef: input.promotionRun.destinationRef,
    });
    if (existingRemote !== undefined) {
      if (
        existingRemote.parentSha === input.candidate.baseCommitSha &&
        existingRemote.treeSha === expectedTree
      ) {
        return {
          resultingCommitSha: existingRemote.commitSha,
          commitMessage,
          reusedExistingRemoteCommit: true,
        };
      }
      throw new PromotionExecutionError("Destination ref already exists with incompatible content");
    }

    await requireGitOk(input.git, ["config", "user.name", "Assayer AutoDev"], input.workDir, "Set git user name failed");
    await requireGitOk(input.git, ["config", "user.email", "autodev@users.noreply.github.com"], input.workDir, "Set git user email failed");
    await requireGitOk(input.git, ["checkout", "-b", input.promotionRun.destinationRef], input.workDir, "Create promotion branch failed");
    await requireGitOk(input.git, ["commit", "-m", commitMessage], input.workDir, "Commit failed");
    const resultingCommitSha = (await requireGitOk(input.git, ["rev-parse", "HEAD"], input.workDir, "Resolve promotion commit failed")).stdout.trim();

    const push = await input.git.run(
      ["push", "origin", `HEAD:refs/heads/${input.promotionRun.destinationRef}`],
      input.workDir,
    );
    if (push.exitCode !== 0) {
      const racedRemote = await remoteBranchIdentity({
        git: input.git,
        workDir: input.workDir,
        destinationRef: input.promotionRun.destinationRef,
      });
      if (
        racedRemote !== undefined &&
        racedRemote.parentSha === input.candidate.baseCommitSha &&
        racedRemote.treeSha === expectedTree
      ) {
        return {
          resultingCommitSha: racedRemote.commitSha,
          commitMessage,
          reusedExistingRemoteCommit: true,
        };
      }
      throw new PromotionExecutionError(`Push failed: ${push.stderr.trim()}`);
    }

    return { resultingCommitSha, commitMessage, reusedExistingRemoteCommit: false };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function createSubprocessGitRunner(): GitCommandRunner {
  return {
    async run(args, cwd) {
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("git", [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

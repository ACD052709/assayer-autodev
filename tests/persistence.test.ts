import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureCheckoutCandidate,
  createGitCaptureReader,
} from "../src/actuator/coding-task-checkout.js";
import type {
  CodeCandidate,
  PromotionRun,
} from "../src/domain/code-candidate.js";
import type { Project } from "../src/domain/project.js";
import { assertPromotionRepositoryAllowed } from "../src/domain/promotion-target.js";
import type { Task } from "../src/domain/task.js";
import {
  PromotionEligibilityError,
  PromotionExecutionError,
  createSubprocessGitRunner,
  executePromotion,
  type GitCommandRunner,
} from "../src/persistence/promote.js";
import { sha256Hex } from "../src/security/checksum.js";
import { createSubprocessRunner } from "../src/actuator/process-runner.js";

const REPOSITORY = "ACD052709/assayer-autodev-coding-smoke";
const TS = "2026-08-31T00:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function setupRemote() {
  const root = mkdtempSync(join(tmpdir(), "autodev-persist-test-"));
  roots.push(root);

  const remote = join(root, "remote.git");
  const seed = join(root, "seed");

  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "main", seed);

  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.test");

  writeFileSync(
    join(seed, "math.js"),
    "module.exports = { add: (a, b) => a - b };\n",
  );

  git(seed, "add", "-A");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");

  const baseCommitSha = git(seed, "rev-parse", "HEAD");

  return {
    root,
    remote,
    seed,
    baseCommitSha,
  };
}

function cloneAt(remote: string, path: string, ref = "main") {
  git(join(path, ".."), "clone", "--branch", ref, remote, path);
}

function githubIdentityRunner(): GitCommandRunner {
  const real = createSubprocessGitRunner();

  return {
    async run(args, cwd) {
      if (
        args[0] === "remote" &&
        args[1] === "get-url" &&
        args[2] === "origin"
      ) {
        return {
          exitCode: 0,
          stdout: `https://github.com/${REPOSITORY}.git\n`,
          stderr: "",
        };
      }

      return real.run(args, cwd);
    },
  };
}

function entities(
  baseCommitSha: string,
  patchContent: string,
  overrides?: Partial<CodeCandidate>,
) {
  const project: Project = {
    id: "proj-1",
    name: "Disposable",
    description: "Disposable",
    targetRepository: REPOSITORY,
    targetRef: "main",
    promotionRepository: REPOSITORY,
    promotionRefPrefix: "autodev",
    doNotModifyConstraints: [],
    status: "active",
    statusChangedAt: TS,
    createdAt: TS,
    updatedAt: TS,
  };

  const task: Task = {
    id: "task-1",
    projectId: project.id,
    title: "Fix add",
    description: "Fix add",
    kind: "implementation",
    status: "completed",
    statusChangedAt: TS,
    dependencyIds: [],
    assignedWorkerRunId: "wrun-1",
    createdAt: TS,
    updatedAt: TS,
  };

  const candidate: CodeCandidate = {
    id: "cand-task-1-wrun-1",
    projectId: project.id,
    taskId: task.id,
    workerRunId: "wrun-1",
    sourceRepository: REPOSITORY,
    sourceRef: "main",
    baseCommitSha,
    changedFiles: ["math.js"],
    patchChecksumSha256: sha256Hex(patchContent),
    patchContentRef: "proj-1/candidates/cand-task-1-wrun-1",
    testCommand: "node --test math.test.js",
    testExitCode: 0,
    status: "promotion_eligible",
    verifierRunId: "ver-1",
    acceptedTaskId: task.id,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };

  const promotionRun: PromotionRun = {
    id: "prom-cand-task-1-wrun-1",
    projectId: project.id,
    codeCandidateId: candidate.id,
    taskId: task.id,
    workerRunId: candidate.workerRunId,
    verifierRunId: "ver-1",
    destinationRepository: REPOSITORY,
    destinationRef: "autodev/task-1",
    baseCommitSha,
    status: "pending",
    createdAt: TS,
    updatedAt: TS,
  };

  return {
    project,
    task,
    candidate,
    promotionRun,
  };
}

async function buildPatch(remote: string, root: string) {
  const candidateDir = join(root, "candidate");

  cloneAt(remote, candidateDir);

  writeFileSync(
    join(candidateDir, "math.js"),
    "module.exports = { add: (a, b) => a + b };\n",
  );

  const capture = await captureCheckoutCandidate(
    candidateDir,
    createGitCaptureReader(createSubprocessRunner()),
  );

  return {
    candidateDir,
    ...capture,
  };
}

describe("Part 7 candidate capture", () => {
  it("captures tracked and newly-created files in a binary-safe staged patch", async () => {
    const { root, remote } = setupRemote();
    const candidateDir = join(root, "capture");

    cloneAt(remote, candidateDir);

    writeFileSync(
      join(candidateDir, "math.js"),
      "module.exports = { add: (a, b) => a + b };\n",
    );

    writeFileSync(
      join(candidateDir, "new-file.txt"),
      "new candidate bytes\n",
    );

    const capture = await captureCheckoutCandidate(
      candidateDir,
      createGitCaptureReader(createSubprocessRunner()),
    );

    expect(capture.baseCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(capture.changedFiles).toContain("math.js");
    expect(capture.changedFiles).toContain("new-file.txt");
    expect(capture.patchContent).toContain("new file mode");
    expect(capture.patchContent).toContain("new-file.txt");
  });
});

describe("Part 7 verified promotion", () => {
  it("refuses an unverified candidate", async () => {
    const {
      root,
      remote,
      baseCommitSha,
    } = setupRemote();

    const { patchContent } = await buildPatch(remote, root);
    const workDir = join(root, "promote");

    cloneAt(remote, workDir);

    const {
      project,
      task,
      promotionRun,
      candidate: verifiedCandidate,
    } = entities(baseCommitSha, patchContent, {
      status: "pending_verification",
    });

    const {
      verifierRunId: _omittedVerifierRunId,
      acceptedTaskId: _omittedAcceptedTaskId,
      ...candidate
    } = verifiedCandidate;

    void _omittedVerifierRunId;
    void _omittedAcceptedTaskId;

    await expect(
      executePromotion({
        project,
        task,
        promotionRun,
        candidate,
        patchContent,
        workDir,
        git: githubIdentityRunner(),
      }),
    ).rejects.toBeInstanceOf(PromotionEligibilityError);
  });

  it(
    "promotes an accepted candidate exactly once and is idempotent on retry",
    async () => {
      const {
        root,
        remote,
        baseCommitSha,
      } = setupRemote();

      const { patchContent } = await buildPatch(remote, root);
      const entities1 = entities(baseCommitSha, patchContent);

      const workDir = join(root, "promote-1");
      cloneAt(remote, workDir);

      const first = await executePromotion({
        ...entities1,
        patchContent,
        workDir,
        git: githubIdentityRunner(),
      });

      expect(first.reusedExistingRemoteCommit).toBe(false);

      expect(
        git(
          root,
          `--git-dir=${remote}`,
          "show",
          "autodev/task-1:math.js",
        ),
      ).toContain("a + b");

      expect(
        git(
          root,
          `--git-dir=${remote}`,
          "rev-list",
          "--count",
          "autodev/task-1",
        ),
      ).toBe("2");

      const retryDir = join(root, "promote-2");
      cloneAt(remote, retryDir);

      const second = await executePromotion({
        ...entities1,
        patchContent,
        workDir: retryDir,
        git: githubIdentityRunner(),
      });

      expect(second.reusedExistingRemoteCommit).toBe(true);
      expect(second.resultingCommitSha).toBe(first.resultingCommitSha);

      expect(
        git(
          root,
          `--git-dir=${remote}`,
          "rev-list",
          "--count",
          "autodev/task-1",
        ),
      ).toBe("2");
    },
    15000,
  );

  it("fails closed when the source ref moved", async () => {
    const {
      root,
      remote,
      seed,
      baseCommitSha,
    } = setupRemote();

    const { patchContent } = await buildPatch(remote, root);

    writeFileSync(join(seed, "later.txt"), "later\n");

    git(seed, "add", "-A");
    git(seed, "commit", "-m", "move main");
    git(seed, "push", "origin", "main");

    const workDir = join(root, "promote-moved");

    git(root, "clone", remote, workDir);
    git(workDir, "checkout", baseCommitSha);

    const e = entities(baseCommitSha, patchContent);

    await expect(
      executePromotion({
        ...e,
        patchContent,
        workDir,
        git: githubIdentityRunner(),
      }),
    ).rejects.toThrow("Source ref moved");

    expect(
      git(
        root,
        `--git-dir=${remote}`,
        "branch",
        "--list",
        "autodev/task-1",
      ),
    ).toBe("");
  });

  it("rejects a tampered candidate checksum before mutation", async () => {
    const {
      root,
      remote,
      baseCommitSha,
    } = setupRemote();

    const { patchContent } = await buildPatch(remote, root);
    const workDir = join(root, "promote-tamper");

    cloneAt(remote, workDir);

    const e = entities(baseCommitSha, patchContent);

    await expect(
      executePromotion({
        ...e,
        patchContent: `${patchContent}\n# tampered`,
        workDir,
        git: githubIdentityRunner(),
      }),
    ).rejects.toThrow("checksum mismatch");

    expect(
      git(
        root,
        `--git-dir=${remote}`,
        "branch",
        "--list",
        "autodev/task-1",
      ),
    ).toBe("");
  });

  it("rejects protected Assayer repository targets", () => {
    expect(() =>
      assertPromotionRepositoryAllowed("ACD052709/Assayer"),
    ).toThrow();

    expect(() =>
      assertPromotionRepositoryAllowed(REPOSITORY),
    ).not.toThrow();
  });

  it("does not update the remote when patch application fails", async () => {
    const {
      root,
      remote,
      baseCommitSha,
    } = setupRemote();

    const badPatch =
      "diff --git a/missing.txt b/missing.txt\n" +
      "--- a/missing.txt\n" +
      "+++ b/missing.txt\n" +
      "@@ -1 +1 @@\n" +
      "-nope\n" +
      "+fixed\n";

    const workDir = join(root, "promote-bad");

    cloneAt(remote, workDir);

    const e = entities(baseCommitSha, badPatch);

    await expect(
      executePromotion({
        ...e,
        patchContent: badPatch,
        workDir,
        git: githubIdentityRunner(),
      }),
    ).rejects.toBeInstanceOf(PromotionExecutionError);

    expect(
      git(
        root,
        `--git-dir=${remote}`,
        "branch",
        "--list",
        "autodev/task-1",
      ),
    ).toBe("");

    expect(
      readFileSync(
        join(workDir, "math.js"),
        "utf8",
      ),
    ).toContain("a - b");
  });
});

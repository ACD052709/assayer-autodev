import type { EntityId } from "../domain/common.js";

export interface VerifierLaunchInput {
  readonly verifierRunId: EntityId;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly testCaseId: EntityId;
  readonly workerRunId: EntityId;
  readonly codeCandidateId?: EntityId;
  /** Deprecated compatibility input; exact-candidate verifier ignores external URLs. */
  readonly targetUrl?: string;
}

export interface VerifierLaunchRecord {
  readonly verifierRunId: EntityId;
  readonly launched: boolean;
  readonly skipped?: boolean;
  readonly reason?: string;
  readonly errorMessage?: string;
}

export interface VerifierLaunchBridge {
  launch(input: VerifierLaunchInput): Promise<VerifierLaunchRecord>;
}

export interface GitHubVerifierLaunchBridgeConfig {
  readonly token: string;
  readonly repository: string;
  readonly workflowFile: string;
  readonly ref: string;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERIFIER_RUN_ID_PATTERN = /^ver-[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const NOOP_VERIFIER_LAUNCH_BRIDGE: VerifierLaunchBridge = {
  async launch(input) {
    return {
      verifierRunId: input.verifierRunId,
      launched: false,
      skipped: true,
      reason: "verifier_launch_bridge_not_configured",
    };
  },
};

function parseRepository(repository: string): { owner: string; repo: string } {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/repo");
  }
  const [owner, repo] = repository.split("/");
  return { owner: owner!, repo: repo! };
}

function assertVerifierRunId(verifierRunId: EntityId): EntityId {
  if (!VERIFIER_RUN_ID_PATTERN.test(verifierRunId)) {
    throw new Error("Invalid verifierRunId");
  }
  return verifierRunId;
}

export function createGitHubVerifierLaunchBridge(
  config: GitHubVerifierLaunchBridgeConfig,
  fetchFn: typeof fetch = fetch,
): VerifierLaunchBridge {
  const { owner, repo } = parseRepository(config.repository);
  const workflowFile = config.workflowFile.trim();
  if (workflowFile.length === 0) {
    throw new Error("workflowFile is required");
  }
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;

  return {
    async launch(input: VerifierLaunchInput): Promise<VerifierLaunchRecord> {
      const verifierRunId = assertVerifierRunId(input.verifierRunId);
      if (input.codeCandidateId === undefined || input.codeCandidateId.length === 0) {
        return { verifierRunId, launched: false, errorMessage: "codeCandidateId is required for exact-candidate verification" };
      }
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "assayer-autodev-control-plane",
          },
          body: JSON.stringify({
            ref: config.ref,
            inputs: {
              verifierRunId,
              projectId: input.projectId,
              taskId: input.taskId,
              testCaseId: input.testCaseId,
              workerRunId: input.workerRunId,
              codeCandidateId: input.codeCandidateId,
            },
          }),
        });
        if (response.status === 204) {
          return { verifierRunId, launched: true };
        }
        const body = await response.text();
        const detail = body.length > 0 ? body.slice(0, 500) : response.statusText;
        return {
          verifierRunId,
          launched: false,
          errorMessage: `GitHub verifier workflow_dispatch failed (${response.status}): ${detail}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "verifier workflow_dispatch request failed";
        return { verifierRunId, launched: false, errorMessage: message };
      }
    },
  };
}

export function createGitHubVerifierLaunchBridgeFromEnv(env: {
  readonly GITHUB_TOKEN?: string;
  readonly GITHUB_REPOSITORY?: string;
  readonly GITHUB_VERIFIER_WORKFLOW_FILE?: string;
  readonly GITHUB_WORKFLOW_REF?: string;
}): VerifierLaunchBridge | undefined {
  const token = env.GITHUB_TOKEN?.trim();
  const repository = env.GITHUB_REPOSITORY?.trim();
  if (token === undefined || token.length === 0 || repository === undefined || repository.length === 0) {
    return undefined;
  }
  return createGitHubVerifierLaunchBridge({
    token,
    repository,
    workflowFile: env.GITHUB_VERIFIER_WORKFLOW_FILE?.trim() || "autodev-browser-verifier.yml",
    ref: env.GITHUB_WORKFLOW_REF?.trim() || "main",
  });
}

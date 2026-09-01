import type { EntityId } from "../domain/common.js";

export interface PromotionLaunchInput {
  readonly promotionRunId: EntityId;
  readonly projectId: EntityId;
  readonly codeCandidateId: EntityId;
  readonly taskId: EntityId;
  readonly workerRunId: EntityId;
  readonly verifierRunId: EntityId;
  readonly destinationRepository: string;
  readonly destinationRef: string;
  readonly baseCommitSha: string;
}

export interface PromotionLaunchRecord {
  readonly promotionRunId: EntityId;
  readonly launched: boolean;
  readonly skipped?: boolean;
  readonly reason?: string;
  readonly errorMessage?: string;
}

export interface PromotionLaunchBridge {
  launch(input: PromotionLaunchInput): Promise<PromotionLaunchRecord>;
}

export interface GitHubPromotionLaunchBridgeConfig {
  readonly token: string;
  readonly repository: string;
  readonly workflowFile: string;
  readonly ref: string;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROMOTION_RUN_ID_PATTERN = /^prom-[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const NOOP_PROMOTION_LAUNCH_BRIDGE: PromotionLaunchBridge = {
  async launch(input) {
    return {
      promotionRunId: input.promotionRunId,
      launched: false,
      skipped: true,
      reason: "promotion_launch_bridge_not_configured",
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

function assertPromotionRunId(promotionRunId: EntityId): EntityId {
  if (!PROMOTION_RUN_ID_PATTERN.test(promotionRunId)) {
    throw new Error("Invalid promotionRunId");
  }
  return promotionRunId;
}

export function createGitHubPromotionLaunchBridge(
  config: GitHubPromotionLaunchBridgeConfig,
  fetchFn: typeof fetch = fetch,
): PromotionLaunchBridge {
  const { owner, repo } = parseRepository(config.repository);
  const workflowFile = config.workflowFile.trim();
  if (workflowFile.length === 0) {
    throw new Error("workflowFile is required");
  }
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;

  return {
    async launch(input: PromotionLaunchInput): Promise<PromotionLaunchRecord> {
      const promotionRunId = assertPromotionRunId(input.promotionRunId);
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ref: config.ref,
            inputs: {
              promotionRunId,
              projectId: input.projectId,
              codeCandidateId: input.codeCandidateId,
              taskId: input.taskId,
              workerRunId: input.workerRunId,
              verifierRunId: input.verifierRunId,
              destinationRepository: input.destinationRepository,
              destinationRef: input.destinationRef,
              baseCommitSha: input.baseCommitSha,
            },
          }),
        });
        if (response.status === 204) {
          return { promotionRunId, launched: true };
        }
        const text = await response.text();
        return {
          promotionRunId,
          launched: false,
          errorMessage: text.length > 0 ? text.slice(0, 240) : `GitHub dispatch failed (${response.status})`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Promotion launch failed";
        return { promotionRunId, launched: false, errorMessage: message };
      }
    },
  };
}

export function createGitHubPromotionLaunchBridgeFromEnv(
  env: {
    readonly GITHUB_TOKEN?: string;
    readonly GITHUB_REPOSITORY?: string;
    readonly GITHUB_PROMOTION_WORKFLOW_FILE?: string;
    readonly GITHUB_WORKFLOW_REF?: string;
  },
): PromotionLaunchBridge | undefined {
  const token = env.GITHUB_TOKEN?.trim();
  const repository = env.GITHUB_REPOSITORY?.trim();
  if (token === undefined || token.length === 0 || repository === undefined || repository.length === 0) {
    return undefined;
  }
  return createGitHubPromotionLaunchBridge({
    token,
    repository,
    workflowFile: env.GITHUB_PROMOTION_WORKFLOW_FILE?.trim() || "autodev-promote.yml",
    ref: env.GITHUB_WORKFLOW_REF?.trim() || "main",
  });
}

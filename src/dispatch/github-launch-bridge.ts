import type { EntityId } from "../domain/index.js";

export interface WorkerLaunchRecord {
  readonly workerRunId: EntityId;
  readonly launched: boolean;
  readonly skipped?: boolean;
  readonly reason?: string;
  readonly errorMessage?: string;
}

export interface WorkerLaunchBridge {
  launch(workerRunId: EntityId): Promise<WorkerLaunchRecord>;
}

export interface GitHubLaunchBridgeConfig {
  readonly token: string;
  readonly repository: string;
  readonly workflowFile: string;
  readonly ref: string;
  readonly executionMode: string;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKER_RUN_ID_PATTERN = /^wrun-[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const NOOP_WORKER_LAUNCH_BRIDGE: WorkerLaunchBridge = {
  async launch(workerRunId) {
    return {
      workerRunId,
      launched: false,
      skipped: true,
      reason: "launch_bridge_not_configured",
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

function assertWorkerRunId(workerRunId: EntityId): EntityId {
  if (!WORKER_RUN_ID_PATTERN.test(workerRunId)) {
    throw new Error("Invalid workerRunId");
  }
  return workerRunId;
}

export function createGitHubLaunchBridge(
  config: GitHubLaunchBridgeConfig,
  fetchFn: typeof fetch = fetch,
): WorkerLaunchBridge {
  const { owner, repo } = parseRepository(config.repository);
  const workflowFile = config.workflowFile.trim();
  if (workflowFile.length === 0) {
    throw new Error("workflowFile is required");
  }
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;

  return {
    async launch(workerRunId: EntityId): Promise<WorkerLaunchRecord> {
      const id = assertWorkerRunId(workerRunId);
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
              workerRunId: id,
              executionMode: config.executionMode,
            },
          }),
        });
        if (response.status === 204) {
          return { workerRunId: id, launched: true };
        }
        const body = await response.text();
        const detail = body.length > 0 ? body.slice(0, 500) : response.statusText;
        return {
          workerRunId: id,
          launched: false,
          errorMessage: `GitHub workflow_dispatch failed (${response.status}): ${detail}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "workflow_dispatch request failed";
        return { workerRunId: id, launched: false, errorMessage: message };
      }
    },
  };
}

export function createGitHubLaunchBridgeFromEnv(env: {
  readonly GITHUB_TOKEN?: string;
  readonly GITHUB_REPOSITORY?: string;
  readonly GITHUB_WORKFLOW_FILE?: string;
  readonly GITHUB_WORKFLOW_REF?: string;
  readonly GITHUB_EXECUTION_MODE?: string;
}): WorkerLaunchBridge | undefined {
  const token = env.GITHUB_TOKEN?.trim();
  const repository = env.GITHUB_REPOSITORY?.trim();
  if (token === undefined || token.length === 0 || repository === undefined || repository.length === 0) {
    return undefined;
  }
  return createGitHubLaunchBridge({
    token,
    repository,
    workflowFile: env.GITHUB_WORKFLOW_FILE?.trim() || "autodev-worker.yml",
    ref: env.GITHUB_WORKFLOW_REF?.trim() || "main",
    executionMode: env.GITHUB_EXECUTION_MODE?.trim() || "synthetic-noop",
  });
}

import type { CodeCandidate, PromotionRun } from "../domain/code-candidate.js";
import type { Project } from "../domain/project.js";
import type { Task } from "../domain/task.js";
import {
  PromotionExecutionError,
  assertPromotionEligible,
  createSubprocessGitRunner,
  executePromotion,
} from "./promote.js";

export interface PromotionControlPlaneClient {
  getProject(projectId: string): Promise<Project>;
  getTask(taskId: string): Promise<Task>;
  getCodeCandidate(candidateId: string): Promise<CodeCandidate>;
  getPromotionRun(promotionRunId: string): Promise<PromotionRun>;
  fetchCandidatePatch(candidateId: string): Promise<string>;
  completePromotionRun(input: {
    promotionRunId: string;
    status: "succeeded" | "failed";
    resultingCommitSha?: string;
    errorMessage?: string;
  }): Promise<PromotionRun>;
}

export interface PromotionControlPlaneClientOptions {
  readonly controlPlaneUrl?: string;
  readonly serviceToken?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createPromotionControlPlaneClient(
  options: PromotionControlPlaneClientOptions = {},
): PromotionControlPlaneClient {
  const base = (options.controlPlaneUrl ?? process.env.AUTODEV_CONTROL_PLANE_URL ?? "").replace(/\/+$/, "");
  const token = options.serviceToken ?? process.env.AUTODEV_SERVICE_TOKEN ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;
  if (base.length === 0 || token.length === 0) {
    throw new Error("AUTODEV_CONTROL_PLANE_URL and AUTODEV_SERVICE_TOKEN are required");
  }

  async function requestJson(method: string, path: string, body?: Record<string, unknown>) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`Control plane request failed (${response.status})`);
    }
    if (response.status === 204) {
      return {};
    }
    return (await response.json()) as Record<string, unknown>;
  }

  return {
    async getProject(projectId) {
      const payload = await requestJson("GET", `/api/projects/${encodeURIComponent(projectId)}/state`);
      return payload["project"] as Project;
    },
    async getTask(taskId) {
      const payload = await requestJson("GET", `/api/tasks/${encodeURIComponent(taskId)}`);
      return payload["task"] as Task;
    },
    async getCodeCandidate(candidateId) {
      const payload = await requestJson("GET", `/api/code-candidates/${encodeURIComponent(candidateId)}`);
      return payload["candidate"] as CodeCandidate;
    },
    async getPromotionRun(promotionRunId) {
      const payload = await requestJson("GET", `/api/promotion-runs/${encodeURIComponent(promotionRunId)}`);
      return payload["promotionRun"] as PromotionRun;
    },
    async fetchCandidatePatch(candidateId) {
      const response = await fetchImpl(
        `${base}/api/code-candidates/${encodeURIComponent(candidateId)}/patch`,
        {
          headers: { authorization: `Bearer ${token}`, accept: "text/x-patch" },
        },
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch candidate patch (${response.status})`);
      }
      return await response.text();
    },
    async completePromotionRun(input) {
      const payload = await requestJson(
        "POST",
        `/api/promotion-runs/${encodeURIComponent(input.promotionRunId)}/complete`,
        input,
      );
      return payload["promotionRun"] as PromotionRun;
    },
  };
}

export interface RunOrchestratedPromotionInput {
  readonly promotionRunId: string;
  readonly projectId: string;
  readonly codeCandidateId: string;
  readonly taskId: string;
  readonly workerRunId: string;
  readonly verifierRunId: string;
  readonly destinationRepository: string;
  readonly destinationRef: string;
  readonly client: PromotionControlPlaneClient;
  readonly workDir?: string;
  readonly git?: ReturnType<typeof createSubprocessGitRunner>;
}

export async function runOrchestratedPromotion(
  input: RunOrchestratedPromotionInput,
): Promise<{ resultingCommitSha: string }> {
  const [project, task, candidate, promotionRun] = await Promise.all([
    input.client.getProject(input.projectId),
    input.client.getTask(input.taskId),
    input.client.getCodeCandidate(input.codeCandidateId),
    input.client.getPromotionRun(input.promotionRunId),
  ]);
  const patchContent = await input.client.fetchCandidatePatch(input.codeCandidateId);

  if (promotionRun.status === "succeeded" && promotionRun.resultingCommitSha !== undefined) {
    return { resultingCommitSha: promotionRun.resultingCommitSha };
  }

  const workDir = input.workDir ?? process.env.AUTODEV_PROMOTION_WORKDIR ?? "";
  if (workDir.trim().length === 0) {
    throw new PromotionExecutionError("Promotion workDir is required");
  }

  if (
    promotionRun.id !== input.promotionRunId ||
    promotionRun.projectId !== input.projectId ||
    promotionRun.codeCandidateId !== input.codeCandidateId ||
    promotionRun.taskId !== input.taskId ||
    promotionRun.workerRunId !== input.workerRunId ||
    promotionRun.verifierRunId !== input.verifierRunId ||
    promotionRun.destinationRepository !== input.destinationRepository ||
    promotionRun.destinationRef !== input.destinationRef
  ) {
    throw new PromotionExecutionError("Promotion workflow inputs do not match authoritative promotion run");
  }
  if (candidate.id !== input.codeCandidateId || candidate.projectId !== input.projectId) {
    throw new PromotionExecutionError("Candidate identity does not match promotion inputs");
  }
  if (task.id !== input.taskId || task.projectId !== input.projectId) {
    throw new PromotionExecutionError("Task identity does not match promotion inputs");
  }

  try {
    assertPromotionEligible({
      task,
      candidate,
      promotionRun,
      project,
      patchContent,
    });
    const result = await executePromotion({
      candidate,
      promotionRun,
      project,
      task,
      patchContent,
      workDir,
      git: input.git ?? createSubprocessGitRunner(),
    });
    await input.client.completePromotionRun({
      promotionRunId: input.promotionRunId,
      status: "succeeded",
      resultingCommitSha: result.resultingCommitSha,
    });
    return { resultingCommitSha: result.resultingCommitSha };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.client.completePromotionRun({
      promotionRunId: input.promotionRunId,
      status: "failed",
      errorMessage: message.slice(0, 240),
    });
    throw error instanceof PromotionExecutionError ? error : new PromotionExecutionError(message);
  }
}

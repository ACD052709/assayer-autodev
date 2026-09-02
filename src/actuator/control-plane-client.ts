import { ActuatorError, isOwnershipLostStatus } from "./errors.js";
import { redactSecrets } from "./sanitize.js";
import type {
  ClaimResult,
  ControlPlaneClient,
  FailInput,
  HeartbeatResult,
  SucceedInput,
  TerminalResult,
} from "./types.js";
import type { WorkerTaskPacket } from "../domain/worker-task-packet.js";

export interface ControlPlaneClientOptions {
  readonly controlPlaneUrl: string;
  readonly serviceToken: string;
  readonly fetchImpl?: typeof fetch;
}

export function createControlPlaneClient(options: ControlPlaneClientOptions): ControlPlaneClient {
  const base = options.controlPlaneUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const secrets = [options.serviceToken];

  async function requestJson(
    method: string,
    path: string,
    body: Record<string, unknown>,
    extraSecrets: readonly string[] = [],
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const redact = [...secrets, ...extraSecrets];
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.serviceToken}`,
          accept: "application/json",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network error";
      throw new ActuatorError("NETWORK_ERROR", redactSecrets(message, redact));
    }

    const text = await response.text();
    let payload: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        throw new ActuatorError("PROTOCOL_ERROR", "Control plane returned non-JSON", {
          status: response.status,
        });
      }
    }

    if (!response.ok) {
      const apiError = payload["error"];
      const code =
        typeof apiError === "object" &&
        apiError !== null &&
        typeof (apiError as { code?: unknown }).code === "string"
          ? (apiError as { code: string }).code
          : "HTTP_ERROR";
      const message =
        typeof apiError === "object" &&
        apiError !== null &&
        typeof (apiError as { message?: unknown }).message === "string"
          ? (apiError as { message: string }).message
          : `Control plane request failed (${response.status})`;
      throw new ActuatorError(code, redactSecrets(message, redact), {
        status: response.status,
        ...(isOwnershipLostStatus(response.status) ? { ownershipLost: true } : {}),
      });
    }

    return { status: response.status, payload };
  }

  async function requestJsonGet(
    path: string,
    extraSecrets: readonly string[] = [],
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const redact = [...secrets, ...extraSecrets];
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.serviceToken}`,
          accept: "application/json",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network error";
      throw new ActuatorError("NETWORK_ERROR", redactSecrets(message, redact));
    }

    const text = await response.text();
    let payload: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        throw new ActuatorError("PROTOCOL_ERROR", "Control plane returned non-JSON", {
          status: response.status,
        });
      }
    }

    if (!response.ok) {
      const apiError = payload["error"];
      const code =
        typeof apiError === "object" &&
        apiError !== null &&
        typeof (apiError as { code?: unknown }).code === "string"
          ? (apiError as { code: string }).code
          : "HTTP_ERROR";
      const message =
        typeof apiError === "object" &&
        apiError !== null &&
        typeof (apiError as { message?: unknown }).message === "string"
          ? (apiError as { message: string }).message
          : `Control plane request failed (${response.status})`;
      throw new ActuatorError(code, redactSecrets(message, redact), {
        status: response.status,
        ...(isOwnershipLostStatus(response.status) ? { ownershipLost: true } : {}),
      });
    }

    return { status: response.status, payload };
  }

  return {
    async claim(workerRunId: string, ownerId: string): Promise<ClaimResult> {
      const { payload } = await requestJson("POST", `/api/worker-runs/${encodeURIComponent(workerRunId)}/claim`, {
        ownerId,
      });
      const leaseToken = payload["leaseToken"];
      const workerRun = asRecord(payload["workerRun"]);
      const task = asRecord(payload["task"]);
      if (typeof leaseToken !== "string" || leaseToken.length < 32) {
        throw new ActuatorError("PROTOCOL_ERROR", "Claim succeeded without a lease token");
      }
      if (workerRun === undefined || task === undefined) {
        throw new ActuatorError("PROTOCOL_ERROR", "Claim response missing workerRun or task");
      }
      return {
        claimed: payload["claimed"] === true,
        leaseToken,
        workerRun: { id: stringField(workerRun, "id"), status: stringField(workerRun, "status") },
        task: { id: stringField(task, "id"), status: stringField(task, "status") },
      };
    },

    async heartbeat(workerRunId: string, leaseToken: string): Promise<HeartbeatResult> {
      const { payload } = await requestJson(
        "POST",
        `/api/worker-runs/${encodeURIComponent(workerRunId)}/heartbeat`,
        { leaseToken },
        [leaseToken],
      );
      const workerRun = asRecord(payload["workerRun"]);
      if (workerRun === undefined) {
        throw new ActuatorError("PROTOCOL_ERROR", "Heartbeat response missing workerRun");
      }
      return { workerRun: { id: stringField(workerRun, "id"), status: stringField(workerRun, "status") } };
    },

    async succeed(workerRunId: string, leaseToken: string, input: SucceedInput): Promise<TerminalResult> {
      const { payload } = await requestJson(
        "POST",
        `/api/worker-runs/${encodeURIComponent(workerRunId)}/succeed`,
        {
          leaseToken,
          summary: input.summary,
          structuredOutcome: input.structuredOutcome,
        },
        [leaseToken],
      );
      return terminalFromPayload(payload);
    },

    async fail(workerRunId: string, leaseToken: string, input: FailInput): Promise<TerminalResult> {
      const { payload } = await requestJson(
        "POST",
        `/api/worker-runs/${encodeURIComponent(workerRunId)}/fail`,
        {
          leaseToken,
          errorCode: input.errorCode,
          summary: input.summary,
        },
        [leaseToken],
      );
      return terminalFromPayload(payload);
    },

    async getTaskPacket(workerRunId: string, leaseToken: string): Promise<WorkerTaskPacket> {
      const { payload } = await requestJsonGet(
        `/api/worker-runs/${encodeURIComponent(workerRunId)}/task-packet?leaseToken=${encodeURIComponent(leaseToken)}`,
        [leaseToken],
      );
      const packet = payload["packet"];
      if (typeof packet !== "object" || packet === null || Array.isArray(packet)) {
        throw new ActuatorError("PROTOCOL_ERROR", "Task packet response missing packet");
      }
      return packet as WorkerTaskPacket;
    },

    async getBudget(projectId: string, budgetId: string) {
      try {
        const { payload } = await requestJsonGet(
          `/api/projects/${encodeURIComponent(projectId)}/budgets/${encodeURIComponent(budgetId)}`,
        );
        const budget = asRecord(payload["budget"]);
        if (budget === undefined) {
          throw new ActuatorError("PROTOCOL_ERROR", "Budget response missing budget");
        }
        const hardLimit = numberField(budget, "hardLimit");
        const consumedAmount = numberField(budget, "consumedAmount");
        const remainingHardLimit = numberField(budget, "remainingHardLimit");
        return {
          resourceType: stringField(budget, "resourceType"),
          unit: stringField(budget, "unit"),
          hardLimit,
          consumedAmount,
          remainingHardLimit,
        };
      } catch (error) {
        if (error instanceof ActuatorError && error.status === 404) {
          return undefined;
        }
        throw error;
      }
    },

    async recordBudgetEntry(input) {
      await requestJson("POST", `/api/projects/${encodeURIComponent(input.projectId)}/budget-entries`, {
        id: input.id,
        resourceType: input.resourceType,
        amount: input.amount,
        unit: input.unit,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.workerRunId !== undefined ? { workerRunId: input.workerRunId } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    },


    async getCodeCandidate(candidateId: string) {
      const { payload } = await requestJsonGet(`/api/code-candidates/${encodeURIComponent(candidateId)}`);
      const candidate = payload["candidate"];
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new ActuatorError("PROTOCOL_ERROR", "Code candidate response missing candidate");
      }
      return candidate as import("../domain/code-candidate.js").CodeCandidate;
    },

    async fetchCodeCandidatePatch(candidateId: string) {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/api/code-candidates/${encodeURIComponent(candidateId)}/patch`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${options.serviceToken}`,
            accept: "text/x-patch",
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "network error";
        throw new ActuatorError("NETWORK_ERROR", redactSecrets(message, secrets));
      }
      if (!response.ok) {
        throw new ActuatorError("HTTP_ERROR", `Failed to fetch code candidate patch (${response.status})`, { status: response.status });
      }
      return await response.text();
    },
    async createCodeCandidate(input) {
      const patchBase64 = Buffer.from(input.patchContent, "utf8").toString("base64");
      await requestJson("POST", "/api/code-candidates", {
        id: input.id,
        projectId: input.projectId,
        taskId: input.taskId,
        workerRunId: input.workerRunId,
        sourceRepository: input.sourceRepository,
        ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
        ...(input.parentCandidateId !== undefined ? { parentCandidateId: input.parentCandidateId } : {}),
        baseCommitSha: input.baseCommitSha,
        changedFiles: input.changedFiles,
        patchChecksumSha256: input.patchChecksumSha256,
        patchBase64,
        testCommand: input.testCommand,
        testExitCode: input.testExitCode,
      });
      return { id: input.id };
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ActuatorError("PROTOCOL_ERROR", `Control plane response missing ${field}`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ActuatorError("PROTOCOL_ERROR", `Control plane response missing ${field}`);
  }
  return value;
}

function terminalFromPayload(payload: Record<string, unknown>): TerminalResult {
  const workerRun = asRecord(payload["workerRun"]);
  const task = asRecord(payload["task"]);
  if (workerRun === undefined || task === undefined) {
    throw new ActuatorError("PROTOCOL_ERROR", "Terminal response missing workerRun or task");
  }
  return {
    workerRun: { id: stringField(workerRun, "id"), status: stringField(workerRun, "status") },
    task: { id: stringField(task, "id"), status: stringField(task, "status") },
    applied: payload["applied"] === true,
  };
}

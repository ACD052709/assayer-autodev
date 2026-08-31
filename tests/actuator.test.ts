import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LEASE_DURATION_MS } from "../src/executor/lease.js";
import { ActuatorError } from "../src/actuator/errors.js";
import { githubActionsOwnerId } from "../src/actuator/owner-id.js";
import { parseActuatorCli } from "../src/actuator/parse-cli.js";
import { runActuator } from "../src/actuator/executor.js";
import { runSyntheticNoop } from "../src/actuator/synthetic-noop.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  SYNTHETIC_NOOP_KIND,
  type ActuatorConfig,
  type ControlPlaneClient,
} from "../src/actuator/types.js";
import { createControlPlaneClient } from "../src/actuator/control-plane-client.js";

const SERVICE_TOKEN = "service-token-value-abcdefghijklmnopqrstuvwxyz";
const LEASE_TOKEN = "a".repeat(64);
const WORKER_RUN_ID = "wrun-actuator-test";

const baseConfig: ActuatorConfig = {
  workerRunId: WORKER_RUN_ID,
  controlPlaneUrl: "https://example.test",
  serviceToken: SERVICE_TOKEN,
  ownerId: "github-actions.ACD052709.assayer-autodev.99.1",
  executionMode: "synthetic-noop",
  heartbeatIntervalMs: 100,
  heartbeatFailureLimit: 2,
  syntheticNoopDurationMs: 250,
};

function capturingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info(message: string, fields?: Record<string, unknown>) {
        lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
      },
      error(message: string, fields?: Record<string, unknown>) {
        lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
      },
    },
  };
}

function fakeTimers() {
  return {
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (id: unknown) => clearInterval(id as ReturnType<typeof setInterval>),
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ActuatorError("ABORTED", "Aborted"));
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new ActuatorError("ABORTED", "Aborted"));
      },
      { once: true },
    );
  });
}

function createRecordingClient(options?: {
  claimError?: Error;
  heartbeatError?: Error | (() => Error);
  succeedError?: Error;
  failError?: Error;
}): { client: ControlPlaneClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let heartbeatCount = 0;
  const client: ControlPlaneClient = {
    async claim(workerRunId, ownerId) {
      calls.push({ op: "claim", workerRunId, ownerId });
      if (options?.claimError) {
        throw options.claimError;
      }
      return {
        claimed: true,
        leaseToken: LEASE_TOKEN,
        workerRun: { id: workerRunId, status: "running" },
        task: { id: "task-1", status: "in_progress" },
      };
    },
    async heartbeat(workerRunId, leaseToken) {
      heartbeatCount += 1;
      calls.push({ op: "heartbeat", workerRunId, leaseToken });
      if (typeof options?.heartbeatError === "function") {
        throw options.heartbeatError();
      }
      if (options?.heartbeatError) {
        throw options.heartbeatError;
      }
      return { workerRun: { id: workerRunId, status: "running" } };
    },
    async succeed(workerRunId, leaseToken, input) {
      calls.push({ op: "succeed", workerRunId, leaseToken, input });
      if (options?.succeedError) {
        throw options.succeedError;
      }
      return {
        workerRun: { id: workerRunId, status: "succeeded" },
        task: { id: "task-1", status: "awaiting_verification" },
        applied: true,
      };
    },
    async fail(workerRunId, leaseToken, input) {
      calls.push({ op: "fail", workerRunId, leaseToken, input });
      if (options?.failError) {
        throw options.failError;
      }
      return {
        workerRun: { id: workerRunId, status: "failed" },
        task: { id: "task-1", status: "failed" },
        applied: true,
      };
    },
  };
  void heartbeatCount;
  return { client, calls };
}

describe("githubActionsOwnerId", () => {
  it("maps GitHub metadata into a valid control-plane ownerId", () => {
    expect(
      githubActionsOwnerId({
        repository: "ACD052709/assayer-autodev",
        runId: "12345",
        runAttempt: "2",
      }),
    ).toBe("github-actions.ACD052709.assayer-autodev.12345.2");
  });
});

describe("parseActuatorCli", () => {
  const env = {
    AUTODEV_SERVICE_TOKEN: SERVICE_TOKEN,
    AUTODEV_CONTROL_PLANE_URL: "https://assayer-autodev-control-plane.gr8white911.workers.dev",
    GITHUB_REPOSITORY: "ACD052709/assayer-autodev",
    GITHUB_RUN_ID: "99",
    GITHUB_RUN_ATTEMPT: "1",
  };

  it("builds config from flags and GitHub env", () => {
    const config = parseActuatorCli(
      ["--worker-run-id", WORKER_RUN_ID, "--execution-mode", "synthetic-noop"],
      env,
    );
    expect(config.workerRunId).toBe(WORKER_RUN_ID);
    expect(config.executionMode).toBe("synthetic-noop");
    expect(config.ownerId).toBe("github-actions.ACD052709.assayer-autodev.99.1");
    expect(config.heartbeatIntervalMs).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(config.heartbeatIntervalMs).toBeLessThan(DEFAULT_LEASE_DURATION_MS);
  });

  it("rejects unsupported executionMode", () => {
    expect(() =>
      parseActuatorCli(["--worker-run-id", WORKER_RUN_ID, "--execution-mode", "cursor-acp"], env),
    ).toThrow(/Unsupported --execution-mode/);
  });

  it("rejects arbitrary command input", () => {
    expect(() =>
      parseActuatorCli(
        ["--worker-run-id", WORKER_RUN_ID, "--execution-mode", "synthetic-noop", "--command", "rm -rf /"],
        env,
      ),
    ).toThrow(/Unsupported CLI arguments/);
  });
});

describe("runSyntheticNoop", () => {
  it("does not modify repositories and returns the structured noop outcome", async () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/actuator/synthetic-noop.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/child_process|git clone|writeFile|unlink/);
    const outcome = await runSyntheticNoop({
      workerRunId: WORKER_RUN_ID,
      durationMs: 0,
      sleep: async () => undefined,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      kind: SYNTHETIC_NOOP_KIND,
      externalRepositoryModified: false,
      codingAgentUsed: false,
    });
    expect(typeof outcome.checksum).toBe("number");
  });
});

describe("runActuator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims once with the generated ownerId, heartbeats during work, then succeeds once", async () => {
    const { client, calls } = createRecordingClient();
    const captured = capturingLogger();
    const pending = runActuator({
      config: baseConfig,
      client,
      logger: captured.logger,
      timers: fakeTimers(),
      sleep: abortableSleep,
    });
    await vi.advanceTimersByTimeAsync(baseConfig.syntheticNoopDurationMs + baseConfig.heartbeatIntervalMs);
    const result = await pending;
    expect(result).toEqual({ ok: true, exitCode: 0, reason: "succeeded" });
    expect(calls.filter((call) => call.op === "claim")).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      op: "claim",
      workerRunId: WORKER_RUN_ID,
      ownerId: baseConfig.ownerId,
    });
    expect(calls.filter((call) => call.op === "heartbeat").length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((call) => call.op === "succeed")).toHaveLength(1);
    expect(calls.filter((call) => call.op === "fail")).toHaveLength(0);
    const succeed = calls.find((call) => call.op === "succeed") as {
      leaseToken: string;
      input: { structuredOutcome: { externalRepositoryModified: boolean } };
    };
    expect(succeed.leaseToken).toBe(LEASE_TOKEN);
    expect(succeed.input.structuredOutcome.externalRepositoryModified).toBe(false);
    const joined = captured.lines.join("\n");
    expect(joined).not.toContain(LEASE_TOKEN);
    expect(joined).not.toContain(SERVICE_TOKEN);
  });

  it("stops heartbeats after success", async () => {
    const { client, calls } = createRecordingClient();
    const pending = runActuator({
      config: baseConfig,
      client,
      logger: capturingLogger().logger,
      timers: fakeTimers(),
      sleep: abortableSleep,
    });
    await vi.advanceTimersByTimeAsync(baseConfig.syntheticNoopDurationMs + 50);
    await pending;
    const heartbeatsAtSuccess = calls.filter((call) => call.op === "heartbeat").length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.filter((call) => call.op === "heartbeat")).toHaveLength(heartbeatsAtSuccess);
    expect(calls.filter((call) => call.op === "succeed")).toHaveLength(1);
  });

  it("does not perform work when claim fails", async () => {
    const { client, calls } = createRecordingClient({
      claimError: new ActuatorError("conflict", "already claimed"),
    });
    const captured = capturingLogger();
    const result = await runActuator({
      config: baseConfig,
      client,
      logger: captured.logger,
      timers: fakeTimers(),
      sleep: abortableSleep,
    });
    expect(result.reason).toBe("claim_failed");
    expect(calls.filter((call) => call.op === "claim")).toHaveLength(1);
    expect(calls.filter((call) => call.op === "heartbeat")).toHaveLength(0);
    expect(calls.filter((call) => call.op === "succeed")).toHaveLength(0);
    expect(captured.lines.join("\n")).not.toContain(SERVICE_TOKEN);
  });

  it("stops work on expired heartbeat and does not send terminal fail", async () => {
    const { client, calls } = createRecordingClient({
      heartbeatError: new ActuatorError("expired", "Worker-run lease has expired", {
        status: 409,
        ownershipLost: true,
      }),
    });
    const pending = runActuator({
      config: { ...baseConfig, syntheticNoopDurationMs: 1_000 },
      client,
      logger: capturingLogger().logger,
      timers: fakeTimers(),
      sleep: abortableSleep,
    });
    await vi.advanceTimersByTimeAsync(baseConfig.heartbeatIntervalMs);
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.reason).toBe("ownership_lost");
    expect(calls.filter((call) => call.op === "fail")).toHaveLength(0);
    expect(calls.filter((call) => call.op === "succeed")).toHaveLength(0);
  });

  it("reports work failure once with the lease token but does not log it", async () => {
    const { client, calls } = createRecordingClient();
    const captured = capturingLogger();
    const pending = runActuator({
      config: baseConfig,
      client,
      logger: captured.logger,
      timers: fakeTimers(),
      sleep: async (_ms, signal) => {
        if (signal?.aborted) {
          throw new ActuatorError("ABORTED", "Aborted");
        }
        throw new Error("synthetic boom");
      },
    });
    const result = await pending;
    expect(result.reason).toBe("failed");
    expect(calls.filter((call) => call.op === "fail")).toHaveLength(1);
    expect(calls.filter((call) => call.op === "succeed")).toHaveLength(0);
    const fail = calls.find((call) => call.op === "fail") as {
      leaseToken: string;
      input: { errorCode: string; summary: string };
    };
    expect(fail.leaseToken).toBe(LEASE_TOKEN);
    expect(fail.input.errorCode).toBe("SYNTHETIC_NOOP_FAILED");
    expect(fail.input.summary).not.toContain(LEASE_TOKEN);
    expect(fail.input.summary).not.toContain(SERVICE_TOKEN);
    expect(captured.lines.join("\n")).not.toContain(LEASE_TOKEN);
    expect(captured.lines.join("\n")).not.toContain(SERVICE_TOKEN);
  });

  it("rejects unsupported executionMode before claiming", async () => {
    const { client, calls } = createRecordingClient();
    const result = await runActuator({
      config: { ...baseConfig, executionMode: "not-a-mode" as ActuatorConfig["executionMode"] },
      client,
      logger: capturingLogger().logger,
      timers: fakeTimers(),
      sleep: abortableSleep,
    });
    expect(result.reason).toBe("unsupported_mode");
    expect(calls).toHaveLength(0);
  });
});

describe("createControlPlaneClient", () => {
  it("sends JSON-serialized claim and never puts secrets in thrown errors", async () => {
    const fetches: { url: string; body: string; authorization: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      fetches.push({
        url,
        body: String(init?.body ?? ""),
        authorization: headers.get("authorization") ?? "",
      });
      return new Response(
        JSON.stringify({
          claimed: true,
          leaseToken: LEASE_TOKEN,
          workerRun: { id: WORKER_RUN_ID, status: "running" },
          task: { id: "task-1", status: "in_progress" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = createControlPlaneClient({
      controlPlaneUrl: "https://example.test/",
      serviceToken: SERVICE_TOKEN,
      fetchImpl,
    });
    const claimed = await client.claim(WORKER_RUN_ID, "owner-1");
    expect(claimed.leaseToken).toBe(LEASE_TOKEN);
    expect(JSON.parse(fetches[0]!.body)).toEqual({ ownerId: "owner-1" });
    expect(fetches[0]!.url).toBe(`https://example.test/api/worker-runs/${WORKER_RUN_ID}/claim`);
  });

  it("marks expired heartbeat as ownership lost without echoing the lease token", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { code: "conflict", message: `expired ${LEASE_TOKEN}` } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    const client = createControlPlaneClient({
      controlPlaneUrl: "https://example.test",
      serviceToken: SERVICE_TOKEN,
      fetchImpl,
    });
    await expect(client.heartbeat(WORKER_RUN_ID, LEASE_TOKEN)).rejects.toMatchObject({
      ownershipLost: true,
      message: expect.not.stringContaining(LEASE_TOKEN),
    });
  });
});

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildCodingTaskPrompt } from "../src/actuator/coding-task-prompt.js";
import { runCodingTask } from "../src/actuator/coding-task.js";
import {
  buildCloneUrl,
  prepareIsolatedCheckout,
  summarizeCheckoutChangesFromStatus,
} from "../src/actuator/coding-task-checkout.js";
import {
  buildCursorCliInvocation,
  CURSOR_CLI_COMMAND,
  isolatedCheckoutDirectory,
  parseTrustedTestCommand,
} from "../src/actuator/cursor-cli.js";
import { runActuator } from "../src/actuator/executor.js";
import type { ControlPlaneClient } from "../src/actuator/types.js";
import { CODING_TASK_KIND } from "../src/actuator/types.js";
import type { WorkerTaskPacket } from "../src/domain/worker-task-packet.js";

const LEASE_TOKEN = "b".repeat(64);
const API_KEY = "cursor-api-key-placeholder-not-a-real-secret";
const WORKER_RUN_ID = "wrun-coding-task-test";

function samplePacket(overrides?: Partial<WorkerTaskPacket>): WorkerTaskPacket {
  return {
    workerRunId: WORKER_RUN_ID,
    taskId: "task-coding",
    projectId: "proj-coding",
    task: {
      id: "task-coding",
      title: "Add feature",
      description: "Implement bounded slice",
      kind: "implementation",
      status: "in_progress",
    },
    requirements: [
      {
        id: "req-1",
        projectId: "proj-coding",
        title: "Req",
        description: "Must work",
        priority: 1,
        status: "approved",
        statusChangedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    acceptanceCriteria: [
      {
        id: "ac-1",
        projectId: "proj-coding",
        releaseContractId: "rc-1",
        description: "Tests pass",
        requirementIds: ["req-1"],
        applicable: true,
        evidenceIds: [],
        status: "pending",
        statusChangedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    blockers: [],
    doNotModifyConstraints: ["production/**"],
    targetRepository: "ACD052709/example-target",
    targetRef: "main",
    targetTestCommand: "npm test",
    execution: { workerKind: "generic", iteration: 1, status: "running", ownerId: "owner-1" },
    ...overrides,
  };
}

describe("coding-task prompt and cursor cli", () => {
  it("builds a bounded prompt without secrets", () => {
    const prompt = buildCodingTaskPrompt(samplePacket());
    expect(prompt).toContain("Add feature");
    expect(prompt).toContain("Must work");
    expect(prompt).toContain("Tests pass");
    expect(prompt).toContain("production/**");
    expect(prompt).not.toContain(API_KEY);
    expect(prompt).not.toContain(LEASE_TOKEN);
  });

  it("constructs non-interactive Cursor CLI invocation", () => {
    const checkoutDir = isolatedCheckoutDirectory("/tmp/work", WORKER_RUN_ID);
    const invocation = buildCursorCliInvocation({
      workspaceDir: checkoutDir,
      prompt: "do work",
      timeoutMs: 120_000,
    });
    expect(invocation.command).toBe(CURSOR_CLI_COMMAND);
    expect(invocation.args).toEqual([
      "--print",
      "--output-format",
      "text",
      "--force",
      "--model",
      "auto",
      "--workspace",
      checkoutDir,
      "do work",
    ]);
    expect(invocation.requiredEnvKeys).toEqual(["CURSOR_API_KEY"]);
    expect(invocation.cwd).toBe(checkoutDir);
    expect(invocation.timeoutMs).toBe(120_000);
  });
});

describe("coding-task checkout and tests", () => {
  it("uses an isolated run-scoped checkout path", () => {
    expect(isolatedCheckoutDirectory("/tmp/autodev-workspaces", WORKER_RUN_ID)).toBe(
      join("/tmp/autodev-workspaces", WORKER_RUN_ID, "target"),
    );
    expect(buildCloneUrl("owner/repo")).toBe("https://github.com/owner/repo.git");
  });

  it("clones using packet repository and ref only", async () => {
    const calls: string[][] = [];
    const packet = samplePacket();
    const expectedCheckout = isolatedCheckoutDirectory("/tmp/work", WORKER_RUN_ID);
    await prepareIsolatedCheckout({
      packet,
      workspaceRoot: "/tmp/work",
      git: {
        async run(args) {
          calls.push([...args]);
          return 0;
        },
      },
    });
    expect(calls[0]).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      "https://github.com/ACD052709/example-target.git",
      expectedCheckout,
    ]);
  });

  it("parses trusted test commands without shell interpolation", () => {
    expect(parseTrustedTestCommand("npm test")).toEqual({ command: "npm", args: ["test"] });
  });

  it("summarizes changed files from git status output", async () => {
    const statusOutput = [" M src/a.ts", "?? src/b.ts"].join("\n") + "\n";
    const summary = await summarizeCheckoutChangesFromStatus(statusOutput);
    expect(summary.changedFileCount).toBe(2);
    expect(summary.changedFileSummary).toContain("src/a.ts");
  });
});

describe("runCodingTask", () => {
  it("fails safely when CURSOR_API_KEY is missing", async () => {
    const client: ControlPlaneClient = {
      claim: vi.fn(),
      heartbeat: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      getTaskPacket: async () => samplePacket(),
      createCodeCandidate: async (input) => ({ id: input.id }),
    };
    const result = await runCodingTask({
      workerRunId: WORKER_RUN_ID,
      leaseToken: LEASE_TOKEN,
      workspaceRoot: "/tmp/work",
      codingTaskTimeoutMs: 5_000,
      client,
      process: { run: vi.fn() },
      git: { run: vi.fn() },
      gitStatus: { readPorcelain: vi.fn() },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("CURSOR_API_KEY_MISSING");
    expect(result.structuredOutcome.codingAgentUsed).toBe(true);
    expect(result.structuredOutcome.agentExitCode).toBe(-1);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("runs agent then trusted tests without live Cursor dependency", async () => {
    const processCalls: { command: string; args: string[]; cwd: string }[] = [];
    const expectedCheckout = isolatedCheckoutDirectory("/tmp/work", WORKER_RUN_ID);
    const client: ControlPlaneClient = {
      claim: vi.fn(),
      heartbeat: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      getTaskPacket: async () => samplePacket(),
      createCodeCandidate: async (input) => ({ id: input.id }),
    };
    const result = await runCodingTask({
      workerRunId: WORKER_RUN_ID,
      leaseToken: LEASE_TOKEN,
      workspaceRoot: "/tmp/work",
      cursorApiKey: API_KEY,
      codingTaskTimeoutMs: 5_000,
      client,
      git: {
        async run(args) {
          expect(args[0]).toBe("clone");
          return 0;
        },
      },
      gitStatus: {
        async readPorcelain() {
          return " M README.md\n";
        },
      },
      gitCapture: {
        async readRevParse() { return "a".repeat(40); },
        async stageAll() {},
        async readUnifiedDiff() { return "diff --git a/README.md b/README.md\n"; },
        async readChangedPaths() { return ["README.md"]; },
      },
      process: {
        async run(input) {
          processCalls.push({ command: input.command, args: [...input.args], cwd: input.cwd });
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
      now: () => 0,
    });
    expect(processCalls[0]!.command).toBe(CURSOR_CLI_COMMAND);
    expect(processCalls[0]!.cwd).toBe(expectedCheckout);
    expect(processCalls[1]).toEqual({
      command: "npm",
      args: ["test"],
      cwd: expectedCheckout,
    });
    expect(result.ok).toBe(true);
    expect(result.structuredOutcome.kind).toBe(CODING_TASK_KIND);
    expect(result.structuredOutcome.externalRepositoryModified).toBe(true);
    expect(result.structuredOutcome.testExitCode).toBe(0);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain(LEASE_TOKEN);
  });
});

describe("runActuator coding-task integration", () => {
  it("keeps heartbeats active during coding-task execution", async () => {
    const heartbeats: number[] = [];
    let resolveCoding: (() => void) | undefined;
    const codingDone = new Promise<void>((resolve) => {
      resolveCoding = resolve;
    });
    const client: ControlPlaneClient = {
      async claim() {
        return {
          claimed: true,
          leaseToken: LEASE_TOKEN,
          workerRun: { id: WORKER_RUN_ID, status: "running" },
          task: { id: "task-coding", status: "in_progress" },
        };
      },
      async heartbeat() {
        heartbeats.push(Date.now());
        return { workerRun: { id: WORKER_RUN_ID, status: "running" } };
      },
      async succeed() {
        return {
          workerRun: { id: WORKER_RUN_ID, status: "succeeded" },
          task: { id: "task-coding", status: "awaiting_verification" },
          applied: true,
        };
      },
      async fail() {
        return {
          workerRun: { id: WORKER_RUN_ID, status: "failed" },
          task: { id: "task-coding", status: "failed" },
          applied: true,
        };
      },
      getTaskPacket: async () => samplePacket(),
      createCodeCandidate: async (input) => ({ id: input.id }),
    };

    const actuatorPromise = runActuator({
      config: {
        workerRunId: WORKER_RUN_ID,
        controlPlaneUrl: "https://example.test",
        serviceToken: "service-token-value-abcdefghijklmnopqrstuvwxyz",
        ownerId: "owner-1",
        executionMode: "coding-task",
        heartbeatIntervalMs: 20,
        heartbeatFailureLimit: 2,
        syntheticNoopDurationMs: 250,
        workspaceRoot: "/tmp/work",
        codingTaskTimeoutMs: 5_000,
        cursorApiKey: API_KEY,
      },
      client,
      timers: {
        setInterval(handler, ms) {
          return setInterval(handler, ms);
        },
        clearInterval(id) {
          clearInterval(id as ReturnType<typeof setInterval>);
        },
      },
      processRunner: {
        async run(input) {
          if (input.command === CURSOR_CLI_COMMAND) {
            await codingDone;
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
      gitRunner: { run: async () => 0 },
      gitStatusReader: { readPorcelain: async () => "" },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heartbeats.length).toBeGreaterThan(0);
    resolveCoding?.();
    const result = await actuatorPromise;
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("succeeded");
  });
});

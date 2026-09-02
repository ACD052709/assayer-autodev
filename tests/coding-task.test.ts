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
  buildCodexCliInvocation,
  CODEX_CLI_COMMAND,
  isolatedCheckoutDirectory,
  parseCodexUsage,
  parseTrustedTestCommand,
} from "../src/actuator/codex-cli.js";
import { runActuator } from "../src/actuator/executor.js";
import type { BudgetResourceSnapshot, ControlPlaneClient } from "../src/actuator/types.js";
import { CODING_TASK_KIND } from "../src/actuator/types.js";
import type { WorkerTaskPacket } from "../src/domain/worker-task-packet.js";

const LEASE_TOKEN = "b".repeat(64);
const API_KEY = "openai-api-key-placeholder-not-a-real-secret";
const WORKER_RUN_ID = "wrun-coding-task-test";
const CODEX_USAGE_JSONL = `${JSON.stringify({
  type: "turn.completed",
  usage: {
    input_tokens: 1000,
    cached_input_tokens: 500,
    cache_write_input_tokens: 100,
    output_tokens: 100,
    reasoning_output_tokens: 20,
  },
})}\n`;

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

function codingBudget(remaining = 10): BudgetResourceSnapshot {
  return {
    resourceType: "llm_cost_usd",
    unit: "usd",
    hardLimit: 10,
    consumedAmount: 10 - remaining,
    remainingHardLimit: remaining,
  };
}

function baseClient(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    claim: vi.fn(),
    heartbeat: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    getTaskPacket: async () => samplePacket(),
    getBudget: async () => codingBudget(),
    recordBudgetEntry: vi.fn(async () => undefined),
    createCodeCandidate: async (input) => ({ id: input.id }),
    ...overrides,
  };
}

describe("coding-task prompt and Codex CLI", () => {
  it("builds a bounded prompt without secrets", () => {
    const prompt = buildCodingTaskPrompt(samplePacket());
    expect(prompt).toContain("Add feature");
    expect(prompt).toContain("Must work");
    expect(prompt).toContain("Tests pass");
    expect(prompt).toContain("production/**");
    expect(prompt).toContain("provided workspace checkout is the authorized target repository");
    expect(prompt).toContain("ACD052709/example-target");
    expect(prompt).toContain("You may run the exact trusted repository test command locally while developing (npm test)");
    expect(prompt).toContain("You may rerun that exact local test as needed");
    expect(prompt).toContain("The trusted host will independently rerun the test after you exit");
    expect(prompt).not.toContain("Do not run the trusted repository test/build command yourself");
    expect(prompt).not.toContain("Do not modify assayer-autodev");
    expect(prompt).toContain("Prefer the smallest patch");
    expect(prompt).toContain("Once the bounded implementation is complete, stop");
    expect(prompt.indexOf("Do-not-modify constraints (authoritative):")).toBeLessThan(prompt.indexOf("Approved requirements:"));
    expect(prompt).not.toContain(API_KEY);
    expect(prompt).not.toContain(LEASE_TOKEN);
  });

  it("constructs a deterministic non-interactive Codex invocation", () => {
    const checkoutDir = isolatedCheckoutDirectory("/tmp/work", WORKER_RUN_ID);
    const invocation = buildCodexCliInvocation({
      workspaceDir: checkoutDir,
      prompt: "do work",
      timeoutMs: 120_000,
    });
    expect(invocation.command).toBe(CODEX_CLI_COMMAND);
    expect(invocation.args).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--ephemeral",
      "--json",
      "-c",
      "default_permissions=\":workspace\"",
      "--ignore-user-config",
      "--ignore-rules",
      "--disable",
      "code_mode",
      "--disable",
      "code_mode_host",
      "--disable",
      "multi_agent",
      "--disable",
      "multi_agent_v2",
      "--disable",
      "fast_mode",
      "--model",
      "gpt-5.6-luna",
      "-c",
      'model_reasoning_effort="low"',
      "-c",
      'service_tier="default"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      "shell_environment_policy.ignore_default_excludes=false",
      "-c",
      'shell_environment_policy.inherit="core"',
      "do work",
    ]);
    expect(invocation.requiredEnvKeys).toEqual(["CODEX_API_KEY"]);
    expect(invocation.cwd).toBe(checkoutDir);
    expect(invocation.timeoutMs).toBe(120_000);
  });

  it("parses machine-readable Codex usage", () => {
    expect(parseCodexUsage(CODEX_USAGE_JSONL)).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 500,
      cacheWriteInputTokens: 100,
      outputTokens: 100,
      reasoningOutputTokens: 20,
    });
    expect(parseCodexUsage("not-json\n")).toBeUndefined();
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

  it("uses a private-repo read token only in ephemeral git auth configuration", async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const token = "private-repo-token-placeholder";
    await prepareIsolatedCheckout({
      packet: samplePacket(),
      workspaceRoot: "/tmp/work",
      targetRepoReadToken: token,
      git: {
        async run(args, _cwd, env) {
          calls.push({ args: [...args], ...(env !== undefined ? { env } : {}) });
          return 0;
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.join(" ")).not.toContain(token);
    expect(calls[0]!.args.join(" ")).toContain("https://github.com/ACD052709/example-target.git");
    expect(calls[0]!.env?.GIT_CONFIG_KEY_0).toContain("extraheader");
    expect(calls[0]!.env?.GIT_CONFIG_VALUE_0).not.toContain(token);
    expect(calls[0]!.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("parses trusted test commands without shell interpolation", () => {
    expect(parseTrustedTestCommand("npm test")).toEqual({ command: "npm", args: ["test"] });
  });

  it("summarizes changed files from git status output", async () => {
    const summary = await summarizeCheckoutChangesFromStatus(" M src/a.ts\n?? src/b.ts\n");
    expect(summary.changedFileCount).toBe(2);
    expect(summary.changedFileSummary).toContain("src/a.ts");
  });
});

describe("runCodingTask", () => {
  it("fails safely when OPENAI_API_KEY is missing", async () => {
    const result = await runCodingTask({
      workerRunId: WORKER_RUN_ID,
      leaseToken: LEASE_TOKEN,
      workspaceRoot: "/tmp/work",
      codingTaskTimeoutMs: 5_000,
      client: baseClient(),
      process: { run: vi.fn() },
      git: { run: vi.fn() },
      gitStatus: { readPorcelain: vi.fn() },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("OPENAI_API_KEY_MISSING");
        expect(result.structuredOutcome.agentExitCode).toBe(-1);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("pauses before paid work when coding budget is unavailable", async () => {
    const processRun = vi.fn();
    const result = await runCodingTask({
      workerRunId: WORKER_RUN_ID,
      leaseToken: LEASE_TOKEN,
      workspaceRoot: "/tmp/work",
      openaiApiKey: API_KEY,
      codingTaskTimeoutMs: 5_000,
      client: baseClient({ getBudget: async () => undefined }),
      process: { run: processRun },
      git: { run: vi.fn() },
      gitStatus: { readPorcelain: vi.fn() },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("CODING_BUDGET_REQUIRED");
    expect(processRun).not.toHaveBeenCalled();
  });

  it("includes bounded trusted-test output in repository-test failures", async () => {
    const result = await runCodingTask({
      workerRunId: WORKER_RUN_ID,
      leaseToken: LEASE_TOKEN,
      workspaceRoot: "/tmp/work",
      openaiApiKey: API_KEY,
      codingTaskTimeoutMs: 5_000,
      client: baseClient(),
      git: { run: async () => 0 },
      gitStatus: { readPorcelain: async () => " M math.js\n" },
      process: {
        async run(input) {
          if (input.command === CODEX_CLI_COMMAND) {
            return {
              exitCode: 0,
              stdout: CODEX_USAGE_JSONL,
              stderr: "",
              timedOut: false,
            };
          }

          return {
            exitCode: 1,
            stdout: "TAP version 13\nnot ok 1 - add correctly adds two numbers\nexpected 5 but received -1\n",
            stderr: "AssertionError: -1 !== 5\n",
            timedOut: false,
          };
        },
      },
      now: () => 0,
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("REPOSITORY_TESTS_FAILED");
    expect(result.summary).toContain("Trusted repository tests failed (exit 1)");
    expect(result.summary).toContain("AssertionError: -1 !== 5");
    expect(result.summary).toContain("expected 5 but received -1");
    expect(result.summary).toContain("agentExitCode=0");
    expect(result.summary).toContain("agentTimedOut=false");
    expect(result.summary).toContain("testExitCode=1");
    expect(result.summary).toContain("changedFileCount=1");
    expect(result.summary).toContain("changedFiles=math.js");
    expect(result.structuredOutcome.testExitCode).toBe(1);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain(LEASE_TOKEN);
  });

  it("runs Codex then trusted tests and records exact model usage cost", async () => {
    const processCalls: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
    const expectedCheckout = isolatedCheckoutDirectory("/tmp/work", WORKER_RUN_ID);
    const recordBudgetEntry = vi.fn(async () => undefined);
    const client = baseClient({ recordBudgetEntry });
    const result = await runCodingTask({
      workerRunId: WORKER_RUN_ID,
      leaseToken: LEASE_TOKEN,
      workspaceRoot: "/tmp/work",
      openaiApiKey: API_KEY,
      codingTaskTimeoutMs: 5_000,
      client,
      git: {
        async run(args) {
          expect(args[0]).toBe("clone");
          return 0;
        },
      },
      gitStatus: { readPorcelain: async () => " M README.md\n" },
      gitCapture: {
        async readRevParse() { return "a".repeat(40); },
        async stageAll() {},
        async readUnifiedDiff() { return "diff --git a/README.md b/README.md\n"; },
        async readChangedPaths() { return ["README.md"]; },
      },
      process: {
        async run(input) {
          processCalls.push({ command: input.command, args: [...input.args], cwd: input.cwd, ...(input.env !== undefined ? { env: input.env } : {}) });
          if (input.command === CODEX_CLI_COMMAND) {
            expect(input.env?.CODEX_API_KEY).toBe(API_KEY);
            expect(input.env?.OPENAI_API_KEY).toBeUndefined();
            expect(input.env?.AUTODEV_SERVICE_TOKEN).toBeUndefined();
            return { exitCode: 0, stdout: CODEX_USAGE_JSONL, stderr: "", timedOut: false };
          }
          expect(input.env?.CODEX_API_KEY).toBeUndefined();
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
      now: () => 0,
    });
    expect(processCalls[0]!.command).toBe(CODEX_CLI_COMMAND);
    expect(processCalls[0]!.cwd).toBe(expectedCheckout);
    expect(processCalls[1]!.command).toBe("npm");
    expect(processCalls[1]!.args).toEqual(["test"]);
    expect(processCalls[1]!.cwd).toBe(expectedCheckout);
    expect(result.ok).toBe(true);
    expect(result.structuredOutcome.kind).toBe(CODING_TASK_KIND);
    expect(result.structuredOutcome.codingAgent).toBe("codex");
    expect(result.structuredOutcome.codingModel).toBe("gpt-5.6-luna");
    expect(result.structuredOutcome.changedFileCount).toBe(1);
    expect(result.structuredOutcome.testExitCode).toBe(0);
    expect(result.structuredOutcome.estimatedCostUsd).toBeGreaterThan(0);
    expect(recordBudgetEntry).toHaveBeenCalledTimes(1);
    const recordedEntry = (recordBudgetEntry.mock.calls as unknown as readonly [readonly [Record<string, unknown>]])[0]![0];
    expect(recordedEntry).toMatchObject({
      projectId: "proj-coding",
      resourceType: "llm_cost_usd",
      unit: "usd",
      workerRunId: WORKER_RUN_ID,
      description: "codex:gpt-5.6-luna",
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain(LEASE_TOKEN);
    expect(Object.keys(result.structuredOutcome)).toHaveLength(16);
  });

  it("preserves a passing candidate when Codex exits non-zero after editing", async () => {
    const createCodeCandidate = vi.fn(async (input: Parameters<ControlPlaneClient["createCodeCandidate"]>[0]) => ({ id: input.id }));
    const result = await runCodingTask({
      workerRunId: WORKER_RUN_ID,
      leaseToken: LEASE_TOKEN,
      workspaceRoot: "/tmp/work",
      openaiApiKey: API_KEY,
      codingTaskTimeoutMs: 5_000,
      client: baseClient({ createCodeCandidate }),
      git: { run: async () => 0 },
      gitStatus: { readPorcelain: async () => " M math.js\n" },
      gitCapture: {
        async readRevParse() { return "b".repeat(40); },
        async stageAll() {},
        async readUnifiedDiff() { return "diff --git a/math.js b/math.js\n"; },
        async readChangedPaths() { return ["math.js"]; },
      },
      process: {
        async run(input) {
          if (input.command === CODEX_CLI_COMMAND) {
            return { exitCode: 7, stdout: CODEX_USAGE_JSONL, stderr: "agent ended", timedOut: false };
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
      now: () => 0,
    });
    expect(result.ok).toBe(true);
    expect(result.structuredOutcome.agentExitCode).toBe(7);
    expect(result.structuredOutcome.testExitCode).toBe(0);
    expect(result.structuredOutcome.failureReason).toContain("candidate preserved");
    expect(createCodeCandidate).toHaveBeenCalledTimes(1);
  });

  it("charges the reservation conservatively when Codex usage is missing", async () => {
    const recordBudgetEntry = vi.fn(async () => undefined);
    const result = await runCodingTask({
      workerRunId: WORKER_RUN_ID,
      leaseToken: LEASE_TOKEN,
      workspaceRoot: "/tmp/work",
      openaiApiKey: API_KEY,
      codingTaskTimeoutMs: 5_000,
      client: baseClient({ recordBudgetEntry }),
      git: { run: async () => 0 },
      gitStatus: { readPorcelain: async () => " M math.js\n" },
      gitCapture: {
        async readRevParse() { return "c".repeat(40); },
        async stageAll() {},
        async readUnifiedDiff() { return "diff --git a/math.js b/math.js\n"; },
        async readChangedPaths() { return ["math.js"]; },
      },
      process: {
        async run(input) {
          if (input.command === CODEX_CLI_COMMAND) {
            return { exitCode: 0, stdout: "missing terminal usage event\n", stderr: "", timedOut: false };
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
      now: () => 0,
    });
    expect(result.ok).toBe(true);
    expect(result.structuredOutcome.usageAccountingEstimated).toBe(true);
    expect(result.structuredOutcome.estimatedCostUsd).toBe(0.25);
    const entry = (recordBudgetEntry.mock.calls as unknown as readonly [readonly [Record<string, unknown>]])[0]![0];
    expect(entry).toMatchObject({ amount: 0.25, description: "codex:gpt-5.6-luna:estimated" });
  });

  it("never exposes the Codex key to repository-controlled tests", async () => {
    const testEnvs: NodeJS.ProcessEnv[] = [];
    const result = await runCodingTask({
      workerRunId: WORKER_RUN_ID,
      leaseToken: LEASE_TOKEN,
      workspaceRoot: "/tmp/work",
      openaiApiKey: API_KEY,
      codingTaskTimeoutMs: 5_000,
      client: baseClient(),
      git: { run: async () => 0 },
      gitStatus: { readPorcelain: async () => " M math.js\n" },
      gitCapture: {
        async readRevParse() { return "d".repeat(40); },
        async stageAll() {},
        async readUnifiedDiff() { return "diff --git a/math.js b/math.js\n"; },
        async readChangedPaths() { return ["math.js"]; },
      },
      process: {
        async run(input) {
          if (input.command === CODEX_CLI_COMMAND) {
            expect(input.env?.CODEX_API_KEY).toBe(API_KEY);
            return { exitCode: 0, stdout: CODEX_USAGE_JSONL, stderr: "", timedOut: false };
          }
          testEnvs.push(input.env ?? {});
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
      now: () => 0,
    });
    expect(result.ok).toBe(true);
    expect(testEnvs).toHaveLength(1);
    expect(testEnvs[0]?.CODEX_API_KEY).toBeUndefined();
    expect(testEnvs[0]?.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });
});

describe("runActuator coding-task integration", () => {
  it("keeps heartbeats active during Codex execution", async () => {
    const heartbeats: number[] = [];
    let resolveCoding: (() => void) | undefined;
    const codingDone = new Promise<void>((resolve) => { resolveCoding = resolve; });
    const client = baseClient({
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
    });

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
        openaiApiKey: API_KEY,
      },
      client,
      timers: {
        setInterval(handler, ms) { return setInterval(handler, ms); },
        clearInterval(id) { clearInterval(id as ReturnType<typeof setInterval>); },
      },
      processRunner: {
        async run(input) {
          if (input.command === CODEX_CLI_COMMAND) {
            await codingDone;
            return { exitCode: 0, stdout: CODEX_USAGE_JSONL, stderr: "", timedOut: false };
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
      gitRunner: { run: async () => 0 },
      gitStatusReader: { readPorcelain: async () => " M math.js\n" },
      gitCaptureReader: {
        async readRevParse() { return "e".repeat(40); },
        async stageAll() {},
        async readUnifiedDiff() { return "diff --git a/math.js b/math.js\n"; },
        async readChangedPaths() { return ["math.js"]; },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heartbeats.length).toBeGreaterThan(0);
    resolveCoding?.();
    const result = await actuatorPromise;
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("succeeded");
  });
});

describe("coding-task trusted-test repair loop", () => {
  it("repairs once after trusted host test failure and reruns the trusted test", async () => {
    let codexCalls = 0;
    let trustedTestCalls = 0;
    const budgetEntries: Array<{ id: string; amount: number; description?: string }> = [];
    const createdCandidates: unknown[] = [];

    const result = await runCodingTask({
      workerRunId: "wrun-iterative-repair-test",
      leaseToken: "b".repeat(64),
      workspaceRoot: "/tmp/work",
      openaiApiKey: API_KEY,
      codingTaskTimeoutMs: 5_000,

      client: baseClient({
        getTaskPacket: async () =>
          samplePacket({
            targetRepository: "ACD052709/assayer-autodev-coding-smoke",
            targetRef: "main",
            targetTestCommand: "node --test math.test.js",
          }),

        recordBudgetEntry: async (entry) => {
          budgetEntries.push({
            id: entry.id,
            amount: entry.amount,
            ...(entry.description !== undefined
              ? { description: entry.description }
              : {}),
          });
        },

        createCodeCandidate: async (candidate) => {
          createdCandidates.push(candidate);
          return { id: candidate.id };
        },
      }),

      git: {
        run: async () => 0,
      },

      gitStatus: {
        readPorcelain: async () => " M math.js\n",
      },

      gitCapture: {
        async readRevParse() {
          return "f".repeat(40);
        },
        async stageAll() {},
        async readUnifiedDiff() {
          return [
            "diff --git a/math.js b/math.js",
            "--- a/math.js",
            "+++ b/math.js",
            "@@ -1 +1 @@",
            "-module.exports = { add: (a, b) => a - b };",
            "+module.exports = { add: (a, b) => a + b };",
            "",
          ].join("\n");
        },
        async readChangedPaths() {
          return ["math.js"];
        },
      },

      process: {
        async run(input) {
          if (input.command === CODEX_CLI_COMMAND) {
            codexCalls += 1;

            return {
              exitCode: 0,
              stdout: CODEX_USAGE_JSONL,
              stderr: "",
              timedOut: false,
            };
          }

          trustedTestCalls += 1;

          if (trustedTestCalls === 1) {
            return {
              exitCode: 1,
              stdout:
                "AssertionError: Expected values to be strictly equal: -1 !== 5",
              stderr: "",
              timedOut: false,
            };
          }

          return {
            exitCode: 0,
            stdout: "1..1\n# pass 1\n# fail 0",
            stderr: "",
            timedOut: false,
          };
        },
      },

      now: () => 0,
    });

    expect(codexCalls).toBe(2);
    expect(trustedTestCalls).toBe(2);

    expect(result.ok).toBe(true);
    expect(result.structuredOutcome.testExitCode).toBe(0);
    expect(result.structuredOutcome.changedFileCount).toBe(1);

    expect(budgetEntries).toHaveLength(2);
    expect(
      budgetEntries.some((entry) =>
        entry.description?.includes(":repair"),
      ),
    ).toBe(true);

    expect(createdCandidates).toHaveLength(1);
  });
});

/**
 * GitHub Actions worker actuator types and constants.
 *
 * After dispatch assigns a queued worker_run, an optional control-plane launch bridge
 * invokes GitHub workflow_dispatch (see dispatch/github-launch-bridge.ts).
 */
export const DISPATCH_LAUNCH_BRIDGE_STATUS = "github_workflow_dispatch_optional" as const;

export const EXECUTION_MODES = ["synthetic-noop", "coding-task"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function isExecutionMode(value: string): value is ExecutionMode {
  return (EXECUTION_MODES as readonly string[]).includes(value);
}

/** Must stay safely below the control-plane lease (120s). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Consecutive non-ownership heartbeat failures before fail-closed. */
export const DEFAULT_HEARTBEAT_FAILURE_LIMIT = 2;

/** Default bounded Cursor CLI runtime for coding-task (below typical GHA job timeout). */
export const DEFAULT_CODING_TASK_TIMEOUT_MS = 600_000;

export const DEFAULT_WORKSPACE_ROOT = "/tmp/autodev-workspaces";

export const CODING_TASK_KIND = "github_actions_coding_task";

/** Short synthetic wait; tests inject a shorter value with fake timers. */
export const DEFAULT_SYNTHETIC_NOOP_DURATION_MS = 2_000;

export const OWNER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export const WORKER_RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export interface GitHubOwnerIdentity {
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: string;
}

export interface ActuatorConfig {
  readonly workerRunId: string;
  readonly controlPlaneUrl: string;
  readonly serviceToken: string;
  readonly ownerId: string;
  readonly executionMode: ExecutionMode;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatFailureLimit: number;
  readonly syntheticNoopDurationMs: number;
  readonly workspaceRoot: string;
  readonly codingTaskTimeoutMs: number;
  readonly cursorApiKey?: string;
}

export interface ClaimResult {
  readonly claimed: boolean;
  readonly leaseToken: string;
  readonly workerRun: { readonly id: string; readonly status: string };
  readonly task: { readonly id: string; readonly status: string };
}

export interface HeartbeatResult {
  readonly workerRun: { readonly id: string; readonly status: string };
}

export interface SucceedInput {
  readonly summary: string;
  readonly structuredOutcome: Readonly<Record<string, string | number | boolean>>;
}

export interface FailInput {
  readonly errorCode: string;
  readonly summary: string;
}

export interface TerminalResult {
  readonly workerRun: { readonly id: string; readonly status: string };
  readonly task: { readonly id: string; readonly status: string };
  readonly applied: boolean;
}

export interface ControlPlaneClient {
  claim(workerRunId: string, ownerId: string): Promise<ClaimResult>;
  heartbeat(workerRunId: string, leaseToken: string): Promise<HeartbeatResult>;
  succeed(workerRunId: string, leaseToken: string, input: SucceedInput): Promise<TerminalResult>;
  fail(workerRunId: string, leaseToken: string, input: FailInput): Promise<TerminalResult>;
  getTaskPacket(workerRunId: string, leaseToken: string): Promise<import("../domain/worker-task-packet.js").WorkerTaskPacket>;
  getCodeCandidate?(candidateId: string): Promise<import("../domain/code-candidate.js").CodeCandidate>;
  fetchCodeCandidatePatch?(candidateId: string): Promise<string>;
  createCodeCandidate(input: {
    readonly id: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly workerRunId: string;
    readonly sourceRepository: string;
    readonly sourceRef?: string;
    readonly parentCandidateId?: string;
    readonly baseCommitSha: string;
    readonly changedFiles: readonly string[];
    readonly patchContent: string;
    readonly patchChecksumSha256: string;
    readonly testCommand: string;
    readonly testExitCode: number;
  }): Promise<{ readonly id: string }>;
}

export interface ActuatorLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface ActuatorTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export type ActuatorExitReason =
  | "succeeded"
  | "failed"
  | "claim_failed"
  | "ownership_lost"
  | "unsupported_mode"
  | "interrupted"
  | "invalid_config";

export interface ActuatorRunResult {
  readonly ok: boolean;
  readonly exitCode: 0 | 1;
  readonly reason: ActuatorExitReason;
}

export const SYNTHETIC_NOOP_KIND = "github_actions_synthetic_noop";

/**
 * GitHub Actions worker actuator types and constants.
 *
 * NEXT STAGE (not implemented): dispatch-to-GitHub launch bridge.
 *
 * dispatcher creates a queued worker_run
 * → a control-plane launch bridge would invoke GitHub workflow_dispatch
 * → this actuator claims that worker_run and drives lease/heartbeat/succeed|fail
 *
 * Launch remains manual (`workflow_dispatch` only) until this external worker is proven.
 * The Worker must not auto-start GitHub Actions in this phase.
 */
export const DISPATCH_LAUNCH_BRIDGE_STATUS = "manual_workflow_dispatch_only" as const;

export const EXECUTION_MODES = ["synthetic-noop"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function isExecutionMode(value: string): value is ExecutionMode {
  return (EXECUTION_MODES as readonly string[]).includes(value);
}

/** Must stay safely below the control-plane lease (120s). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Consecutive non-ownership heartbeat failures before fail-closed. */
export const DEFAULT_HEARTBEAT_FAILURE_LIMIT = 2;

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

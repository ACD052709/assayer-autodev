import { ActuatorError } from "./errors.js";
import { githubActionsOwnerId } from "./owner-id.js";
import {
  DEFAULT_HEARTBEAT_FAILURE_LIMIT,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_SYNTHETIC_NOOP_DURATION_MS,
  WORKER_RUN_ID_PATTERN,
  isExecutionMode,
  type ActuatorConfig,
} from "./types.js";

export interface CliEnv {
  readonly AUTODEV_SERVICE_TOKEN?: string;
  readonly AUTODEV_CONTROL_PLANE_URL?: string;
  readonly GITHUB_REPOSITORY?: string;
  readonly GITHUB_RUN_ID?: string;
  readonly GITHUB_RUN_ATTEMPT?: string;
}

const ALLOWED_FLAGS = new Set(["--worker-run-id", "--execution-mode"]);

export function parseActuatorCli(argv: string[], env: CliEnv): ActuatorConfig {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (!flag.startsWith("--")) {
      throw new ActuatorError("invalid_config", "Unsupported CLI arguments. Allowed: --worker-run-id, --execution-mode");
    }
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new ActuatorError("invalid_config", "Unsupported CLI arguments. Allowed: --worker-run-id, --execution-mode");
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ActuatorError("invalid_config", `Missing value for ${flag}`);
    }
    values.set(flag, value);
    i += 1;
  }

  const workerRunId = values.get("--worker-run-id");
  const executionMode = values.get("--execution-mode");
  if (workerRunId === undefined || !WORKER_RUN_ID_PATTERN.test(workerRunId)) {
    throw new ActuatorError("invalid_config", "Invalid --worker-run-id");
  }
  if (executionMode === undefined || !isExecutionMode(executionMode)) {
    throw new ActuatorError("invalid_config", "Unsupported --execution-mode (allowed: synthetic-noop)");
  }

  const serviceToken = env.AUTODEV_SERVICE_TOKEN?.trim();
  if (serviceToken === undefined || serviceToken.length === 0) {
    throw new ActuatorError("invalid_config", "AUTODEV_SERVICE_TOKEN is not set");
  }
  const controlPlaneUrl = env.AUTODEV_CONTROL_PLANE_URL?.trim();
  if (controlPlaneUrl === undefined || controlPlaneUrl.length === 0) {
    throw new ActuatorError("invalid_config", "AUTODEV_CONTROL_PLANE_URL is not set");
  }
  if (!/^https:\/\//i.test(controlPlaneUrl)) {
    throw new ActuatorError("invalid_config", "AUTODEV_CONTROL_PLANE_URL must be an https URL");
  }

  const repository = env.GITHUB_REPOSITORY?.trim();
  const runId = env.GITHUB_RUN_ID?.trim();
  const runAttempt = env.GITHUB_RUN_ATTEMPT?.trim();
  if (repository === undefined || runId === undefined || runAttempt === undefined) {
    throw new ActuatorError(
      "invalid_config",
      "GITHUB_REPOSITORY, GITHUB_RUN_ID, and GITHUB_RUN_ATTEMPT are required to build ownerId",
    );
  }

  return {
    workerRunId,
    executionMode,
    serviceToken,
    controlPlaneUrl: controlPlaneUrl.replace(/\/+$/, ""),
    ownerId: githubActionsOwnerId({ repository, runId, runAttempt }),
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatFailureLimit: DEFAULT_HEARTBEAT_FAILURE_LIMIT,
    syntheticNoopDurationMs: DEFAULT_SYNTHETIC_NOOP_DURATION_MS,
  };
}

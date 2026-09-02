import { createWorkerDispatcher } from "../dispatch/index.js";
import {
  createGitHubLaunchBridgeFromEnv,
  NOOP_WORKER_LAUNCH_BRIDGE,
  type WorkerLaunchBridge,
} from "../dispatch/github-launch-bridge.js";
import { createWorkerRunLifecycle } from "../executor/index.js";
import type { MasterOrchestrator } from "../master/orchestrator.js";
import { createRandomIdFactory } from "../master/ids.js";
import type { AsyncStateStore } from "../state/async-store.js";
import { createAutoDevOrchestrator } from "./cycle.js";
import type { AutoDevOrchestrator } from "./cycle.js";
import { createSchedulingVerifierAdapter } from "./scheduling-verifier-adapter.js";
import {
  createGitHubVerifierLaunchBridgeFromEnv,
  NOOP_VERIFIER_LAUNCH_BRIDGE,
  type VerifierLaunchBridge,
} from "./verifier-launch-bridge.js";
import {
  createGitHubPromotionLaunchBridgeFromEnv,
  NOOP_PROMOTION_LAUNCH_BRIDGE,
  type PromotionLaunchBridge,
} from "./promotion-launch-bridge.js";
import type { VerifierAdapter } from "./verifier-adapter.js";

export interface ControlPlaneRuntimeEnv {
  readonly GITHUB_TOKEN?: string;
  readonly GITHUB_REPOSITORY?: string;
  readonly GITHUB_WORKFLOW_FILE?: string;
  readonly GITHUB_VERIFIER_WORKFLOW_FILE?: string;
  readonly GITHUB_WORKFLOW_REF?: string;
  readonly GITHUB_EXECUTION_MODE?: string;
  readonly BROWSER_VERIFIER_TARGET_URL?: string;
  readonly GITHUB_PROMOTION_WORKFLOW_FILE?: string;
}

export interface ControlPlaneCompositionOptions {
  readonly store: AsyncStateStore;
  readonly env: ControlPlaneRuntimeEnv;
  readonly masterOrchestrator?: MasterOrchestrator;
  readonly implementationLaunchBridge?: WorkerLaunchBridge;
  readonly verifierLaunchBridge?: VerifierLaunchBridge;
  readonly verifierAdapter?: VerifierAdapter;
  readonly promotionLaunchBridge?: PromotionLaunchBridge;
}

export interface ControlPlaneComposition {
  readonly taskDispatcher: ReturnType<typeof createWorkerDispatcher>;
  readonly workerRunLifecycle: ReturnType<typeof createWorkerRunLifecycle>;
  readonly autoDevOrchestrator: AutoDevOrchestrator;
  readonly implementationLaunchBridge: WorkerLaunchBridge;
  readonly verifierLaunchBridge: VerifierLaunchBridge;
  readonly promotionLaunchBridge: PromotionLaunchBridge;
}

/**
 * Wires the authoritative Part 6 orchestrator for Cloudflare Worker runtime.
 * Implementation workers and browser verifiers schedule through GitHub Actions when configured.
 */
export function createControlPlaneComposition(
  options: ControlPlaneCompositionOptions,
): ControlPlaneComposition {
  const ids = createRandomIdFactory();
  const implementationLaunchBridge =
    options.implementationLaunchBridge ??
    createGitHubLaunchBridgeFromEnv(options.env) ??
    NOOP_WORKER_LAUNCH_BRIDGE;
  const verifierLaunchBridge =
    options.verifierLaunchBridge ??
    createGitHubVerifierLaunchBridgeFromEnv(options.env) ??
    NOOP_VERIFIER_LAUNCH_BRIDGE;
  const promotionLaunchBridge =
    options.promotionLaunchBridge ??
    createGitHubPromotionLaunchBridgeFromEnv(options.env) ??
    NOOP_PROMOTION_LAUNCH_BRIDGE;

  const taskDispatcher = createWorkerDispatcher({
    store: options.store,
    idFactory: ids,
    launchBridge: implementationLaunchBridge,
    codingBudgetGate: options.env.GITHUB_EXECUTION_MODE?.trim() === "coding-task",
  });
  const workerRunLifecycle = createWorkerRunLifecycle({ store: options.store, dispatcher: taskDispatcher });

  const verifierAdapter =
    options.verifierAdapter ??
    createSchedulingVerifierAdapter({
      store: options.store,
      launchBridge: verifierLaunchBridge,
      ...(options.env.BROWSER_VERIFIER_TARGET_URL !== undefined
        ? { targetUrl: options.env.BROWSER_VERIFIER_TARGET_URL.trim() }
        : {}),
    });

  const autoDevOrchestrator = createAutoDevOrchestrator({
    store: options.store,
    verifierAdapter,
    idFactory: ids,
    taskDispatcher,
    ...(options.masterOrchestrator !== undefined ? { masterOrchestrator: options.masterOrchestrator } : {}),
    promotionLaunchBridge,
  });

  return {
    taskDispatcher,
    workerRunLifecycle,
    autoDevOrchestrator,
    implementationLaunchBridge,
    verifierLaunchBridge,
    promotionLaunchBridge,
  };
}

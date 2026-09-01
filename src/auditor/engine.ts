import { nowIso } from "../domain/common.js";
import type { AsyncStateStore } from "../state/async-store.js";
import type { StateStore } from "../state/store.js";
import { loadAuditInput, loadAuditInputAsync } from "./load-input.js";
import { evaluateAuditRules } from "./rules.js";
import { DEFAULT_AUDIT_THRESHOLDS } from "./thresholds.js";
import type { AuditRunResult, RunProjectAuditOptions } from "./types.js";

function isAsyncStore(store: StateStore | AsyncStateStore): store is AsyncStateStore {
  const candidate = store as AsyncStateStore;
  return typeof candidate.syncAuditFindings === "function";
}

export async function runProjectAudit(
  store: StateStore | AsyncStateStore,
  projectId: string,
  options: RunProjectAuditOptions = {},
): Promise<AuditRunResult> {
  const now = options.now ?? nowIso();
  const thresholds = options.thresholds ?? DEFAULT_AUDIT_THRESHOLDS;

  const input = isAsyncStore(store)
    ? await loadAuditInputAsync(store, projectId, now)
    : loadAuditInput(store, projectId, now);

  const detected = evaluateAuditRules(input, now, thresholds);

  const syncResult = isAsyncStore(store)
    ? await store.syncAuditFindings({ projectId, detected, now })
    : store.syncAuditFindings({ projectId, detected, now });

  return {
    projectId,
    evaluatedAt: now,
    detected,
    findings: syncResult.findings,
    activeCount: syncResult.activeCount,
    resolvedCount: syncResult.resolvedCount,
  };
}

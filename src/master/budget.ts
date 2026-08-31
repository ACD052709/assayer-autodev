import type { BudgetLedger } from "../domain/index.js";

/** Token-count estimate used only for hard llm_tokens authorization. Independent of dollar pricing. */
export interface MasterCallTokenEstimate {
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
}

export const DEFAULT_MASTER_CALL_TOKEN_ESTIMATE: MasterCallTokenEstimate = {
  estimatedInputTokens: 4000,
  estimatedOutputTokens: 1500,
};

export type BudgetAuthorization =
  | { readonly allowed: true; readonly remaining: number; readonly estimatedTokens: number }
  | { readonly allowed: false; readonly reason: string; readonly estimatedTokens: number };

export function estimateMasterCallTokens(
  estimate: MasterCallTokenEstimate = DEFAULT_MASTER_CALL_TOKEN_ESTIMATE,
): number {
  return estimate.estimatedInputTokens + estimate.estimatedOutputTokens;
}

export function authorizeLlmBudget(
  ledger: BudgetLedger | undefined,
  estimatedTokens: number,
): BudgetAuthorization {
  if (ledger === undefined) {
    return { allowed: false, reason: "budget_unavailable", estimatedTokens };
  }

  const hard = ledger.limits.find((limit) => limit.category === "llm_tokens" && limit.kind === "hard");
  if (hard === undefined) {
    return { allowed: false, reason: "budget_unavailable", estimatedTokens };
  }

  const usage = ledger.entries
    .filter((entry) => entry.category === "llm_tokens")
    .reduce((sum, entry) => sum + entry.amount, 0);

  if (usage >= hard.maxAmount) {
    return { allowed: false, reason: "hard_limit_exceeded", estimatedTokens };
  }
  if (usage + estimatedTokens > hard.maxAmount) {
    return { allowed: false, reason: "hard_limit_exceeded", estimatedTokens };
  }
  return { allowed: true, remaining: hard.maxAmount - usage, estimatedTokens };
}

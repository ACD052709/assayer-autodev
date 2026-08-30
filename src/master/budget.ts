import type { BudgetLedger } from "../domain/index.js";

export interface MasterModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly currency: string;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
}

export const DEFAULT_MASTER_MODEL_PRICING: MasterModelPricing = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  currency: "usd",
  estimatedInputTokens: 4000,
  estimatedOutputTokens: 1500,
};

export type BudgetAuthorization =
  | { readonly allowed: true; readonly remaining: number; readonly estimatedTokens: number }
  | { readonly allowed: false; readonly reason: string; readonly estimatedTokens: number };

export function estimateMasterCallTokens(pricing: MasterModelPricing): number {
  return pricing.estimatedInputTokens + pricing.estimatedOutputTokens;
}

export function computeTokenCostUsd(
  inputTokens: number,
  outputTokens: number,
  pricing: MasterModelPricing,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
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

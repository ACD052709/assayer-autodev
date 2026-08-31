import { MASTER_MODEL_ID } from "./openai-client.js";

export interface ModelTokenPrices {
  readonly inputPerMillion: number;
  readonly cachedInputPerMillion: number;
  readonly outputPerMillion: number;
  readonly currency: "usd";
}

export interface ModelPricingCatalog {
  readonly models: Readonly<Record<string, ModelTokenPrices>>;
}

export interface ModelTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

export type ModelCostEstimate =
  | { readonly status: "available"; readonly currency: "usd"; readonly amount: number }
  | { readonly status: "unavailable"; readonly reason: "unknown_model" };

export const GPT_5_6_SOL_PRICES: ModelTokenPrices = {
  inputPerMillion: 4,
  cachedInputPerMillion: 0.4,
  outputPerMillion: 20,
  currency: "usd",
};

export function createModelPricingCatalog(
  models: Readonly<Record<string, ModelTokenPrices>>,
): ModelPricingCatalog {
  return { models };
}

export const DEFAULT_MODEL_PRICING_CATALOG: ModelPricingCatalog = createModelPricingCatalog({
  [MASTER_MODEL_ID]: GPT_5_6_SOL_PRICES,
});

export function lookupModelPrices(
  catalog: ModelPricingCatalog,
  model: string,
): ModelTokenPrices | undefined {
  return catalog.models[model];
}

export function computeModelCostUsd(usage: ModelTokenUsage, prices: ModelTokenPrices): number {
  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), Math.max(usage.inputTokens, 0));
  const uncached = Math.max(usage.inputTokens, 0) - cached;
  const output = Math.max(usage.outputTokens, 0);
  return (
    (uncached / 1_000_000) * prices.inputPerMillion +
    (cached / 1_000_000) * prices.cachedInputPerMillion +
    (output / 1_000_000) * prices.outputPerMillion
  );
}

export function estimateModelCost(
  model: string,
  usage: ModelTokenUsage,
  catalog: ModelPricingCatalog = DEFAULT_MODEL_PRICING_CATALOG,
): ModelCostEstimate {
  const prices = lookupModelPrices(catalog, model);
  if (prices === undefined) {
    return { status: "unavailable", reason: "unknown_model" };
  }
  return {
    status: "available",
    currency: prices.currency,
    amount: computeModelCostUsd(usage, prices),
  };
}

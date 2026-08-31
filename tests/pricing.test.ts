import { describe, expect, it } from "vitest";
import { MASTER_MODEL_ID } from "../src/master/openai-client.js";
import {
  computeModelCostUsd,
  createModelPricingCatalog,
  DEFAULT_MODEL_PRICING_CATALOG,
  estimateModelCost,
  GPT_5_6_SOL_PRICES,
} from "../src/master/pricing.js";

describe("model pricing catalog", () => {
  it("computes GPT-5.6 Sol cost for the live smoke usage", () => {
    const amount = computeModelCostUsd(
      { inputTokens: 1036, outputTokens: 178 },
      GPT_5_6_SOL_PRICES,
    );
    expect(amount).toBeCloseTo(0.007704, 10);
    const estimate = estimateModelCost(MASTER_MODEL_ID, {
      inputTokens: 1036,
      outputTokens: 178,
    });
    expect(estimate).toEqual({
      status: "available",
      currency: "usd",
      amount,
    });
  });

  it("applies cached-input price separately from uncached input", () => {
    const amount = computeModelCostUsd(
      { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400 },
      GPT_5_6_SOL_PRICES,
    );
    expect(amount).toBeCloseTo(0.00456, 10);
  });

  it("does not report a fake $0 cost for an unknown model", () => {
    const estimate = estimateModelCost("not-a-priced-model", {
      inputTokens: 1036,
      outputTokens: 178,
    });
    expect(estimate).toEqual({ status: "unavailable", reason: "unknown_model" });
    expect("amount" in estimate).toBe(false);
  });

  it("allows a replacement catalog without changing orchestration defaults", () => {
    const catalog = createModelPricingCatalog({
      "custom-model": {
        inputPerMillion: 1,
        cachedInputPerMillion: 0.1,
        outputPerMillion: 2,
        currency: "usd",
      },
    });
    const estimate = estimateModelCost(
      "custom-model",
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      catalog,
    );
    expect(estimate).toEqual({ status: "available", currency: "usd", amount: 3 });
    expect(DEFAULT_MODEL_PRICING_CATALOG.models[MASTER_MODEL_ID]).toEqual(GPT_5_6_SOL_PRICES);
  });
});

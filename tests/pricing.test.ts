import { describe, expect, it } from "vitest";
import { MASTER_MODEL_ID } from "../src/master/openai-client.js";
import {
  computeModelCostUsd,
  createModelPricingCatalog,
  DEFAULT_MODEL_PRICING_CATALOG,
  estimateModelCost,
  GPT_5_6_SOL_PRICES,
  interpretStoredCost,
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

  it("does not treat a historical placeholder-zero as genuine available $0", () => {
    const interpreted = interpretStoredCost({
      model: MASTER_MODEL_ID,
      estimatedCost: 0,
      inputTokens: 1036,
      outputTokens: 178,
    });
    expect(interpreted.costStatus).toBe("unavailable");
    expect(interpreted.estimatedCost).toBe(0);
  });

  it("treats a stored zero as available only when catalog pricing also yields zero", () => {
    const catalog = createModelPricingCatalog({
      free: {
        inputPerMillion: 0,
        cachedInputPerMillion: 0,
        outputPerMillion: 0,
        currency: "usd",
      },
    });
    expect(
      interpretStoredCost(
        { model: "free", estimatedCost: 0, inputTokens: 100, outputTokens: 20 },
        catalog,
      ),
    ).toEqual({ costStatus: "available", estimatedCost: 0 });
  });

  it("keeps nonzero stored costs available and unknown models unavailable", () => {
    expect(
      interpretStoredCost({
        model: MASTER_MODEL_ID,
        estimatedCost: 0.007704,
        inputTokens: 1036,
        outputTokens: 178,
      }),
    ).toEqual({ costStatus: "available", estimatedCost: 0.007704 });
    expect(
      interpretStoredCost({
        model: "mystery-model",
        inputTokens: 1036,
        outputTokens: 178,
      }),
    ).toEqual({ costStatus: "unavailable" });
  });
});

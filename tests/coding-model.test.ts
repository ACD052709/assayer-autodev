import { describe, expect, it } from "vitest";
import {
  codingAttemptReservationUsd,
  computeCodingModelCostUsd,
  selectCodingModelForTask,
} from "../src/domain/coding-model.js";
import { reasoningEffortForCodingModel } from "../src/actuator/codex-cli.js";

function repairDescription(attempt: number): string {
  return `Repair verification failure\n<!--autodev-repair:${JSON.stringify({
    originalTaskId: "task-original",
    verifierRunId: `ver-${attempt}`,
    attempt,
    failureSummary: "failed",
  })}-->`;
}

describe("coding model routing and pricing", () => {
  it("routes from durable repair-attempt metadata instead of relying on nested titles", () => {
    expect(selectCodingModelForTask({ title: "Implement scan flow", description: "Implement it" })).toBe("gpt-5.6-luna");
    expect(selectCodingModelForTask({ title: "Repair: Implement scan flow", description: repairDescription(1) })).toBe("gpt-5.6-luna");
    expect(selectCodingModelForTask({ title: "Repair: Implement scan flow", description: repairDescription(2) })).toBe("gpt-5.6-terra");
    expect(selectCodingModelForTask({ title: "Repair: Implement scan flow", description: repairDescription(3) })).toBe("gpt-5.6-sol");
  });

  it("keeps legacy nested repair-title routing as a fallback", () => {
    expect(selectCodingModelForTask({ title: "Repair: Repair: Implement scan flow", description: "legacy" })).toBe("gpt-5.6-terra");
    expect(selectCodingModelForTask({ title: "Repair: Repair: Repair: Implement scan flow", description: "legacy" })).toBe("gpt-5.6-sol");
  });


  it("uses cheap-first reasoning effort as models escalate", () => {
    expect(reasoningEffortForCodingModel("gpt-5.6-luna")).toBe("low");
    expect(reasoningEffortForCodingModel("gpt-5.6-terra")).toBe("medium");
    expect(reasoningEffortForCodingModel("gpt-5.6-sol")).toBe("high");
  });

  it("prices uncached, cached, cache-write Luna input plus output", () => {
    expect(computeCodingModelCostUsd("gpt-5.6-luna", {
      inputTokens: 250_000,
      cachedInputTokens: 100_000,
      cacheWriteInputTokens: 50_000,
      outputTokens: 50_000,
    })).toBeCloseTo(0.0945, 10);
  });

  it("prices a long-context request using the published full-request multipliers", () => {
    expect(computeCodingModelCostUsd("gpt-5.6-luna", {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 100_000,
    })).toBeCloseTo(0.4, 10);
  });

  it("applies GPT-5.6 long-context multipliers above 272K input tokens", () => {
    const normal = computeCodingModelCostUsd("gpt-5.6-luna", {
      inputTokens: 272_000,
      outputTokens: 10_000,
    });
    const long = computeCodingModelCostUsd("gpt-5.6-luna", {
      inputTokens: 272_001,
      outputTokens: 10_000,
    });
    expect(long).toBeGreaterThan(normal * 1.8);
  });

  it("uses conservative attempt reservations", () => {
    expect(codingAttemptReservationUsd("gpt-5.6-luna")).toBe(0.25);
    expect(codingAttemptReservationUsd("gpt-5.6-terra")).toBe(1.5);
    expect(codingAttemptReservationUsd("gpt-5.6-sol")).toBe(3);
  });
});

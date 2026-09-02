import type { Task } from "./task.js";

export const CODING_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] as const;
export type CodingModelId = (typeof CODING_MODELS)[number];

export const DEFAULT_CODING_MODEL: CodingModelId = "gpt-5.6-luna";
export const CODING_COST_BUDGET_CATEGORY = "llm_cost_usd" as const;

export interface CodingModelTokenPrices {
  readonly inputPerMillion: number;
  readonly cachedInputPerMillion: number;
  readonly outputPerMillion: number;
  readonly currency: "usd";
}

export interface CodingModelTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens?: number;
  /** GPT-5.6 prompt-cache writes are billed at 1.25x uncached input. */
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens: number;
}

export const CODING_MODEL_PRICES: Readonly<Record<CodingModelId, CodingModelTokenPrices>> = {
  "gpt-5.6-luna": {
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 1.2,
    currency: "usd",
  },
  "gpt-5.6-terra": {
    inputPerMillion: 2,
    cachedInputPerMillion: 0.2,
    outputPerMillion: 12,
    currency: "usd",
  },
  "gpt-5.6-sol": {
    inputPerMillion: 4,
    cachedInputPerMillion: 0.4,
    outputPerMillion: 20,
    currency: "usd",
  },
};

/**
 * Conservative headroom required before starting another coding attempt.
 * This is a reservation gate, not a charge. Actual API usage is recorded
 * after Codex returns. Active worker reservations are subtracted during dispatch
 * so parallel workers cannot all spend the same remaining project budget.
 */
export const CODING_ATTEMPT_RESERVATION_USD: Readonly<Record<CodingModelId, number>> = {
  "gpt-5.6-luna": 0.25,
  "gpt-5.6-terra": 1.5,
  "gpt-5.6-sol": 3,
};

export function isCodingModelId(value: string): value is CodingModelId {
  return (CODING_MODELS as readonly string[]).includes(value);
}

const REPAIR_CONTEXT_MARKER = "<!--autodev-repair:";

/**
 * Repair attempt is durable metadata embedded by the orchestrator. Do not infer
 * the attempt only from the human title: repair titles intentionally remain one
 * "Repair:" deep across a chain.
 */
function repairAttemptFromDescription(description: string): number | undefined {
  const start = description.indexOf(REPAIR_CONTEXT_MARKER);
  if (start === -1) return undefined;
  const end = description.indexOf("-->", start);
  if (end === -1) return undefined;
  try {
    const parsed = JSON.parse(
      description.slice(start + REPAIR_CONTEXT_MARKER.length, end),
    ) as Record<string, unknown>;
    const attempt = parsed.attempt;
    if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
      return undefined;
    }
    return attempt;
  } catch {
    return undefined;
  }
}

/** Legacy fallback for tasks created before repair metadata was introduced. */
function repairDepthFromTitle(title: string): number {
  let rest = title.trim();
  let depth = 0;
  while (/^repair\s*:/i.test(rest)) {
    depth += 1;
    rest = rest.replace(/^repair\s*:\s*/i, "");
  }
  return depth;
}

/**
 * Cheap-first routing:
 * - original work and repair attempt 1: Luna
 * - repair attempt 2: Terra
 * - repair attempt 3+: Sol
 */
export function selectCodingModelForTask(
  task: Pick<Task, "title" | "description">,
): CodingModelId {
  const repairAttempt = repairAttemptFromDescription(task.description) ?? repairDepthFromTitle(task.title);
  if (repairAttempt >= 3) return "gpt-5.6-sol";
  if (repairAttempt >= 2) return "gpt-5.6-terra";
  return DEFAULT_CODING_MODEL;
}

export function codingAttemptReservationUsd(model: CodingModelId): number {
  return CODING_ATTEMPT_RESERVATION_USD[model];
}

/**
 * Computes API token cost from Codex usage. GPT-5.6 requests whose input exceeds
 * 272K tokens use the published long-context multipliers for the full request.
 */
export function computeCodingModelCostUsd(model: CodingModelId, usage: CodingModelTokenUsage): number {
  const prices = CODING_MODEL_PRICES[model];
  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens);
  const remainingAfterCached = Math.max(0, usage.inputTokens - cached);
  const cacheWrite = Math.min(
    Math.max(usage.cacheWriteInputTokens ?? 0, 0),
    remainingAfterCached,
  );
  const uncached = Math.max(0, remainingAfterCached - cacheWrite);
  const longContext = usage.inputTokens > 272_000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const inputCost =
    uncached * prices.inputPerMillion +
    cached * prices.cachedInputPerMillion +
    cacheWrite * prices.inputPerMillion * 1.25;
  return (
    (inputCost * inputMultiplier + usage.outputTokens * prices.outputPerMillion * outputMultiplier) /
    1_000_000
  );
}

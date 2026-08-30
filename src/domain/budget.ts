import type { EntityId, ISOTimestamp, Timestamps } from "./common.js";

export type BudgetCategory =
  | "llm_tokens"
  | "compute"
  | "browser_minutes"
  | "storage"
  | "other";

export type BudgetLimitKind = "soft" | "hard";

export interface BudgetLimit {
  readonly kind: BudgetLimitKind;
  readonly category: BudgetCategory;
  readonly maxAmount: number;
  readonly unit: string;
}

export interface BudgetEntry extends Timestamps {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly category: BudgetCategory;
  readonly amount: number;
  readonly unit: string;
  readonly taskId?: EntityId;
  readonly workerRunId?: EntityId;
  readonly description?: string;
}

export interface BudgetLedger extends Timestamps {
  readonly projectId: EntityId;
  readonly limits: readonly BudgetLimit[];
  readonly entries: readonly BudgetEntry[];
}

export type BudgetCheckResult =
  | { readonly allowed: true; readonly remaining: number }
  | {
      readonly allowed: false;
      readonly reason: "soft_limit_exceeded" | "hard_limit_exceeded";
      readonly limit: BudgetLimit;
      readonly currentUsage: number;
    };

export interface CreateBudgetEntryInput {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly category: BudgetCategory;
  readonly amount: number;
  readonly unit: string;
  readonly taskId?: EntityId;
  readonly workerRunId?: EntityId;
  readonly description?: string;
}

export interface InitializeBudgetLedgerInput {
  readonly projectId: EntityId;
  readonly limits: readonly BudgetLimit[];
  readonly at?: ISOTimestamp;
}

export const BUDGET_RESOURCE_UNITS: Record<BudgetCategory, string> = {
  llm_tokens: "tokens",
  compute: "minutes",
  browser_minutes: "minutes",
  storage: "bytes",
  other: "units",
};

export class BudgetResourceConflictError extends Error {
  readonly code = "conflict";

  constructor(readonly resourceType: BudgetCategory) {
    super(`Budget already exists for resource type: ${resourceType}`);
    this.name = "BudgetResourceConflictError";
  }
}

export interface AddBudgetResourceInput {
  readonly projectId: EntityId;
  readonly resourceType: BudgetCategory;
  readonly hardLimit: number;
  readonly unit: string;
  readonly softLimit?: number;
}

export interface BudgetResourceView {
  readonly id: BudgetCategory;
  readonly projectId: EntityId;
  readonly resourceType: BudgetCategory;
  readonly unit: string;
  readonly hardLimit: number;
  readonly softLimit?: number;
  readonly consumedAmount: number;
  readonly reservedAmount: number;
  readonly remainingHardLimit: number;
  readonly entries: readonly BudgetEntry[];
}

export function expectedBudgetUnit(resourceType: BudgetCategory): string {
  return BUDGET_RESOURCE_UNITS[resourceType];
}

export function limitsForBudgetResource(input: AddBudgetResourceInput): readonly BudgetLimit[] {
  const limits: BudgetLimit[] = [
    {
      kind: "hard",
      category: input.resourceType,
      maxAmount: input.hardLimit,
      unit: input.unit,
    },
  ];
  if (input.softLimit !== undefined) {
    limits.push({
      kind: "soft",
      category: input.resourceType,
      maxAmount: input.softLimit,
      unit: input.unit,
    });
  }
  return limits;
}

export function toBudgetResourceView(
  ledger: BudgetLedger,
  resourceType: BudgetCategory,
): BudgetResourceView | undefined {
  const hard = ledger.limits.find((limit) => limit.category === resourceType && limit.kind === "hard");
  if (hard === undefined) {
    return undefined;
  }
  const soft = ledger.limits.find((limit) => limit.category === resourceType && limit.kind === "soft");
  const entries = ledger.entries.filter((entry) => entry.category === resourceType);
  const consumedAmount = entries.reduce((sum, entry) => sum + entry.amount, 0);
  const remainingHardLimit = Math.max(0, hard.maxAmount - consumedAmount);
  return {
    id: resourceType,
    projectId: ledger.projectId,
    resourceType,
    unit: hard.unit,
    hardLimit: hard.maxAmount,
    consumedAmount,
    reservedAmount: 0,
    remainingHardLimit,
    entries,
    ...(soft !== undefined ? { softLimit: soft.maxAmount } : {}),
  };
}

export function listBudgetResourceViews(ledger: BudgetLedger): readonly BudgetResourceView[] {
  const types = [...new Set(ledger.limits.filter((limit) => limit.kind === "hard").map((limit) => limit.category))];
  return types
    .map((resourceType) => toBudgetResourceView(ledger, resourceType))
    .filter((view): view is BudgetResourceView => view !== undefined);
}

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

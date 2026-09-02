import type {
  CreateMasterRunInput,
  EntityId,
  MasterAction,
  MasterInput,
  MasterPhase,
  MasterRun,
  TaskProposal,
} from "../domain/index.js";
import type { AsyncStateStore } from "../state/async-store.js";
import { nextActiveTaskIds } from "./active-tasks.js";
import {
  authorizeLlmBudget,
  authorizeOptionalLlmCostBudget,
  DEFAULT_MASTER_CALL_TOKEN_ESTIMATE,
  estimateMasterCallTokens,
  type MasterCallTokenEstimate,
} from "./budget.js";
import type { MasterModelClient } from "./client.js";
import { MasterModelConfigError, sanitizeErrorMessage } from "./errors.js";
import type { IdFactory } from "./ids.js";
import { createRandomIdFactory } from "./ids.js";
import {
  DEFAULT_MODEL_PRICING_CATALOG,
  estimateModelCost,
  type ModelPricingCatalog,
} from "./pricing.js";
import { MASTER_PROMPT_VERSION, MASTER_SYSTEM_PROMPT } from "./prompt.js";
import { evaluateFinishedGate } from "./release-gate.js";
import { topologicalTaskProposals, validateMasterDecision } from "./validate-output.js";

export interface MasterRunRequest {
  readonly projectId: EntityId;
  readonly trigger?: string;
  readonly context?: string;
}

export interface MasterOrchestratorOptions {
  readonly store: AsyncStateStore;
  readonly client: MasterModelClient;
  readonly idFactory?: IdFactory;
  readonly tokenEstimate?: MasterCallTokenEstimate;
  readonly pricingCatalog?: ModelPricingCatalog;
}

function phaseForAction(action: MasterAction): MasterPhase {
  switch (action) {
    case "CREATE_TASKS":
    case "REPLAN":
      return "planning";
    case "WAIT_FOR_WORKERS":
      return "executing";
    case "REQUEST_VERIFICATION":
      return "verifying";
    case "REQUEST_HUMAN_APPROVAL":
    case "BLOCKED":
      return "paused";
    case "FINAL_ACCEPTANCE":
      return "accepting";
    case "FINISHED":
      return "completed";
  }
}

export class MasterOrchestrator {
  private readonly store: AsyncStateStore;
  private readonly client: MasterModelClient;
  private readonly ids: IdFactory;
  private readonly tokenEstimate: MasterCallTokenEstimate;
  private readonly pricingCatalog: ModelPricingCatalog;

  constructor(options: MasterOrchestratorOptions) {
    this.store = options.store;
    this.client = options.client;
    this.ids = options.idFactory ?? createRandomIdFactory();
    this.tokenEstimate = options.tokenEstimate ?? DEFAULT_MASTER_CALL_TOKEN_ESTIMATE;
    this.pricingCatalog = options.pricingCatalog ?? DEFAULT_MODEL_PRICING_CATALOG;
  }

  async run(request: MasterRunRequest): Promise<MasterRun> {
    const input = await this.loadInput(request);
    const estimatedTokens = estimateMasterCallTokens(this.tokenEstimate);
    const authorization = authorizeLlmBudget(input.budget, estimatedTokens);
    if (!authorization.allowed) {
      return this.persistBlockedRun(
        request,
        `Budget blocked master call: ${authorization.reason}`,
        [authorization.reason],
        "none",
      );
    }

    const costAuthorization = authorizeOptionalLlmCostBudget(input.budget);
    if (!costAuthorization.allowed) {
      return this.persistBlockedRun(
        request,
        `Budget blocked master call: ${costAuthorization.reason}`,
        [costAuthorization.reason],
        "none",
      );
    }

    let modelOutput: unknown;
    let modelId = "unknown";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cachedInputTokens: number | undefined;
    try {
      const result = await this.client.complete({
        systemPrompt: MASTER_SYSTEM_PROMPT,
        userPayload: this.toModelPayload(input),
      });
      modelOutput = result.output;
      modelId = result.model;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      cachedInputTokens = result.cachedInputTokens;
    } catch (error) {
      if (error instanceof MasterModelConfigError) {
        throw error;
      }
      return this.persistFailedRun(request, sanitizeErrorMessage(error), modelId);
    }

    if (inputTokens !== undefined || outputTokens !== undefined) {
      const used = (inputTokens ?? 0) + (outputTokens ?? 0);
      if (used > 0 && input.budget !== undefined) {
        await this.store.recordBudgetEntry({
          id: this.ids.next("budg"),
          projectId: request.projectId,
          category: "llm_tokens",
          amount: used,
          unit: "tokens",
          description: "master_model_call",
        });
      }
    }

    const modelCost = this.costFields(modelId, inputTokens, outputTokens, cachedInputTokens);
    const hasDollarBudget = input.budget?.limits.some(
      (limit) => limit.category === "llm_cost_usd" && limit.kind === "hard",
    ) === true;
    if (hasDollarBudget && modelCost.estimatedCost !== undefined) {
      await this.store.recordBudgetEntry({
        id: this.ids.next("budg"),
        projectId: request.projectId,
        category: "llm_cost_usd",
        amount: modelCost.estimatedCost,
        unit: "usd",
        description: `master_model_call:${modelId}`,
      });
    }

    let decision;
    try {
      decision = validateMasterDecision(modelOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : "model_output_invalid";
      return this.persistRejectedRun(
        request,
        message,
        modelId,
        inputTokens,
        outputTokens,
        cachedInputTokens,
      );
    }

    const gate = evaluateFinishedGate(input);
    let enforcedAction = decision.action;
    let finishedBlockedReasons: readonly string[] = [];
    if (decision.action === "FINISHED" || decision.claimedFinished) {
      if (!gate.allowed) {
        enforcedAction = "BLOCKED";
        finishedBlockedReasons = gate.reasons;
      }
    }

    const createdTaskIds: EntityId[] = [];
    if (enforcedAction === "CREATE_TASKS" || enforcedAction === "REPLAN") {
      try {
        createdTaskIds.push(
          ...(await this.persistTaskProposals(request.projectId, decision.taskProposals)),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "task_proposal_invalid";
        return this.persistRejectedRun(
          request,
          message,
          modelId,
          inputTokens,
          outputTokens,
          cachedInputTokens,
        );
      }
      await this.syncActiveTaskIds(request.projectId, createdTaskIds);
    }

    const cost = modelCost;

    const run = await this.store.createMasterRun({
      id: this.ids.next("mrun"),
      projectId: request.projectId,
      proposedAction: decision.action,
      enforcedAction,
      rationale:
        finishedBlockedReasons.length > 0
          ? `${decision.rationale} FINISHED blocked: ${finishedBlockedReasons.join(", ")}`
          : decision.rationale,
      finishedBlockedReasons,
      createdTaskIds,
      promptVersion: MASTER_PROMPT_VERSION,
      model: modelId,
      status: enforcedAction === "BLOCKED" ? "blocked" : "completed",
      ...(request.trigger !== undefined ? { trigger: request.trigger } : {}),
      ...(request.context !== undefined ? { context: request.context } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...cost,
    });

    await this.store.updateMasterPhase(request.projectId, phaseForAction(enforcedAction));
    await this.enqueueDecision(run);
    return run;
  }

  private async loadInput(request: MasterRunRequest): Promise<MasterInput> {
    const project = await this.store.getProject(request.projectId);
    if (project === undefined) {
      throw new Error(`Project not found: ${request.projectId}`);
    }
    const [
      masterState,
      requirements,
      definitionsOfDone,
      tasks,
      verifierRuns,
      testCases,
      testResults,
      evidence,
      budget,
      releaseContract,
      acceptanceCriteria,
      blockers,
      inbox,
    ] = await Promise.all([
      this.store.getOrCreateMasterState(request.projectId),
      this.store.listRequirementsByProject(request.projectId),
      this.store.listDefinitionsOfDoneByProject(request.projectId),
      this.store.listTasksByProject(request.projectId),
      this.store.listVerifierRunsByProject(request.projectId),
      this.store.listTestCasesByProject(request.projectId),
      this.store.listTestResultsByProject(request.projectId),
      this.store.listEvidenceByProject(request.projectId),
      this.store.getBudgetLedger(request.projectId),
      this.store.getLatestReleaseContract(request.projectId),
      this.store.listAcceptanceCriteriaByProject(request.projectId),
      this.store.listBlockersByProject(request.projectId),
      this.store.listMasterInbox(request.projectId),
    ]);

    return {
      projectId: request.projectId,
      objective: project.description,
      project,
      masterState,
      requirements,
      definitionsOfDone,
      tasks,
      verifierRuns,
      testCases,
      testResults,
      evidence,
      budget,
      releaseContract,
      acceptanceCriteria,
      blockers,
      inbox,
      ...(request.trigger !== undefined ? { trigger: request.trigger } : {}),
      ...(request.context !== undefined ? { context: request.context } : {}),
    };
  }

  private toModelPayload(input: MasterInput): unknown {
    return {
      objective: input.objective,
      trigger: input.trigger ?? "",
      context: input.context ?? "",
      project: input.project,
      masterState: input.masterState,
      requirements: input.requirements,
      definitionsOfDone: input.definitionsOfDone,
      tasks: input.tasks,
      verifierRuns: input.verifierRuns,
      testCases: input.testCases,
      testResults: input.testResults,
      evidence: input.evidence,
      budget: input.budget
        ? {
            limits: input.budget.limits,
            usage: input.budget.entries.reduce<Record<string, number>>((acc, entry) => {
              acc[entry.category] = (acc[entry.category] ?? 0) + entry.amount;
              return acc;
            }, {}),
          }
        : null,
      releaseContract: input.releaseContract ?? null,
      acceptanceCriteria: input.acceptanceCriteria,
      blockers: input.blockers,
      inbox: input.inbox.map((item) => ({
        id: item.id,
        kind: item.kind,
        subject: item.subject,
        status: item.status,
        receivedAt: item.receivedAt,
      })),
    };
  }

  private async persistTaskProposals(
    projectId: EntityId,
    proposals: readonly TaskProposal[],
  ): Promise<readonly EntityId[]> {
    const existingTasks = await this.store.listTasksByProject(projectId);
    const existingIds = new Set(existingTasks.map((t) => t.id));
    const ordered = topologicalTaskProposals(proposals);
    const createdIds: EntityId[] = [];
    const keyToId = new Map<string, EntityId>();

    for (const proposal of ordered) {
      for (const existingId of proposal.existingDependencyIds) {
        if (!existingIds.has(existingId) && !createdIds.includes(existingId)) {
          throw new Error(`Unknown existing dependency: ${existingId}`);
        }
      }
      const id = this.ids.next("task");
      const dependencyIds = [
        ...proposal.existingDependencyIds,
        ...proposal.dependencyClientKeys.map((key) => keyToId.get(key)!),
      ];
      await this.store.createTask({
        id,
        projectId,
        title: proposal.title,
        description: proposal.description,
        kind: proposal.kind,
        dependencyIds,
      });
      for (const dependsOnTaskId of dependencyIds) {
        await this.store.addTaskDependency({ taskId: id, dependsOnTaskId });
      }
      keyToId.set(proposal.clientKey, id);
      createdIds.push(id);
      existingIds.add(id);
    }
    return createdIds;
  }

  private async syncActiveTaskIds(
    projectId: EntityId,
    newlyCreatedIds: readonly EntityId[],
  ): Promise<void> {
    const [state, tasks] = await Promise.all([
      this.store.getOrCreateMasterState(projectId),
      this.store.listTasksByProject(projectId),
    ]);
    const next = nextActiveTaskIds(state.activeTaskIds, tasks, newlyCreatedIds);
    await this.store.setMasterActiveTaskIds(projectId, next);
  }

  private costFields(
    model: string,
    inputTokens?: number,
    outputTokens?: number,
    cachedInputTokens?: number,
  ): Pick<CreateMasterRunInput, "estimatedCost" | "costStatus"> {
    if (inputTokens === undefined && outputTokens === undefined) {
      return {};
    }
    const estimate = estimateModelCost(
      model,
      {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      },
      this.pricingCatalog,
    );
    if (estimate.status === "unavailable") {
      return { costStatus: "unavailable" };
    }
    return { costStatus: "available", estimatedCost: estimate.amount };
  }

  private persistInputFields(request: MasterRunRequest): Pick<CreateMasterRunInput, "trigger" | "context"> {
    return {
      ...(request.trigger !== undefined ? { trigger: request.trigger } : {}),
      ...(request.context !== undefined ? { context: request.context } : {}),
    };
  }

  private async persistBlockedRun(
    request: MasterRunRequest,
    rationale: string,
    reasons: readonly string[],
    model: string,
  ): Promise<MasterRun> {
    const run = await this.store.createMasterRun({
      id: this.ids.next("mrun"),
      projectId: request.projectId,
      proposedAction: "BLOCKED",
      enforcedAction: "BLOCKED",
      rationale,
      finishedBlockedReasons: reasons,
      createdTaskIds: [],
      promptVersion: MASTER_PROMPT_VERSION,
      model,
      status: "blocked",
      ...this.persistInputFields(request),
    });
    await this.store.updateMasterPhase(request.projectId, "paused");
    await this.enqueueDecision(run);
    return run;
  }

  private async persistRejectedRun(
    request: MasterRunRequest,
    rationale: string,
    model: string,
    inputTokens?: number,
    outputTokens?: number,
    cachedInputTokens?: number,
  ): Promise<MasterRun> {
    const run = await this.store.createMasterRun({
      id: this.ids.next("mrun"),
      projectId: request.projectId,
      proposedAction: "BLOCKED",
      enforcedAction: "BLOCKED",
      rationale,
      finishedBlockedReasons: ["model_output_invalid"],
      createdTaskIds: [],
      promptVersion: MASTER_PROMPT_VERSION,
      model,
      status: "rejected",
      ...this.persistInputFields(request),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...this.costFields(model, inputTokens, outputTokens, cachedInputTokens),
    });
    await this.store.updateMasterPhase(request.projectId, "paused");
    await this.enqueueDecision(run);
    return run;
  }

  private async persistFailedRun(
    request: MasterRunRequest,
    rationale: string,
    model: string,
  ): Promise<MasterRun> {
    const run = await this.store.createMasterRun({
      id: this.ids.next("mrun"),
      projectId: request.projectId,
      proposedAction: "BLOCKED",
      enforcedAction: "BLOCKED",
      rationale,
      finishedBlockedReasons: ["model_request_failed"],
      createdTaskIds: [],
      promptVersion: MASTER_PROMPT_VERSION,
      model,
      status: "failed",
      ...this.persistInputFields(request),
    });
    await this.store.updateMasterPhase(request.projectId, "failed");
    await this.enqueueDecision(run);
    return run;
  }

  private async enqueueDecision(run: MasterRun): Promise<void> {
    const kind = run.enforcedAction === "BLOCKED" && run.finishedBlockedReasons.includes("hard_limit_exceeded")
      ? "budget_alert"
      : run.enforcedAction === "BLOCKED" && run.finishedBlockedReasons.includes("budget_unavailable")
        ? "budget_alert"
        : "master_decision";
    await this.store.enqueueMasterInboxItem({
      id: this.ids.next("in"),
      projectId: run.projectId,
      kind,
      subject: `Master ${run.enforcedAction}`,
      body:
        run.finishedBlockedReasons.length > 0
          ? `${run.rationale} reasons=${run.finishedBlockedReasons.join(",")}`
          : run.rationale,
      relatedEntityId: run.id,
    });
  }
}

export function createMasterOrchestrator(options: MasterOrchestratorOptions): MasterOrchestrator {
  return new MasterOrchestrator(options);
}

import type {
  BudgetCategory,
  BudgetCheckResult,
  BudgetEntry,
  BudgetLedger,
  CreateBudgetEntryInput,
  CreateDefinitionOfDoneInput,
  CreateDeploymentInput,
  CreateEvidenceInput,
  CreateGitRevisionInput,
  CreateMasterInboxItemInput,
  CreatePermissionRequestInput,
  CreateProjectInput,
  CreateRequirementInput,
  CreateTaskDependencyInput,
  CreateTaskInput,
  CreateTestCaseInput,
  CreateTestResultInput,
  CreateVerifierRunInput,
  CreateWorkerEventInput,
  CreateWorkerReportInput,
  CreateWorkerRunInput,
  DecidePermissionInput,
  CompleteVerifierRunInput,
  DefinitionOfDone,
  Deployment,
  EntityId,
  Evidence,
  FinalAcceptanceRun,
  GitRevision,
  InitializeBudgetLedgerInput,
  MasterInboxItem,
  MasterState,
  Permission,
  PermissionRequest,
  Project,
  Requirement,
  Task,
  TaskDependency,
  TestCase,
  TestResult,
  VerifierRun,
  WorkerEvent,
  WorkerReport,
  WorkerRun,
} from "../domain/index.js";
import { createTimestamps, nowIso, touchTimestamps, withStatus } from "../domain/common.js";
import type { StateStore } from "./store.js";

function sumUsage(entries: readonly BudgetEntry[], category: BudgetCategory): number {
  return entries
    .filter((e) => e.category === category)
    .reduce((sum, e) => sum + e.amount, 0);
}

export class InMemoryStateStore implements StateStore {
  private readonly projects = new Map<EntityId, Project>();
  private readonly requirements = new Map<EntityId, Requirement>();
  private readonly definitionsOfDone = new Map<EntityId, DefinitionOfDone>();
  private readonly tasks = new Map<EntityId, Task>();
  private readonly taskDependencies = new Map<EntityId, TaskDependency[]>();
  private readonly workerRuns = new Map<EntityId, WorkerRun>();
  private readonly workerEvents = new Map<EntityId, WorkerEvent[]>();
  private readonly workerReports = new Map<EntityId, WorkerReport>();
  private readonly testCases = new Map<EntityId, TestCase>();
  private readonly testResults = new Map<EntityId, TestResult[]>();
  private readonly evidence = new Map<EntityId, Evidence>();
  private readonly permissionRequests = new Map<EntityId, PermissionRequest>();
  private readonly permissions = new Map<EntityId, Permission>();
  private readonly gitRevisions = new Map<EntityId, GitRevision>();
  private readonly deployments = new Map<EntityId, Deployment>();
  private readonly verifierRuns = new Map<EntityId, VerifierRun>();
  private readonly masterStates = new Map<EntityId, MasterState>();
  private readonly masterInbox = new Map<EntityId, MasterInboxItem[]>();
  private readonly finalAcceptanceRuns = new Map<EntityId, FinalAcceptanceRun>();
  private readonly budgetLedgers = new Map<EntityId, BudgetLedger>();

  createProject(input: CreateProjectInput): Project {
    const ts = createTimestamps();
    const project: Project = {
      id: input.id,
      name: input.name,
      description: input.description,
      ...ts,
      ...withStatus("active"),
    };
    this.projects.set(project.id, project);
    return project;
  }

  getProject(id: EntityId): Project | undefined {
    return this.projects.get(id);
  }

  listProjects(): readonly Project[] {
    return [...this.projects.values()];
  }

  createRequirement(input: CreateRequirementInput): Requirement {
    const ts = createTimestamps();
    const requirement: Requirement = {
      id: input.id,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      priority: input.priority ?? 0,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...ts,
      ...withStatus("draft"),
    };
    this.requirements.set(requirement.id, requirement);
    return requirement;
  }

  getRequirement(id: EntityId): Requirement | undefined {
    return this.requirements.get(id);
  }

  listRequirementsByProject(projectId: EntityId): readonly Requirement[] {
    return [...this.requirements.values()].filter((r) => r.projectId === projectId);
  }

  createDefinitionOfDone(input: CreateDefinitionOfDoneInput): DefinitionOfDone {
    const dod: DefinitionOfDone = {
      id: input.id,
      projectId: input.projectId,
      version: input.version,
      criteria: input.criteria,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...createTimestamps(),
    };
    this.definitionsOfDone.set(dod.id, dod);
    return dod;
  }

  getDefinitionOfDone(id: EntityId): DefinitionOfDone | undefined {
    return this.definitionsOfDone.get(id);
  }

  createTask(input: CreateTaskInput): Task {
    const ts = createTimestamps();
    const task: Task = {
      id: input.id,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      kind: input.kind,
      dependencyIds: input.dependencyIds ?? [],
      ...ts,
      ...withStatus("pending"),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(id: EntityId): Task | undefined {
    return this.tasks.get(id);
  }

  listTasksByProject(projectId: EntityId): readonly Task[] {
    return [...this.tasks.values()].filter((t) => t.projectId === projectId);
  }

  updateTaskStatus(taskId: EntityId, status: Task["status"]): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const updated: Task = {
      ...task,
      ...withStatus(status),
      ...touchTimestamps(task),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  addTaskDependency(input: CreateTaskDependencyInput): TaskDependency {
    const dep: TaskDependency = {
      taskId: input.taskId,
      dependsOnTaskId: input.dependsOnTaskId,
      createdAt: nowIso(),
    };
    const existing = this.taskDependencies.get(input.taskId) ?? [];
    this.taskDependencies.set(input.taskId, [...existing, dep]);
    return dep;
  }

  listTaskDependencies(taskId: EntityId): readonly TaskDependency[] {
    return this.taskDependencies.get(taskId) ?? [];
  }

  createWorkerRun(input: CreateWorkerRunInput): WorkerRun {
    const ts = createTimestamps();
    const run: WorkerRun = {
      id: input.id,
      projectId: input.projectId,
      taskId: input.taskId,
      workerKind: input.workerKind,
      iteration: input.iteration ?? 1,
      ...ts,
      ...withStatus("queued"),
    };
    this.workerRuns.set(run.id, run);
    return run;
  }

  getWorkerRun(id: EntityId): WorkerRun | undefined {
    return this.workerRuns.get(id);
  }

  updateWorkerRunStatus(
    workerRunId: EntityId,
    status: WorkerRun["status"],
    errorMessage?: string,
  ): WorkerRun {
    const run = this.workerRuns.get(workerRunId);
    if (!run) {
      throw new Error(`WorkerRun not found: ${workerRunId}`);
    }
    const at = nowIso();
    const updated: WorkerRun = {
      ...run,
      ...withStatus(status, at),
      ...touchTimestamps(run, at),
      ...(status === "running" ? { startedAt: at } : {}),
      ...(status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out"
        ? { completedAt: at }
        : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
    this.workerRuns.set(workerRunId, updated);
    return updated;
  }

  appendWorkerEvent(input: CreateWorkerEventInput): WorkerEvent {
    const event: WorkerEvent = {
      id: input.id,
      projectId: input.projectId,
      taskId: input.taskId,
      workerRunId: input.workerRunId,
      eventType: input.eventType,
      message: input.message,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...createTimestamps(),
    };
    const existing = this.workerEvents.get(input.workerRunId) ?? [];
    this.workerEvents.set(input.workerRunId, [...existing, event]);
    return event;
  }

  listWorkerEvents(workerRunId: EntityId): readonly WorkerEvent[] {
    return this.workerEvents.get(workerRunId) ?? [];
  }

  createWorkerReport(input: CreateWorkerReportInput): WorkerReport {
    const report: WorkerReport = {
      id: input.id,
      projectId: input.projectId,
      taskId: input.taskId,
      workerRunId: input.workerRunId,
      summary: input.summary,
      outcome: input.outcome,
      ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
      ...createTimestamps(),
    };
    this.workerReports.set(report.id, report);
    return report;
  }

  getWorkerReport(id: EntityId): WorkerReport | undefined {
    return this.workerReports.get(id);
  }

  createTestCase(input: CreateTestCaseInput): TestCase {
    const testCase: TestCase = {
      id: input.id,
      projectId: input.projectId,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      name: input.name,
      description: input.description,
      kind: input.kind,
      ...createTimestamps(),
      ...withStatus("active"),
    };
    this.testCases.set(testCase.id, testCase);
    return testCase;
  }

  getTestCase(id: EntityId): TestCase | undefined {
    return this.testCases.get(id);
  }

  recordTestResult(input: CreateTestResultInput): TestResult {
    const result: TestResult = {
      id: input.id,
      projectId: input.projectId,
      testCaseId: input.testCaseId,
      outcome: input.outcome,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workerRunId !== undefined ? { workerRunId: input.workerRunId } : {}),
      ...(input.verifierRunId !== undefined ? { verifierRunId: input.verifierRunId } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...createTimestamps(),
    };
    const existing = this.testResults.get(input.testCaseId) ?? [];
    this.testResults.set(input.testCaseId, [...existing, result]);
    return result;
  }

  listTestResultsByCase(testCaseId: EntityId): readonly TestResult[] {
    return this.testResults.get(testCaseId) ?? [];
  }

  createEvidence(input: CreateEvidenceInput): Evidence {
    const item: Evidence = {
      id: input.id,
      projectId: input.projectId,
      kind: input.kind,
      label: input.label,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workerRunId !== undefined ? { workerRunId: input.workerRunId } : {}),
      ...(input.verifierRunId !== undefined ? { verifierRunId: input.verifierRunId } : {}),
      ...(input.gitRevisionId !== undefined ? { gitRevisionId: input.gitRevisionId } : {}),
      ...(input.deploymentId !== undefined ? { deploymentId: input.deploymentId } : {}),
      ...(input.uri !== undefined ? { uri: input.uri } : {}),
      ...(input.contentRef !== undefined ? { contentRef: input.contentRef } : {}),
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...createTimestamps(),
    };
    this.evidence.set(item.id, item);
    return item;
  }

  getEvidence(id: EntityId): Evidence | undefined {
    return this.evidence.get(id);
  }

  listEvidenceByTask(taskId: EntityId): readonly Evidence[] {
    return [...this.evidence.values()].filter((e) => e.taskId === taskId);
  }

  createPermissionRequest(input: CreatePermissionRequestInput): PermissionRequest {
    const request: PermissionRequest = {
      id: input.id,
      projectId: input.projectId,
      scope: input.scope,
      action: input.action,
      resource: input.resource,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workerRunId !== undefined ? { workerRunId: input.workerRunId } : {}),
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...createTimestamps(),
    };
    this.permissionRequests.set(request.id, request);

    const permission: Permission = {
      id: `perm-${input.id}`,
      projectId: input.projectId,
      requestId: request.id,
      decision: "escalate",
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workerRunId !== undefined ? { workerRunId: input.workerRunId } : {}),
      ...createTimestamps(),
      ...withStatus("pending"),
    };
    this.permissions.set(permission.id, permission);
    return request;
  }

  decidePermission(input: DecidePermissionInput): Permission {
    const permission = this.permissions.get(input.permissionId);
    if (!permission) {
      throw new Error(`Permission not found: ${input.permissionId}`);
    }
    const at = nowIso();
    const updated: Permission = {
      ...permission,
      decision: input.decision,
      ...(input.decidedBy !== undefined ? { decidedBy: input.decidedBy } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...withStatus("decided", at),
      ...touchTimestamps(permission, at),
    };
    this.permissions.set(input.permissionId, updated);
    return updated;
  }

  getPermission(id: EntityId): Permission | undefined {
    return this.permissions.get(id);
  }

  createGitRevision(input: CreateGitRevisionInput): GitRevision {
    const revision: GitRevision = {
      id: input.id,
      projectId: input.projectId,
      commitSha: input.commitSha,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      ...(input.tag !== undefined ? { tag: input.tag } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.authoredAt !== undefined ? { authoredAt: input.authoredAt } : {}),
      ...createTimestamps(),
    };
    this.gitRevisions.set(revision.id, revision);
    return revision;
  }

  getGitRevision(id: EntityId): GitRevision | undefined {
    return this.gitRevisions.get(id);
  }

  createDeployment(input: CreateDeploymentInput): Deployment {
    const at = nowIso();
    const deployment: Deployment = {
      id: input.id,
      projectId: input.projectId,
      gitRevisionId: input.gitRevisionId,
      environment: input.environment,
      status: "pending",
      statusChangedAt: at,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...createTimestamps(at),
    };
    this.deployments.set(deployment.id, deployment);
    return deployment;
  }

  getDeployment(id: EntityId): Deployment | undefined {
    return this.deployments.get(id);
  }

  updateDeploymentStatus(deploymentId: EntityId, status: Deployment["status"]): Deployment {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`);
    }
    const at = nowIso();
    const updated: Deployment = {
      ...deployment,
      status,
      statusChangedAt: at,
      ...touchTimestamps(deployment, at),
    };
    this.deployments.set(deploymentId, updated);
    return updated;
  }

  createVerifierRun(input: CreateVerifierRunInput): VerifierRun {
    const run: VerifierRun = {
      id: input.id,
      projectId: input.projectId,
      taskId: input.taskId,
      evidenceIds: [],
      ...createTimestamps(),
      ...withStatus("pending"),
    };
    this.verifierRuns.set(run.id, run);
    return run;
  }

  completeVerifierRun(input: CompleteVerifierRunInput): VerifierRun {
    const run = this.verifierRuns.get(input.verifierRunId);
    if (!run) {
      throw new Error(`VerifierRun not found: ${input.verifierRunId}`);
    }
    const at = nowIso();
    const updated: VerifierRun = {
      ...run,
      outcome: input.outcome,
      evidenceIds: input.evidenceIds ?? run.evidenceIds,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      startedAt: run.startedAt ?? at,
      completedAt: at,
      ...withStatus("completed", at),
      ...touchTimestamps(run, at),
    };
    this.verifierRuns.set(input.verifierRunId, updated);
    return updated;
  }

  getVerifierRun(id: EntityId): VerifierRun | undefined {
    return this.verifierRuns.get(id);
  }

  getOrCreateMasterState(projectId: EntityId): MasterState {
    const existing = this.masterStates.get(projectId);
    if (existing) {
      return existing;
    }
    const state: MasterState = {
      projectId,
      activeTaskIds: [],
      inboxItemIds: [],
      ...createTimestamps(),
      ...withStatus("initializing"),
    };
    this.masterStates.set(projectId, state);
    this.masterInbox.set(projectId, []);
    return state;
  }

  updateMasterPhase(projectId: EntityId, phase: MasterState["status"]): MasterState {
    const state = this.getOrCreateMasterState(projectId);
    const at = nowIso();
    const updated: MasterState = {
      ...state,
      ...withStatus(phase, at),
      lastDirectorActionAt: at,
      ...touchTimestamps(state, at),
    };
    this.masterStates.set(projectId, updated);
    return updated;
  }

  enqueueMasterInboxItem(input: CreateMasterInboxItemInput): MasterInboxItem {
    const item: MasterInboxItem = {
      id: input.id,
      projectId: input.projectId,
      kind: input.kind,
      subject: input.subject,
      body: input.body,
      receivedAt: nowIso(),
      ...(input.relatedEntityId !== undefined ? { relatedEntityId: input.relatedEntityId } : {}),
      ...createTimestamps(),
      ...withStatus("unread"),
    };
    const inbox = this.masterInbox.get(input.projectId) ?? [];
    this.masterInbox.set(input.projectId, [...inbox, item]);

    const state = this.getOrCreateMasterState(input.projectId);
    const updatedState: MasterState = {
      ...state,
      inboxItemIds: [...state.inboxItemIds, item.id],
      ...touchTimestamps(state),
    };
    this.masterStates.set(input.projectId, updatedState);
    return item;
  }

  listMasterInbox(projectId: EntityId): readonly MasterInboxItem[] {
    return this.masterInbox.get(projectId) ?? [];
  }

  createFinalAcceptanceRun(
    id: EntityId,
    projectId: EntityId,
    definitionOfDoneId: EntityId,
  ): FinalAcceptanceRun {
    const run: FinalAcceptanceRun = {
      id,
      projectId,
      definitionOfDoneId,
      ...createTimestamps(),
      ...withStatus("pending"),
    };
    this.finalAcceptanceRuns.set(id, run);
    return run;
  }

  initializeBudgetLedger(input: InitializeBudgetLedgerInput): BudgetLedger {
    const ledger: BudgetLedger = {
      projectId: input.projectId,
      limits: input.limits,
      entries: [],
      ...createTimestamps(input.at),
    };
    this.budgetLedgers.set(input.projectId, ledger);
    return ledger;
  }

  getBudgetLedger(projectId: EntityId): BudgetLedger | undefined {
    return this.budgetLedgers.get(projectId);
  }

  recordBudgetEntry(input: CreateBudgetEntryInput): BudgetEntry {
    const ledger = this.budgetLedgers.get(input.projectId);
    if (!ledger) {
      throw new Error(`BudgetLedger not found for project: ${input.projectId}`);
    }
    const entry: BudgetEntry = {
      id: input.id,
      projectId: input.projectId,
      category: input.category,
      amount: input.amount,
      unit: input.unit,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workerRunId !== undefined ? { workerRunId: input.workerRunId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...createTimestamps(),
    };
    const updated: BudgetLedger = {
      ...ledger,
      entries: [...ledger.entries, entry],
      ...touchTimestamps(ledger),
    };
    this.budgetLedgers.set(input.projectId, updated);
    return entry;
  }

  checkBudget(projectId: EntityId, category: BudgetCategory): BudgetCheckResult {
    const ledger = this.budgetLedgers.get(projectId);
    if (!ledger) {
      throw new Error(`BudgetLedger not found for project: ${projectId}`);
    }

    const usage = sumUsage(ledger.entries, category);
    const limits = ledger.limits.filter((l) => l.category === category);

    const hard = limits.find((l) => l.kind === "hard");
    if (hard && usage >= hard.maxAmount) {
      return {
        allowed: false,
        reason: "hard_limit_exceeded",
        limit: hard,
        currentUsage: usage,
      };
    }

    const soft = limits.find((l) => l.kind === "soft");
    if (soft && usage >= soft.maxAmount) {
      return {
        allowed: false,
        reason: "soft_limit_exceeded",
        limit: soft,
        currentUsage: usage,
      };
    }

    const effectiveLimit = hard ?? soft;
    const remaining = effectiveLimit ? effectiveLimit.maxAmount - usage : Number.POSITIVE_INFINITY;
    return { allowed: true, remaining };
  }
}

export function createInMemoryStateStore(): StateStore {
  return new InMemoryStateStore();
}

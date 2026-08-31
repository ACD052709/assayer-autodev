import type {
  AcceptanceCriterion,
  Blocker,
  BudgetCategory,
  BudgetCheckResult,
  BudgetEntry,
  BudgetLedger,
  CreateAcceptanceCriterionInput,
  CreateBlockerInput,
  CreateBudgetEntryInput,
  AddBudgetResourceInput,
  CreateDefinitionOfDoneInput,
  CreateDeploymentInput,
  CreateEvidenceInput,
  CreateGitRevisionInput,
  CreateMasterInboxItemInput,
  CreateMasterRunInput,
  CreatePermissionRequestInput,
  CreateProjectInput,
  UpdateProjectWorkerTargetInput,
  CreateReleaseContractInput,
  CreateRequirementInput,
  CreateTaskDependencyInput,
  CreateTaskInput,
  CreateTestCaseInput,
  CreateTestResultInput,
  CreateVerifierRunInput,
  AssignTaskToWorkerRunInput,
  ApplyWorkerRunTaskTransitionInput,
  ClaimQueuedWorkerRunInput,
  ClaimQueuedWorkerRunResult,
  HeartbeatWorkerRunInput,
  HeartbeatWorkerRunResult,
  RequeueTimedOutWorkerRunInput,
  VerifyWorkerRunLeaseResult,
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
  MasterRun,
  MasterState,
  Permission,
  PermissionRequest,
  Project,
  ReleaseContract,
  Requirement,
  Task,
  TaskDependency,
  TaskWorkerAssignment,
  TestCase,
  TestResult,
  UpdateAcceptanceCriterionInput,
  VerifierRun,
  WorkerEvent,
  WorkerReport,
  WorkerRun,
  WorkerRunTaskTransitionResult,
} from "../domain/index.js";
import { createTimestamps, nowIso, touchTimestamps, withStatus } from "../domain/common.js";
import { isTerminalWorkerRunStatus } from "../domain/worker.js";
import { isLeaseExpired, timingSafeEqual } from "../executor/lease.js";
import {
  BudgetResourceConflictError,
  limitsForBudgetResource,
} from "../domain/budget.js";
import { interpretStoredCost } from "../master/pricing.js";
import type { StateStore } from "./store.js";

function sumUsage(entries: readonly BudgetEntry[], category: BudgetCategory): number {
  return entries
    .filter((e) => e.category === category)
    .reduce((sum, e) => sum + e.amount, 0);
}

function compareWorkerRuns(a: WorkerRun, b: WorkerRun): number {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}

function withoutLeaseExpiry(run: WorkerRun): WorkerRun {
  const { leaseExpiresAt: _removed, ...rest } = run;
  return rest;
}

function isNonterminalWorkerRunStatus(status: WorkerRun["status"]): boolean {
  return status === "queued" || status === "running";
}

export class InMemoryStateStore implements StateStore {
  private readonly projects = new Map<EntityId, Project>();
  private readonly requirements = new Map<EntityId, Requirement>();
  private readonly definitionsOfDone = new Map<EntityId, DefinitionOfDone>();
  private readonly tasks = new Map<EntityId, Task>();
  private readonly taskDependencies = new Map<EntityId, TaskDependency[]>();
  private readonly workerRuns = new Map<EntityId, WorkerRun>();
  private readonly leaseTokenHashes = new Map<EntityId, string>();
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
  private readonly releaseContracts = new Map<EntityId, ReleaseContract>();
  private readonly acceptanceCriteria = new Map<EntityId, AcceptanceCriterion>();
  private readonly blockers = new Map<EntityId, Blocker>();
  private readonly masterRuns = new Map<EntityId, MasterRun>();

  createProject(input: CreateProjectInput): Project {
    const ts = createTimestamps();
    const project: Project = {
      id: input.id,
      name: input.name,
      description: input.description,
      doNotModifyConstraints: [...(input.doNotModifyConstraints ?? [])],
      ...(input.targetRepository !== undefined ? { targetRepository: input.targetRepository } : {}),
      ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
      ...(input.targetTestCommand !== undefined ? { targetTestCommand: input.targetTestCommand } : {}),
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

  updateProjectWorkerTarget(input: UpdateProjectWorkerTargetInput): Project {
    const existing = this.projects.get(input.projectId);
    if (existing === undefined) {
      throw new Error(`Project not found: ${input.projectId}`);
    }
    const updated: Project = {
      ...existing,
      ...(input.targetRepository !== undefined ? { targetRepository: input.targetRepository } : {}),
      ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
      ...(input.targetTestCommand !== undefined ? { targetTestCommand: input.targetTestCommand } : {}),
      ...(input.doNotModifyConstraints !== undefined
        ? { doNotModifyConstraints: [...input.doNotModifyConstraints] }
        : {}),
      ...touchTimestamps(existing),
    };
    this.projects.set(input.projectId, updated);
    return updated;
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

  listDefinitionsOfDoneByProject(projectId: EntityId): readonly DefinitionOfDone[] {
    return [...this.definitionsOfDone.values()].filter((d) => d.projectId === projectId);
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

  listWorkerRunsByProject(projectId: EntityId): readonly WorkerRun[] {
    return [...this.workerRuns.values()]
      .filter((run) => run.projectId === projectId)
      .sort(compareWorkerRuns);
  }

  assignTaskToWorkerRun(input: AssignTaskToWorkerRunInput): TaskWorkerAssignment | undefined {
    const task = this.tasks.get(input.taskId);
    if (task === undefined || task.projectId !== input.projectId) {
      return undefined;
    }
    if (task.assignedWorkerRunId !== undefined) {
      const existing = this.workerRuns.get(task.assignedWorkerRunId);
      if (existing === undefined) {
        return undefined;
      }
      return { task, workerRun: existing, created: false };
    }
    if (task.status !== "pending" && task.status !== "ready") {
      return undefined;
    }

    const existingForTask = [...this.workerRuns.values()].filter((run) => run.taskId === task.id);
    const workerRun = this.createWorkerRun({
      id: input.id,
      projectId: input.projectId,
      taskId: input.taskId,
      workerKind: input.workerKind,
      iteration: input.iteration ?? existingForTask.length + 1,
    });
    const at = nowIso();
    const updated: Task = {
      ...task,
      assignedWorkerRunId: workerRun.id,
      ...withStatus("assigned", at),
      ...touchTimestamps(task, at),
    };
    this.tasks.set(task.id, updated);
    return { task: updated, workerRun, created: true };
  }

  applyWorkerRunTaskTransition(
    input: ApplyWorkerRunTaskTransitionInput,
  ): WorkerRunTaskTransitionResult {
    const run = this.workerRuns.get(input.workerRunId);
    if (run === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (run.taskId === undefined) {
      return { ok: false, reason: "inconsistent" };
    }
    const task = this.tasks.get(run.taskId);
    if (task === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (task.projectId !== run.projectId || task.assignedWorkerRunId !== run.id) {
      return { ok: false, reason: "inconsistent" };
    }
    if (run.status === input.toRunStatus) {
      if (task.status !== input.toTaskStatus) {
        return { ok: false, reason: "inconsistent" };
      }
      return { ok: true, applied: false, task, workerRun: run };
    }
    if (
      !input.fromRunStatuses.includes(run.status) ||
      !input.fromTaskStatuses.includes(task.status)
    ) {
      return { ok: false, reason: "illegal_transition" };
    }
    if (input.leaseTokenHash !== undefined) {
      const storedHash = this.leaseTokenHashes.get(run.id);
      const now = input.now ?? nowIso();
      if (storedHash === undefined || !timingSafeEqual(storedHash, input.leaseTokenHash)) {
        return { ok: false, reason: "unauthorized" };
      }
      if (isLeaseExpired(run.leaseExpiresAt, now)) {
        return { ok: false, reason: "expired" };
      }
    }

    const at = input.at ?? nowIso();
    if (isTerminalWorkerRunStatus(input.toRunStatus)) {
      this.leaseTokenHashes.delete(run.id);
    }
    const updatedRun: WorkerRun = {
      ...run,
      ...withStatus(input.toRunStatus, at),
      ...touchTimestamps(run, at),
      ...(input.toRunStatus === "running" ? { startedAt: run.startedAt ?? at } : {}),
      ...(isTerminalWorkerRunStatus(input.toRunStatus) ? { completedAt: run.completedAt ?? at } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    };
    const storedRun =
      isTerminalWorkerRunStatus(input.toRunStatus) && input.toRunStatus !== "timed_out"
        ? withoutLeaseExpiry(updatedRun)
        : updatedRun;
    const updatedTask: Task = {
      ...task,
      ...withStatus(input.toTaskStatus, at),
      ...touchTimestamps(task, at),
    };
    this.workerRuns.set(run.id, storedRun);
    this.tasks.set(task.id, updatedTask);
    return { ok: true, applied: true, task: updatedTask, workerRun: storedRun };
  }

  claimQueuedWorkerRun(input: ClaimQueuedWorkerRunInput): ClaimQueuedWorkerRunResult {
    const run = this.workerRuns.get(input.workerRunId);
    if (run === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (run.taskId === undefined) {
      return { ok: false, reason: "inconsistent" };
    }
    const task = this.tasks.get(run.taskId);
    if (task === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (task.projectId !== run.projectId || task.assignedWorkerRunId !== run.id) {
      return { ok: false, reason: "inconsistent" };
    }
    if (run.status === "running") {
      return { ok: false, reason: "already_claimed" };
    }
    if (run.status !== "queued" || task.status !== "assigned") {
      return { ok: false, reason: "illegal_transition" };
    }

    const at = input.at;
    const updatedRun: WorkerRun = {
      ...run,
      ...withStatus("running", at),
      ...touchTimestamps(run, at),
      startedAt: run.startedAt ?? at,
      ownerId: input.ownerId,
      lastHeartbeatAt: input.lastHeartbeatAt,
      leaseExpiresAt: input.leaseExpiresAt,
    };
    const updatedTask: Task = {
      ...task,
      ...withStatus("in_progress", at),
      ...touchTimestamps(task, at),
    };
    this.leaseTokenHashes.set(run.id, input.leaseTokenHash);
    this.workerRuns.set(run.id, updatedRun);
    this.tasks.set(task.id, updatedTask);
    return { ok: true, task: updatedTask, workerRun: updatedRun };
  }

  heartbeatWorkerRun(input: HeartbeatWorkerRunInput): HeartbeatWorkerRunResult {
    const run = this.workerRuns.get(input.workerRunId);
    if (run === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (run.status !== "running") {
      return { ok: false, reason: "illegal_transition" };
    }
    const storedHash = this.leaseTokenHashes.get(run.id);
    if (storedHash === undefined || !timingSafeEqual(storedHash, input.leaseTokenHash)) {
      return { ok: false, reason: "unauthorized" };
    }
    if (isLeaseExpired(run.leaseExpiresAt, input.now)) {
      return { ok: false, reason: "expired" };
    }
    const updated: WorkerRun = {
      ...run,
      lastHeartbeatAt: input.lastHeartbeatAt,
      leaseExpiresAt: input.leaseExpiresAt,
      ...touchTimestamps(run, input.lastHeartbeatAt),
    };
    this.workerRuns.set(run.id, updated);
    return { ok: true, workerRun: updated };
  }

  verifyWorkerRunLease(
    workerRunId: EntityId,
    leaseTokenHash: string,
    now: string,
  ): VerifyWorkerRunLeaseResult {
    const run = this.workerRuns.get(workerRunId);
    if (run === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (run.status !== "running") {
      return { ok: false, reason: "illegal_transition" };
    }
    const storedHash = this.leaseTokenHashes.get(workerRunId);
    if (storedHash === undefined || !timingSafeEqual(storedHash, leaseTokenHash)) {
      return { ok: false, reason: "unauthorized" };
    }
    if (isLeaseExpired(run.leaseExpiresAt, now)) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true };
  }

  listExpiredRunningWorkerRuns(projectId: EntityId, now: string): readonly WorkerRun[] {
    return [...this.workerRuns.values()]
      .filter(
        (run) =>
          run.projectId === projectId &&
          run.status === "running" &&
          isLeaseExpired(run.leaseExpiresAt, now),
      )
      .sort(compareWorkerRuns);
  }

  requeueTimedOutWorkerRun(input: RequeueTimedOutWorkerRunInput): TaskWorkerAssignment | undefined {
    const previous = this.workerRuns.get(input.previousWorkerRunId);
    if (previous === undefined || previous.projectId !== input.projectId) {
      return undefined;
    }
    if (previous.status !== "timed_out" || previous.taskId === undefined) {
      return undefined;
    }
    const task = this.tasks.get(previous.taskId);
    if (task === undefined || task.projectId !== input.projectId) {
      return undefined;
    }
    if (task.assignedWorkerRunId !== previous.id || task.status !== "failed") {
      return undefined;
    }
    const active = [...this.workerRuns.values()].some(
      (run) => run.taskId === task.id && isNonterminalWorkerRunStatus(run.status),
    );
    if (active || this.workerRuns.has(input.newWorkerRunId)) {
      return undefined;
    }

    const at = input.at ?? nowIso();
    const workerRun: WorkerRun = {
      id: input.newWorkerRunId,
      projectId: input.projectId,
      taskId: task.id,
      workerKind: previous.workerKind,
      iteration: previous.iteration + 1,
      ...createTimestamps(at),
      ...withStatus("queued", at),
    };
    const updatedTask: Task = {
      ...task,
      assignedWorkerRunId: workerRun.id,
      ...withStatus("assigned", at),
      ...touchTimestamps(task, at),
    };
    this.workerRuns.set(workerRun.id, workerRun);
    this.tasks.set(task.id, updatedTask);
    return { task: updatedTask, workerRun, created: true };
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

  getWorkerReportByWorkerRunId(workerRunId: EntityId): WorkerReport | undefined {
    return [...this.workerReports.values()]
      .filter((report) => report.workerRunId === workerRunId)
      .sort((a, b) => {
        const byTime = a.createdAt.localeCompare(b.createdAt);
        return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
      })[0];
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

  listTestCasesByProject(projectId: EntityId): readonly TestCase[] {
    return [...this.testCases.values()].filter((t) => t.projectId === projectId);
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

  listTestResultsByProject(projectId: EntityId): readonly TestResult[] {
    return [...this.testResults.values()].flat().filter((r) => r.projectId === projectId);
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

  listEvidenceByProject(projectId: EntityId): readonly Evidence[] {
    return [...this.evidence.values()].filter((e) => e.projectId === projectId);
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

  listVerifierRunsByProject(projectId: EntityId): readonly VerifierRun[] {
    return [...this.verifierRuns.values()].filter((r) => r.projectId === projectId);
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
    if (!this.masterInbox.has(projectId)) {
      this.masterInbox.set(projectId, []);
    }
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

  setMasterActiveTaskIds(projectId: EntityId, activeTaskIds: readonly EntityId[]): MasterState {
    const state = this.getOrCreateMasterState(projectId);
    const updated: MasterState = {
      ...state,
      activeTaskIds: [...activeTaskIds],
      ...touchTimestamps(state),
    };
    this.masterStates.set(projectId, updated);
    return updated;
  }

  enqueueMasterInboxItem(input: CreateMasterInboxItemInput): MasterInboxItem {
    this.getOrCreateMasterState(input.projectId);
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

  addBudgetResource(input: AddBudgetResourceInput): BudgetLedger {
    const existing = this.budgetLedgers.get(input.projectId);
    if (existing === undefined) {
      return this.initializeBudgetLedger({
        projectId: input.projectId,
        limits: limitsForBudgetResource(input),
      });
    }
    if (existing.limits.some((limit) => limit.category === input.resourceType)) {
      throw new BudgetResourceConflictError(input.resourceType);
    }
    const updated: BudgetLedger = {
      ...existing,
      limits: [...existing.limits, ...limitsForBudgetResource(input)],
      ...touchTimestamps(existing),
    };
    this.budgetLedgers.set(input.projectId, updated);
    return updated;
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

  createReleaseContract(input: CreateReleaseContractInput): ReleaseContract {
    const contract: ReleaseContract = {
      id: input.id,
      projectId: input.projectId,
      version: input.version,
      requiredEvidenceKinds: input.requiredEvidenceKinds,
      requiredEvidenceLabels: input.requiredEvidenceLabels ?? [],
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...createTimestamps(),
    };
    this.releaseContracts.set(contract.id, contract);
    return contract;
  }

  getReleaseContract(id: EntityId): ReleaseContract | undefined {
    return this.releaseContracts.get(id);
  }

  getLatestReleaseContract(projectId: EntityId): ReleaseContract | undefined {
    return [...this.releaseContracts.values()]
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt))[0];
  }

  createAcceptanceCriterion(input: CreateAcceptanceCriterionInput): AcceptanceCriterion {
    const criterion: AcceptanceCriterion = {
      id: input.id,
      projectId: input.projectId,
      releaseContractId: input.releaseContractId,
      description: input.description,
      requirementIds: input.requirementIds ?? [],
      applicable: input.applicable ?? true,
      evidenceIds: [],
      ...createTimestamps(),
      ...withStatus("pending"),
    };
    this.acceptanceCriteria.set(criterion.id, criterion);
    return criterion;
  }

  updateAcceptanceCriterion(input: UpdateAcceptanceCriterionInput): AcceptanceCriterion {
    const existing = this.acceptanceCriteria.get(input.id);
    if (!existing) {
      throw new Error(`AcceptanceCriterion not found: ${input.id}`);
    }
    const updated: AcceptanceCriterion = {
      ...existing,
      ...withStatus(input.status),
      ...(input.evidenceIds !== undefined ? { evidenceIds: input.evidenceIds } : {}),
      ...touchTimestamps(existing),
    };
    this.acceptanceCriteria.set(input.id, updated);
    return updated;
  }

  listAcceptanceCriteriaByProject(projectId: EntityId): readonly AcceptanceCriterion[] {
    return [...this.acceptanceCriteria.values()].filter((c) => c.projectId === projectId);
  }

  createBlocker(input: CreateBlockerInput): Blocker {
    const blocker: Blocker = {
      id: input.id,
      projectId: input.projectId,
      kind: input.kind,
      summary: input.summary,
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.relatedEntityId !== undefined ? { relatedEntityId: input.relatedEntityId } : {}),
      ...createTimestamps(),
      ...withStatus("open"),
    };
    this.blockers.set(blocker.id, blocker);
    return blocker;
  }

  resolveBlocker(blockerId: EntityId): Blocker {
    const existing = this.blockers.get(blockerId);
    if (!existing) {
      throw new Error(`Blocker not found: ${blockerId}`);
    }
    const updated: Blocker = {
      ...existing,
      ...withStatus("resolved"),
      ...touchTimestamps(existing),
    };
    this.blockers.set(blockerId, updated);
    return updated;
  }

  listBlockersByProject(projectId: EntityId): readonly Blocker[] {
    return [...this.blockers.values()].filter((b) => b.projectId === projectId);
  }

  createMasterRun(input: CreateMasterRunInput): MasterRun {
    const run: MasterRun = {
      id: input.id,
      projectId: input.projectId,
      proposedAction: input.proposedAction,
      enforcedAction: input.enforcedAction,
      rationale: input.rationale,
      finishedBlockedReasons: input.finishedBlockedReasons ?? [],
      createdTaskIds: input.createdTaskIds ?? [],
      promptVersion: input.promptVersion,
      model: input.model,
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...interpretStoredCost({
        model: input.model,
        ...(input.estimatedCost !== undefined ? { estimatedCost: input.estimatedCost } : {}),
        ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
        ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      }),
      ...createTimestamps(),
      ...withStatus(input.status),
    };
    this.masterRuns.set(run.id, run);
    return run;
  }

  getMasterRun(id: EntityId): MasterRun | undefined {
    return this.masterRuns.get(id);
  }

  listMasterRunsByProject(projectId: EntityId): readonly MasterRun[] {
    return [...this.masterRuns.values()]
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export function createInMemoryStateStore(): StateStore {
  return new InMemoryStateStore();
}

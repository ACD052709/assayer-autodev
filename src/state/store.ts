import type {
  BudgetEntry,
  BudgetLedger,
  BudgetLimit,
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

/** Durable state access contract; in-memory implementation precedes Cloudflare D1. */
export interface StateStore {
  // Projects
  createProject(input: CreateProjectInput): Project;
  getProject(id: EntityId): Project | undefined;
  listProjects(): readonly Project[];

  // Requirements & DoD
  createRequirement(input: CreateRequirementInput): Requirement;
  getRequirement(id: EntityId): Requirement | undefined;
  listRequirementsByProject(projectId: EntityId): readonly Requirement[];

  createDefinitionOfDone(input: CreateDefinitionOfDoneInput): DefinitionOfDone;
  getDefinitionOfDone(id: EntityId): DefinitionOfDone | undefined;

  // Tasks
  createTask(input: CreateTaskInput): Task;
  getTask(id: EntityId): Task | undefined;
  listTasksByProject(projectId: EntityId): readonly Task[];
  updateTaskStatus(taskId: EntityId, status: Task["status"]): Task;

  addTaskDependency(input: CreateTaskDependencyInput): TaskDependency;
  listTaskDependencies(taskId: EntityId): readonly TaskDependency[];

  // Workers
  createWorkerRun(input: CreateWorkerRunInput): WorkerRun;
  getWorkerRun(id: EntityId): WorkerRun | undefined;
  updateWorkerRunStatus(
    workerRunId: EntityId,
    status: WorkerRun["status"],
    errorMessage?: string,
  ): WorkerRun;

  appendWorkerEvent(input: CreateWorkerEventInput): WorkerEvent;
  listWorkerEvents(workerRunId: EntityId): readonly WorkerEvent[];

  createWorkerReport(input: CreateWorkerReportInput): WorkerReport;
  getWorkerReport(id: EntityId): WorkerReport | undefined;

  // Tests
  createTestCase(input: CreateTestCaseInput): TestCase;
  getTestCase(id: EntityId): TestCase | undefined;

  recordTestResult(input: CreateTestResultInput): TestResult;
  listTestResultsByCase(testCaseId: EntityId): readonly TestResult[];

  // Evidence
  createEvidence(input: CreateEvidenceInput): Evidence;
  getEvidence(id: EntityId): Evidence | undefined;
  listEvidenceByTask(taskId: EntityId): readonly Evidence[];

  // Permissions
  createPermissionRequest(input: CreatePermissionRequestInput): PermissionRequest;
  decidePermission(input: DecidePermissionInput): Permission;
  getPermission(id: EntityId): Permission | undefined;

  // Git & deployment
  createGitRevision(input: CreateGitRevisionInput): GitRevision;
  getGitRevision(id: EntityId): GitRevision | undefined;

  createDeployment(input: CreateDeploymentInput): Deployment;
  getDeployment(id: EntityId): Deployment | undefined;
  updateDeploymentStatus(deploymentId: EntityId, status: Deployment["status"]): Deployment;

  // Verification
  createVerifierRun(input: CreateVerifierRunInput): VerifierRun;
  completeVerifierRun(input: CompleteVerifierRunInput): VerifierRun;
  getVerifierRun(id: EntityId): VerifierRun | undefined;

  // Master director
  getOrCreateMasterState(projectId: EntityId): MasterState;
  updateMasterPhase(projectId: EntityId, phase: MasterState["status"]): MasterState;
  enqueueMasterInboxItem(input: CreateMasterInboxItemInput): MasterInboxItem;
  listMasterInbox(projectId: EntityId): readonly MasterInboxItem[];

  // Final acceptance
  createFinalAcceptanceRun(
    id: EntityId,
    projectId: EntityId,
    definitionOfDoneId: EntityId,
  ): FinalAcceptanceRun;

  // Budget
  initializeBudgetLedger(input: InitializeBudgetLedgerInput): BudgetLedger;
  getBudgetLedger(projectId: EntityId): BudgetLedger | undefined;
  recordBudgetEntry(input: CreateBudgetEntryInput): BudgetEntry;
  checkBudget(projectId: EntityId, category: BudgetLimit["category"]): import("../domain/budget.js").BudgetCheckResult;
}

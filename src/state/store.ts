import type {
  AcceptanceCriterion,
  Blocker,
  BudgetEntry,
  BudgetLedger,
  BudgetLimit,
  CreateAcceptanceCriterionInput,
  CreateBlockerInput,
  CreateBudgetEntryInput,
  CreateDefinitionOfDoneInput,
  CreateDeploymentInput,
  CreateEvidenceInput,
  CreateGitRevisionInput,
  CreateMasterInboxItemInput,
  CreateMasterRunInput,
  CreatePermissionRequestInput,
  CreateProjectInput,
  CreateReleaseContractInput,
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
  MasterRun,
  MasterState,
  Permission,
  PermissionRequest,
  Project,
  ReleaseContract,
  Requirement,
  Task,
  TaskDependency,
  TestCase,
  TestResult,
  UpdateAcceptanceCriterionInput,
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
  listDefinitionsOfDoneByProject(projectId: EntityId): readonly DefinitionOfDone[];

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
  listTestCasesByProject(projectId: EntityId): readonly TestCase[];

  recordTestResult(input: CreateTestResultInput): TestResult;
  listTestResultsByCase(testCaseId: EntityId): readonly TestResult[];
  listTestResultsByProject(projectId: EntityId): readonly TestResult[];

  // Evidence
  createEvidence(input: CreateEvidenceInput): Evidence;
  getEvidence(id: EntityId): Evidence | undefined;
  listEvidenceByTask(taskId: EntityId): readonly Evidence[];
  listEvidenceByProject(projectId: EntityId): readonly Evidence[];

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
  listVerifierRunsByProject(projectId: EntityId): readonly VerifierRun[];

  // Master director
  getOrCreateMasterState(projectId: EntityId): MasterState;
  updateMasterPhase(projectId: EntityId, phase: MasterState["status"]): MasterState;
  setMasterActiveTaskIds(projectId: EntityId, activeTaskIds: readonly EntityId[]): MasterState;
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
  addBudgetResource(input: import("../domain/budget.js").AddBudgetResourceInput): BudgetLedger;
  recordBudgetEntry(input: CreateBudgetEntryInput): BudgetEntry;
  checkBudget(projectId: EntityId, category: BudgetLimit["category"]): import("../domain/budget.js").BudgetCheckResult;

  // Master AI / release contract
  createReleaseContract(input: CreateReleaseContractInput): ReleaseContract;
  getReleaseContract(id: EntityId): ReleaseContract | undefined;
  getLatestReleaseContract(projectId: EntityId): ReleaseContract | undefined;

  createAcceptanceCriterion(input: CreateAcceptanceCriterionInput): AcceptanceCriterion;
  updateAcceptanceCriterion(input: UpdateAcceptanceCriterionInput): AcceptanceCriterion;
  listAcceptanceCriteriaByProject(projectId: EntityId): readonly AcceptanceCriterion[];

  createBlocker(input: CreateBlockerInput): Blocker;
  resolveBlocker(blockerId: EntityId): Blocker;
  listBlockersByProject(projectId: EntityId): readonly Blocker[];

  createMasterRun(input: CreateMasterRunInput): MasterRun;
  getMasterRun(id: EntityId): MasterRun | undefined;
  listMasterRunsByProject(projectId: EntityId): readonly MasterRun[];
}

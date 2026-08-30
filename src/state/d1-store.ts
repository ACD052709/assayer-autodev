import type { D1Database } from "@cloudflare/workers-types";
import type {
  BudgetCategory,
  BudgetCheckResult,
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
  DefinitionOfDoneCriterion,
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
import type { AsyncStateStore } from "./async-store.js";
import {
  optionalNumber,
  optionalString,
  parseJsonArray,
  parseJsonObject,
  toJson,
} from "./d1/mappers.js";

function sumUsage(entries: readonly BudgetEntry[], category: BudgetCategory): number {
  return entries
    .filter((e) => e.category === category)
    .reduce((sum, e) => sum + e.amount, 0);
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: string;
  status_changed_at: string;
  created_at: string;
  updated_at: string;
}

interface RequirementRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: number;
  source: string | null;
  status: string;
  status_changed_at: string;
  created_at: string;
  updated_at: string;
}

interface DefinitionOfDoneRow {
  id: string;
  project_id: string;
  version: number;
  criteria_json: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  kind: string;
  status: string;
  status_changed_at: string;
  dependency_ids_json: string;
  assigned_worker_run_id: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskDependencyRow {
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
}

interface WorkerRunRow {
  id: string;
  project_id: string;
  task_id: string;
  worker_kind: string;
  iteration: number;
  status: string;
  status_changed_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkerEventRow {
  id: string;
  project_id: string;
  task_id: string;
  worker_run_id: string;
  event_type: string;
  message: string;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkerReportRow {
  id: string;
  project_id: string;
  task_id: string;
  worker_run_id: string;
  summary: string;
  outcome: string;
  metrics_json: string | null;
  created_at: string;
  updated_at: string;
}

interface TestCaseRow {
  id: string;
  project_id: string;
  task_id: string | null;
  name: string;
  description: string;
  kind: string;
  status: string;
  status_changed_at: string;
  created_at: string;
  updated_at: string;
}

interface TestResultRow {
  id: string;
  project_id: string;
  test_case_id: string;
  task_id: string | null;
  worker_run_id: string | null;
  verifier_run_id: string | null;
  outcome: string;
  message: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

interface EvidenceRow {
  id: string;
  project_id: string;
  task_id: string | null;
  worker_run_id: string | null;
  verifier_run_id: string | null;
  git_revision_id: string | null;
  deployment_id: string | null;
  kind: string;
  label: string;
  uri: string | null;
  content_ref: string | null;
  mime_type: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface PermissionRow {
  id: string;
  project_id: string;
  request_id: string;
  task_id: string | null;
  worker_run_id: string | null;
  decision: string;
  decided_by: string | null;
  notes: string | null;
  status: string;
  status_changed_at: string;
  created_at: string;
  updated_at: string;
}

interface GitRevisionRow {
  id: string;
  project_id: string;
  task_id: string | null;
  commit_sha: string;
  branch: string | null;
  tag: string | null;
  message: string | null;
  authored_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeploymentRow {
  id: string;
  project_id: string;
  task_id: string | null;
  git_revision_id: string;
  environment: string;
  status: string;
  status_changed_at: string;
  url: string | null;
  created_at: string;
  updated_at: string;
}

interface VerifierRunRow {
  id: string;
  project_id: string;
  task_id: string;
  status: string;
  status_changed_at: string;
  outcome: string | null;
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
  evidence_ids_json: string;
  created_at: string;
  updated_at: string;
}

interface MasterStateRow {
  project_id: string;
  status: string;
  status_changed_at: string;
  active_task_ids: string;
  inbox_item_ids: string;
  last_director_action_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MasterInboxRow {
  id: string;
  project_id: string;
  kind: string;
  subject: string;
  body: string;
  related_entity_id: string | null;
  status: string;
  status_changed_at: string;
  received_at: string;
  created_at: string;
  updated_at: string;
}

interface BudgetLedgerRow {
  project_id: string;
  limits_json: string;
  created_at: string;
  updated_at: string;
}

interface BudgetEntryRow {
  id: string;
  project_id: string;
  category: string;
  amount: number;
  unit: string;
  task_id: string | null;
  worker_run_id: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as Project["status"],
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRequirement(row: RequirementRow): Requirement {
  const source = optionalString(row.source);
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    ...(source !== undefined ? { source } : {}),
    status: row.status as Requirement["status"],
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDefinitionOfDone(row: DefinitionOfDoneRow): DefinitionOfDone {
  const notes = optionalString(row.notes);
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    criteria: parseJsonArray<DefinitionOfDoneCriterion>(row.criteria_json),
    ...(notes !== undefined ? { notes } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTask(row: TaskRow): Task {
  const assignedWorkerRunId = optionalString(row.assigned_worker_run_id);
  const blockedReason = optionalString(row.blocked_reason);
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    kind: row.kind as Task["kind"],
    dependencyIds: parseJsonArray<EntityId>(row.dependency_ids_json),
    status: row.status as Task["status"],
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(assignedWorkerRunId !== undefined ? { assignedWorkerRunId } : {}),
    ...(blockedReason !== undefined ? { blockedReason } : {}),
  };
}

function rowToTaskDependency(row: TaskDependencyRow): TaskDependency {
  return {
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    createdAt: row.created_at,
  };
}

function rowToWorkerRun(row: WorkerRunRow): WorkerRun {
  const startedAt = optionalString(row.started_at);
  const completedAt = optionalString(row.completed_at);
  const errorMessage = optionalString(row.error_message);
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    workerKind: row.worker_kind as WorkerRun["workerKind"],
    iteration: row.iteration,
    status: row.status as WorkerRun["status"],
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

function rowToWorkerEvent(row: WorkerEventRow): WorkerEvent {
  const payload = parseJsonObject<Record<string, unknown>>(row.payload_json);
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    workerRunId: row.worker_run_id,
    eventType: row.event_type as WorkerEvent["eventType"],
    message: row.message,
    ...(payload !== undefined ? { payload } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWorkerReport(row: WorkerReportRow): WorkerReport {
  const metrics = parseJsonObject<Record<string, number>>(row.metrics_json);
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    workerRunId: row.worker_run_id,
    summary: row.summary,
    outcome: row.outcome as WorkerReport["outcome"],
    ...(metrics !== undefined ? { metrics } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTestCase(row: TestCaseRow): TestCase {
  const taskId = optionalString(row.task_id);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    kind: row.kind as TestCase["kind"],
    status: row.status as TestCase["status"],
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

function rowToTestResult(row: TestResultRow): TestResult {
  const taskId = optionalString(row.task_id);
  const workerRunId = optionalString(row.worker_run_id);
  const verifierRunId = optionalString(row.verifier_run_id);
  const message = optionalString(row.message);
  const durationMs = optionalNumber(row.duration_ms);
  return {
    id: row.id,
    projectId: row.project_id,
    testCaseId: row.test_case_id,
    outcome: row.outcome as TestResult["outcome"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(workerRunId !== undefined ? { workerRunId } : {}),
    ...(verifierRunId !== undefined ? { verifierRunId } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function rowToEvidence(row: EvidenceRow): Evidence {
  const taskId = optionalString(row.task_id);
  const workerRunId = optionalString(row.worker_run_id);
  const verifierRunId = optionalString(row.verifier_run_id);
  const gitRevisionId = optionalString(row.git_revision_id);
  const deploymentId = optionalString(row.deployment_id);
  const uri = optionalString(row.uri);
  const contentRef = optionalString(row.content_ref);
  const mimeType = optionalString(row.mime_type);
  const metadata = parseJsonObject<Record<string, unknown>>(row.metadata_json);
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as Evidence["kind"],
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(workerRunId !== undefined ? { workerRunId } : {}),
    ...(verifierRunId !== undefined ? { verifierRunId } : {}),
    ...(gitRevisionId !== undefined ? { gitRevisionId } : {}),
    ...(deploymentId !== undefined ? { deploymentId } : {}),
    ...(uri !== undefined ? { uri } : {}),
    ...(contentRef !== undefined ? { contentRef } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function rowToPermission(row: PermissionRow): Permission {
  const taskId = optionalString(row.task_id);
  const workerRunId = optionalString(row.worker_run_id);
  const decidedBy = optionalString(row.decided_by) as Permission["decidedBy"] | undefined;
  const notes = optionalString(row.notes);
  return {
    id: row.id,
    projectId: row.project_id,
    requestId: row.request_id,
    decision: row.decision as Permission["decision"],
    status: row.status as Permission["status"],
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(workerRunId !== undefined ? { workerRunId } : {}),
    ...(decidedBy !== undefined ? { decidedBy } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

function rowToGitRevision(row: GitRevisionRow): GitRevision {
  const taskId = optionalString(row.task_id);
  const branch = optionalString(row.branch);
  const tag = optionalString(row.tag);
  const message = optionalString(row.message);
  const authoredAt = optionalString(row.authored_at);
  return {
    id: row.id,
    projectId: row.project_id,
    commitSha: row.commit_sha,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(authoredAt !== undefined ? { authoredAt } : {}),
  };
}

function rowToDeployment(row: DeploymentRow): Deployment {
  const taskId = optionalString(row.task_id);
  const url = optionalString(row.url);
  return {
    id: row.id,
    projectId: row.project_id,
    gitRevisionId: row.git_revision_id,
    environment: row.environment,
    status: row.status as Deployment["status"],
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

function rowToVerifierRun(row: VerifierRunRow): VerifierRun {
  const outcome = optionalString(row.outcome) as VerifierRun["outcome"] | undefined;
  const startedAt = optionalString(row.started_at);
  const completedAt = optionalString(row.completed_at);
  const summary = optionalString(row.summary);
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    evidenceIds: parseJsonArray<EntityId>(row.evidence_ids_json),
    status: row.status as VerifierRun["status"],
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function rowToMasterState(row: MasterStateRow): MasterState {
  const lastDirectorActionAt = optionalString(row.last_director_action_at);
  return {
    projectId: row.project_id,
    activeTaskIds: parseJsonArray<EntityId>(row.active_task_ids),
    inboxItemIds: parseJsonArray<EntityId>(row.inbox_item_ids),
    status: row.status as MasterState["status"],
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(lastDirectorActionAt !== undefined ? { lastDirectorActionAt } : {}),
  };
}

function rowToMasterInboxItem(row: MasterInboxRow): MasterInboxItem {
  const relatedEntityId = optionalString(row.related_entity_id);
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as MasterInboxItem["kind"],
    subject: row.subject,
    body: row.body,
    receivedAt: row.received_at,
    status: row.status as MasterInboxItem["status"],
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(relatedEntityId !== undefined ? { relatedEntityId } : {}),
  };
}

function rowToBudgetEntry(row: BudgetEntryRow): BudgetEntry {
  const taskId = optionalString(row.task_id);
  const workerRunId = optionalString(row.worker_run_id);
  const description = optionalString(row.description);
  return {
    id: row.id,
    projectId: row.project_id,
    category: row.category as BudgetEntry["category"],
    amount: row.amount,
    unit: row.unit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(workerRunId !== undefined ? { workerRunId } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

export class D1StateStore implements AsyncStateStore {
  constructor(private readonly db: D1Database) {}

  async createProject(input: CreateProjectInput): Promise<Project> {
    const ts = createTimestamps();
    const project: Project = {
      id: input.id,
      name: input.name,
      description: input.description,
      ...ts,
      ...withStatus("active"),
    };
    await this.db
      .prepare(
        `INSERT INTO projects (id, name, description, status, status_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        project.id,
        project.name,
        project.description,
        project.status,
        project.statusChangedAt,
        project.createdAt,
        project.updatedAt,
      )
      .run();
    return project;
  }

  async getProject(id: EntityId): Promise<Project | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .bind(id)
      .first<ProjectRow>();
    return row ? rowToProject(row) : undefined;
  }

  async listProjects(): Promise<readonly Project[]> {
    const result = await this.db.prepare(`SELECT * FROM projects`).all<ProjectRow>();
    return (result.results ?? []).map(rowToProject);
  }

  async createRequirement(input: CreateRequirementInput): Promise<Requirement> {
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
    await this.db
      .prepare(
        `INSERT INTO requirements
         (id, project_id, title, description, priority, source, status, status_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        requirement.id,
        requirement.projectId,
        requirement.title,
        requirement.description,
        requirement.priority,
        requirement.source ?? null,
        requirement.status,
        requirement.statusChangedAt,
        requirement.createdAt,
        requirement.updatedAt,
      )
      .run();
    return requirement;
  }

  async getRequirement(id: EntityId): Promise<Requirement | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM requirements WHERE id = ?`)
      .bind(id)
      .first<RequirementRow>();
    return row ? rowToRequirement(row) : undefined;
  }

  async listRequirementsByProject(projectId: EntityId): Promise<readonly Requirement[]> {
    const result = await this.db
      .prepare(`SELECT * FROM requirements WHERE project_id = ?`)
      .bind(projectId)
      .all<RequirementRow>();
    return (result.results ?? []).map(rowToRequirement);
  }

  async createDefinitionOfDone(input: CreateDefinitionOfDoneInput): Promise<DefinitionOfDone> {
    const dod: DefinitionOfDone = {
      id: input.id,
      projectId: input.projectId,
      version: input.version,
      criteria: input.criteria,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...createTimestamps(),
    };
    await this.db
      .prepare(
        `INSERT INTO definitions_of_done
         (id, project_id, version, criteria_json, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        dod.id,
        dod.projectId,
        dod.version,
        toJson(dod.criteria),
        dod.notes ?? null,
        dod.createdAt,
        dod.updatedAt,
      )
      .run();
    return dod;
  }

  async getDefinitionOfDone(id: EntityId): Promise<DefinitionOfDone | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM definitions_of_done WHERE id = ?`)
      .bind(id)
      .first<DefinitionOfDoneRow>();
    return row ? rowToDefinitionOfDone(row) : undefined;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
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
    await this.db
      .prepare(
        `INSERT INTO tasks
         (id, project_id, title, description, kind, status, status_changed_at, dependency_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        task.id,
        task.projectId,
        task.title,
        task.description,
        task.kind,
        task.status,
        task.statusChangedAt,
        toJson(task.dependencyIds),
        task.createdAt,
        task.updatedAt,
      )
      .run();
    return task;
  }

  async getTask(id: EntityId): Promise<Task | undefined> {
    const row = await this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(id).first<TaskRow>();
    return row ? rowToTask(row) : undefined;
  }

  async listTasksByProject(projectId: EntityId): Promise<readonly Task[]> {
    const result = await this.db
      .prepare(`SELECT * FROM tasks WHERE project_id = ?`)
      .bind(projectId)
      .all<TaskRow>();
    return (result.results ?? []).map(rowToTask);
  }

  async updateTaskStatus(taskId: EntityId, status: Task["status"]): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const updated: Task = {
      ...task,
      ...withStatus(status),
      ...touchTimestamps(task),
    };
    await this.db
      .prepare(
        `UPDATE tasks SET status = ?, status_changed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(updated.status, updated.statusChangedAt, updated.updatedAt, taskId)
      .run();
    return updated;
  }

  async addTaskDependency(input: CreateTaskDependencyInput): Promise<TaskDependency> {
    const dep: TaskDependency = {
      taskId: input.taskId,
      dependsOnTaskId: input.dependsOnTaskId,
      createdAt: nowIso(),
    };
    await this.db
      .prepare(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(dep.taskId, dep.dependsOnTaskId, dep.createdAt)
      .run();
    return dep;
  }

  async listTaskDependencies(taskId: EntityId): Promise<readonly TaskDependency[]> {
    const result = await this.db
      .prepare(`SELECT * FROM task_dependencies WHERE task_id = ?`)
      .bind(taskId)
      .all<TaskDependencyRow>();
    return (result.results ?? []).map(rowToTaskDependency);
  }

  async createWorkerRun(input: CreateWorkerRunInput): Promise<WorkerRun> {
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
    await this.db
      .prepare(
        `INSERT INTO worker_runs
         (id, project_id, task_id, worker_kind, iteration, status, status_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.id,
        run.projectId,
        run.taskId,
        run.workerKind,
        run.iteration,
        run.status,
        run.statusChangedAt,
        run.createdAt,
        run.updatedAt,
      )
      .run();
    return run;
  }

  async getWorkerRun(id: EntityId): Promise<WorkerRun | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM worker_runs WHERE id = ?`)
      .bind(id)
      .first<WorkerRunRow>();
    return row ? rowToWorkerRun(row) : undefined;
  }

  async updateWorkerRunStatus(
    workerRunId: EntityId,
    status: WorkerRun["status"],
    errorMessage?: string,
  ): Promise<WorkerRun> {
    const run = await this.getWorkerRun(workerRunId);
    if (!run) {
      throw new Error(`WorkerRun not found: ${workerRunId}`);
    }
    const at = nowIso();
    const updated: WorkerRun = {
      ...run,
      ...withStatus(status, at),
      ...touchTimestamps(run, at),
      ...(status === "running" ? { startedAt: at } : {}),
      ...(status === "succeeded" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "timed_out"
        ? { completedAt: at }
        : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
    await this.db
      .prepare(
        `UPDATE worker_runs
         SET status = ?, status_changed_at = ?, started_at = ?, completed_at = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        updated.status,
        updated.statusChangedAt,
        updated.startedAt ?? null,
        updated.completedAt ?? null,
        updated.errorMessage ?? null,
        updated.updatedAt,
        workerRunId,
      )
      .run();
    return updated;
  }

  async appendWorkerEvent(input: CreateWorkerEventInput): Promise<WorkerEvent> {
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
    await this.db
      .prepare(
        `INSERT INTO worker_events
         (id, project_id, task_id, worker_run_id, event_type, message, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.projectId,
        event.taskId,
        event.workerRunId,
        event.eventType,
        event.message,
        event.payload !== undefined ? toJson(event.payload) : null,
        event.createdAt,
        event.updatedAt,
      )
      .run();
    return event;
  }

  async listWorkerEvents(workerRunId: EntityId): Promise<readonly WorkerEvent[]> {
    const result = await this.db
      .prepare(`SELECT * FROM worker_events WHERE worker_run_id = ? ORDER BY created_at`)
      .bind(workerRunId)
      .all<WorkerEventRow>();
    return (result.results ?? []).map(rowToWorkerEvent);
  }

  async createWorkerReport(input: CreateWorkerReportInput): Promise<WorkerReport> {
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
    await this.db
      .prepare(
        `INSERT INTO worker_reports
         (id, project_id, task_id, worker_run_id, summary, outcome, metrics_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        report.id,
        report.projectId,
        report.taskId,
        report.workerRunId,
        report.summary,
        report.outcome,
        report.metrics !== undefined ? toJson(report.metrics) : null,
        report.createdAt,
        report.updatedAt,
      )
      .run();
    return report;
  }

  async getWorkerReport(id: EntityId): Promise<WorkerReport | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM worker_reports WHERE id = ?`)
      .bind(id)
      .first<WorkerReportRow>();
    return row ? rowToWorkerReport(row) : undefined;
  }

  async createTestCase(input: CreateTestCaseInput): Promise<TestCase> {
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
    await this.db
      .prepare(
        `INSERT INTO test_cases
         (id, project_id, task_id, name, description, kind, status, status_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        testCase.id,
        testCase.projectId,
        testCase.taskId ?? null,
        testCase.name,
        testCase.description,
        testCase.kind,
        testCase.status,
        testCase.statusChangedAt,
        testCase.createdAt,
        testCase.updatedAt,
      )
      .run();
    return testCase;
  }

  async getTestCase(id: EntityId): Promise<TestCase | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM test_cases WHERE id = ?`)
      .bind(id)
      .first<TestCaseRow>();
    return row ? rowToTestCase(row) : undefined;
  }

  async recordTestResult(input: CreateTestResultInput): Promise<TestResult> {
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
    await this.db
      .prepare(
        `INSERT INTO test_results
         (id, project_id, test_case_id, task_id, worker_run_id, verifier_run_id, outcome, message, duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        result.id,
        result.projectId,
        result.testCaseId,
        result.taskId ?? null,
        result.workerRunId ?? null,
        result.verifierRunId ?? null,
        result.outcome,
        result.message ?? null,
        result.durationMs ?? null,
        result.createdAt,
        result.updatedAt,
      )
      .run();
    return result;
  }

  async listTestResultsByCase(testCaseId: EntityId): Promise<readonly TestResult[]> {
    const result = await this.db
      .prepare(`SELECT * FROM test_results WHERE test_case_id = ? ORDER BY created_at`)
      .bind(testCaseId)
      .all<TestResultRow>();
    return (result.results ?? []).map(rowToTestResult);
  }

  async createEvidence(input: CreateEvidenceInput): Promise<Evidence> {
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
    await this.db
      .prepare(
        `INSERT INTO evidence
         (id, project_id, task_id, worker_run_id, verifier_run_id, git_revision_id, deployment_id,
          kind, label, uri, content_ref, mime_type, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        item.id,
        item.projectId,
        item.taskId ?? null,
        item.workerRunId ?? null,
        item.verifierRunId ?? null,
        item.gitRevisionId ?? null,
        item.deploymentId ?? null,
        item.kind,
        item.label,
        item.uri ?? null,
        item.contentRef ?? null,
        item.mimeType ?? null,
        item.metadata !== undefined ? toJson(item.metadata) : null,
        item.createdAt,
        item.updatedAt,
      )
      .run();
    return item;
  }

  async getEvidence(id: EntityId): Promise<Evidence | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM evidence WHERE id = ?`)
      .bind(id)
      .first<EvidenceRow>();
    return row ? rowToEvidence(row) : undefined;
  }

  async listEvidenceByTask(taskId: EntityId): Promise<readonly Evidence[]> {
    const result = await this.db
      .prepare(`SELECT * FROM evidence WHERE task_id = ?`)
      .bind(taskId)
      .all<EvidenceRow>();
    return (result.results ?? []).map(rowToEvidence);
  }

  async createPermissionRequest(input: CreatePermissionRequestInput): Promise<PermissionRequest> {
    const ts = createTimestamps();
    const request: PermissionRequest = {
      id: input.id,
      projectId: input.projectId,
      scope: input.scope,
      action: input.action,
      resource: input.resource,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workerRunId !== undefined ? { workerRunId: input.workerRunId } : {}),
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...ts,
    };

    const permissionTs = createTimestamps();
    const permissionStatus = withStatus("pending");
    const permission: Permission = {
      id: `perm-${input.id}`,
      projectId: input.projectId,
      requestId: request.id,
      decision: "escalate",
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workerRunId !== undefined ? { workerRunId: input.workerRunId } : {}),
      ...permissionTs,
      ...permissionStatus,
    };

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO permission_requests
           (id, project_id, task_id, worker_run_id, scope, action, resource, rationale, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          request.id,
          request.projectId,
          request.taskId ?? null,
          request.workerRunId ?? null,
          request.scope,
          request.action,
          request.resource,
          request.rationale ?? null,
          request.createdAt,
          request.updatedAt,
        ),
      this.db
        .prepare(
          `INSERT INTO permissions
           (id, project_id, request_id, task_id, worker_run_id, decision, status, status_changed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          permission.id,
          permission.projectId,
          permission.requestId,
          permission.taskId ?? null,
          permission.workerRunId ?? null,
          permission.decision,
          permission.status,
          permission.statusChangedAt,
          permission.createdAt,
          permission.updatedAt,
        ),
    ]);

    return request;
  }

  async decidePermission(input: DecidePermissionInput): Promise<Permission> {
    const permission = await this.getPermission(input.permissionId);
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
    await this.db
      .prepare(
        `UPDATE permissions
         SET decision = ?, decided_by = ?, notes = ?, status = ?, status_changed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        updated.decision,
        updated.decidedBy ?? null,
        updated.notes ?? null,
        updated.status,
        updated.statusChangedAt,
        updated.updatedAt,
        input.permissionId,
      )
      .run();
    return updated;
  }

  async getPermission(id: EntityId): Promise<Permission | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM permissions WHERE id = ?`)
      .bind(id)
      .first<PermissionRow>();
    return row ? rowToPermission(row) : undefined;
  }

  async createGitRevision(input: CreateGitRevisionInput): Promise<GitRevision> {
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
    await this.db
      .prepare(
        `INSERT INTO git_revisions
         (id, project_id, task_id, commit_sha, branch, tag, message, authored_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        revision.id,
        revision.projectId,
        revision.taskId ?? null,
        revision.commitSha,
        revision.branch ?? null,
        revision.tag ?? null,
        revision.message ?? null,
        revision.authoredAt ?? null,
        revision.createdAt,
        revision.updatedAt,
      )
      .run();
    return revision;
  }

  async getGitRevision(id: EntityId): Promise<GitRevision | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM git_revisions WHERE id = ?`)
      .bind(id)
      .first<GitRevisionRow>();
    return row ? rowToGitRevision(row) : undefined;
  }

  async createDeployment(input: CreateDeploymentInput): Promise<Deployment> {
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
    await this.db
      .prepare(
        `INSERT INTO deployments
         (id, project_id, task_id, git_revision_id, environment, status, status_changed_at, url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deployment.id,
        deployment.projectId,
        deployment.taskId ?? null,
        deployment.gitRevisionId,
        deployment.environment,
        deployment.status,
        deployment.statusChangedAt,
        deployment.url ?? null,
        deployment.createdAt,
        deployment.updatedAt,
      )
      .run();
    return deployment;
  }

  async getDeployment(id: EntityId): Promise<Deployment | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM deployments WHERE id = ?`)
      .bind(id)
      .first<DeploymentRow>();
    return row ? rowToDeployment(row) : undefined;
  }

  async updateDeploymentStatus(
    deploymentId: EntityId,
    status: Deployment["status"],
  ): Promise<Deployment> {
    const deployment = await this.getDeployment(deploymentId);
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
    await this.db
      .prepare(
        `UPDATE deployments SET status = ?, status_changed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(updated.status, updated.statusChangedAt, updated.updatedAt, deploymentId)
      .run();
    return updated;
  }

  async createVerifierRun(input: CreateVerifierRunInput): Promise<VerifierRun> {
    const run: VerifierRun = {
      id: input.id,
      projectId: input.projectId,
      taskId: input.taskId,
      evidenceIds: [],
      ...createTimestamps(),
      ...withStatus("pending"),
    };
    await this.db
      .prepare(
        `INSERT INTO verifier_runs
         (id, project_id, task_id, status, status_changed_at, evidence_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.id,
        run.projectId,
        run.taskId,
        run.status,
        run.statusChangedAt,
        toJson(run.evidenceIds),
        run.createdAt,
        run.updatedAt,
      )
      .run();
    return run;
  }

  async completeVerifierRun(input: CompleteVerifierRunInput): Promise<VerifierRun> {
    const run = await this.getVerifierRun(input.verifierRunId);
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
    await this.db
      .prepare(
        `UPDATE verifier_runs
         SET outcome = ?, evidence_ids_json = ?, summary = ?, started_at = ?, completed_at = ?,
             status = ?, status_changed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        updated.outcome ?? null,
        toJson(updated.evidenceIds),
        updated.summary ?? null,
        updated.startedAt ?? null,
        updated.completedAt ?? null,
        updated.status,
        updated.statusChangedAt,
        updated.updatedAt,
        input.verifierRunId,
      )
      .run();
    return updated;
  }

  async getVerifierRun(id: EntityId): Promise<VerifierRun | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM verifier_runs WHERE id = ?`)
      .bind(id)
      .first<VerifierRunRow>();
    return row ? rowToVerifierRun(row) : undefined;
  }

  async getOrCreateMasterState(projectId: EntityId): Promise<MasterState> {
    const row = await this.db
      .prepare(`SELECT * FROM master_state WHERE project_id = ?`)
      .bind(projectId)
      .first<MasterStateRow>();
    if (row) {
      return rowToMasterState(row);
    }
    const state: MasterState = {
      projectId,
      activeTaskIds: [],
      inboxItemIds: [],
      ...createTimestamps(),
      ...withStatus("initializing"),
    };
    await this.db
      .prepare(
        `INSERT INTO master_state
         (project_id, status, status_changed_at, active_task_ids, inbox_item_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        state.projectId,
        state.status,
        state.statusChangedAt,
        toJson(state.activeTaskIds),
        toJson(state.inboxItemIds),
        state.createdAt,
        state.updatedAt,
      )
      .run();
    return state;
  }

  async updateMasterPhase(
    projectId: EntityId,
    phase: MasterState["status"],
  ): Promise<MasterState> {
    const state = await this.getOrCreateMasterState(projectId);
    const at = nowIso();
    const updated: MasterState = {
      ...state,
      ...withStatus(phase, at),
      lastDirectorActionAt: at,
      ...touchTimestamps(state, at),
    };
    await this.db
      .prepare(
        `UPDATE master_state
         SET status = ?, status_changed_at = ?, last_director_action_at = ?, updated_at = ?
         WHERE project_id = ?`,
      )
      .bind(
        updated.status,
        updated.statusChangedAt,
        updated.lastDirectorActionAt ?? null,
        updated.updatedAt,
        projectId,
      )
      .run();
    return updated;
  }

  async enqueueMasterInboxItem(input: CreateMasterInboxItemInput): Promise<MasterInboxItem> {
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

    const state = await this.getOrCreateMasterState(input.projectId);
    const updatedState: MasterState = {
      ...state,
      inboxItemIds: [...state.inboxItemIds, item.id],
      ...touchTimestamps(state),
    };

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO master_inbox
           (id, project_id, kind, subject, body, related_entity_id, status, status_changed_at, received_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.id,
          item.projectId,
          item.kind,
          item.subject,
          item.body,
          item.relatedEntityId ?? null,
          item.status,
          item.statusChangedAt,
          item.receivedAt,
          item.createdAt,
          item.updatedAt,
        ),
      this.db
        .prepare(
          `UPDATE master_state SET inbox_item_ids = ?, updated_at = ? WHERE project_id = ?`,
        )
        .bind(toJson(updatedState.inboxItemIds), updatedState.updatedAt, input.projectId),
    ]);

    return item;
  }

  async listMasterInbox(projectId: EntityId): Promise<readonly MasterInboxItem[]> {
    const result = await this.db
      .prepare(`SELECT * FROM master_inbox WHERE project_id = ? ORDER BY received_at DESC`)
      .bind(projectId)
      .all<MasterInboxRow>();
    return (result.results ?? []).map(rowToMasterInboxItem);
  }

  async createFinalAcceptanceRun(
    id: EntityId,
    projectId: EntityId,
    definitionOfDoneId: EntityId,
  ): Promise<FinalAcceptanceRun> {
    const run: FinalAcceptanceRun = {
      id,
      projectId,
      definitionOfDoneId,
      ...createTimestamps(),
      ...withStatus("pending"),
    };
    await this.db
      .prepare(
        `INSERT INTO final_acceptance_runs
         (id, project_id, definition_of_done_id, status, status_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.id,
        run.projectId,
        run.definitionOfDoneId,
        run.status,
        run.statusChangedAt,
        run.createdAt,
        run.updatedAt,
      )
      .run();
    return run;
  }

  async initializeBudgetLedger(input: InitializeBudgetLedgerInput): Promise<BudgetLedger> {
    const ledger: BudgetLedger = {
      projectId: input.projectId,
      limits: input.limits,
      entries: [],
      ...createTimestamps(input.at),
    };
    await this.db
      .prepare(
        `INSERT INTO budget_ledger (project_id, limits_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(ledger.projectId, toJson(ledger.limits), ledger.createdAt, ledger.updatedAt)
      .run();
    return ledger;
  }

  async getBudgetLedger(projectId: EntityId): Promise<BudgetLedger | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM budget_ledger WHERE project_id = ?`)
      .bind(projectId)
      .first<BudgetLedgerRow>();
    if (!row) {
      return undefined;
    }
    const entriesResult = await this.db
      .prepare(`SELECT * FROM budget_entries WHERE project_id = ? ORDER BY created_at`)
      .bind(projectId)
      .all<BudgetEntryRow>();
    const entries = (entriesResult.results ?? []).map(rowToBudgetEntry);
    return {
      projectId: row.project_id,
      limits: parseJsonArray<BudgetLimit>(row.limits_json),
      entries,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async recordBudgetEntry(input: CreateBudgetEntryInput): Promise<BudgetEntry> {
    const ledger = await this.getBudgetLedger(input.projectId);
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
    const ledgerUpdate = touchTimestamps(ledger);
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO budget_entries
           (id, project_id, category, amount, unit, task_id, worker_run_id, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          entry.id,
          entry.projectId,
          entry.category,
          entry.amount,
          entry.unit,
          entry.taskId ?? null,
          entry.workerRunId ?? null,
          entry.description ?? null,
          entry.createdAt,
          entry.updatedAt,
        ),
      this.db
        .prepare(`UPDATE budget_ledger SET updated_at = ? WHERE project_id = ?`)
        .bind(ledgerUpdate.updatedAt, input.projectId),
    ]);
    return entry;
  }

  async checkBudget(projectId: EntityId, category: BudgetCategory): Promise<BudgetCheckResult> {
    const ledger = await this.getBudgetLedger(projectId);
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

export function createD1StateStore(db: D1Database): AsyncStateStore {
  return new D1StateStore(db);
}

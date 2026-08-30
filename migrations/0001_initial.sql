-- assayer-autodev D1 schema (initial)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS master_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  active_task_ids TEXT NOT NULL DEFAULT '[]',
  inbox_item_ids TEXT NOT NULL DEFAULT '[]',
  last_director_action_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements(project_id);
CREATE INDEX IF NOT EXISTS idx_requirements_project_status ON requirements(project_id, status);

CREATE TABLE IF NOT EXISTS definitions_of_done (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  criteria_json TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dod_project ON definitions_of_done(project_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  dependency_ids_json TEXT NOT NULL DEFAULT '[]',
  assigned_worker_run_id TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on_task_id);

CREATE TABLE IF NOT EXISTS worker_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_kind TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_runs_project ON worker_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_worker_runs_task ON worker_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_worker_runs_status ON worker_runs(project_id, status);

CREATE TABLE IF NOT EXISTS worker_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_run_id TEXT NOT NULL REFERENCES worker_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_events_run ON worker_events(worker_run_id);
CREATE INDEX IF NOT EXISTS idx_worker_events_run_created ON worker_events(worker_run_id, created_at);

CREATE TABLE IF NOT EXISTS worker_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_run_id TEXT NOT NULL REFERENCES worker_runs(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL,
  metrics_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_reports_run ON worker_reports(worker_run_id);

CREATE TABLE IF NOT EXISTS test_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_cases_project ON test_cases(project_id);

CREATE TABLE IF NOT EXISTS verifier_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  outcome TEXT,
  started_at TEXT,
  completed_at TEXT,
  summary TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifier_runs_project ON verifier_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_verifier_runs_task ON verifier_runs(task_id);

CREATE TABLE IF NOT EXISTS test_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  worker_run_id TEXT REFERENCES worker_runs(id) ON DELETE SET NULL,
  verifier_run_id TEXT REFERENCES verifier_runs(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL,
  message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_results_case ON test_results(test_case_id);

CREATE TABLE IF NOT EXISTS git_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  commit_sha TEXT NOT NULL,
  branch TEXT,
  tag TEXT,
  message TEXT,
  authored_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_git_revisions_project ON git_revisions(project_id);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  git_revision_id TEXT NOT NULL REFERENCES git_revisions(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(project_id, status);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  worker_run_id TEXT REFERENCES worker_runs(id) ON DELETE SET NULL,
  verifier_run_id TEXT REFERENCES verifier_runs(id) ON DELETE SET NULL,
  git_revision_id TEXT REFERENCES git_revisions(id) ON DELETE SET NULL,
  deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  uri TEXT,
  content_ref TEXT,
  mime_type TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);

CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  worker_run_id TEXT REFERENCES worker_runs(id) ON DELETE SET NULL,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  rationale TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permission_requests_project ON permission_requests(project_id);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE REFERENCES permission_requests(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  worker_run_id TEXT REFERENCES worker_runs(id) ON DELETE SET NULL,
  decision TEXT NOT NULL,
  decided_by TEXT,
  notes TEXT,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permissions_project ON permissions(project_id);

CREATE TABLE IF NOT EXISTS master_inbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  related_entity_id TEXT,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_master_inbox_project ON master_inbox(project_id);
CREATE INDEX IF NOT EXISTS idx_master_inbox_order ON master_inbox(project_id, received_at DESC);

CREATE TABLE IF NOT EXISTS budget_ledger (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  limits_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  worker_run_id TEXT REFERENCES worker_runs(id) ON DELETE SET NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_budget_entries_project ON budget_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_budget_entries_category ON budget_entries(project_id, category);

CREATE TABLE IF NOT EXISTS final_acceptance_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  definition_of_done_id TEXT NOT NULL REFERENCES definitions_of_done(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  outcome TEXT,
  completed_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_final_acceptance_project ON final_acceptance_runs(project_id);

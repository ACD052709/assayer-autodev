-- Master AI persistence: runs, release contracts, acceptance criteria, blockers

CREATE TABLE IF NOT EXISTS release_contracts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  required_evidence_kinds_json TEXT NOT NULL DEFAULT '[]',
  required_evidence_labels_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_release_contracts_project ON release_contracts(project_id);
CREATE INDEX IF NOT EXISTS idx_release_contracts_project_version ON release_contracts(project_id, version);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_contract_id TEXT NOT NULL REFERENCES release_contracts(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  applicable INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acceptance_criteria_project ON acceptance_criteria(project_id);
CREATE INDEX IF NOT EXISTS idx_acceptance_criteria_contract ON acceptance_criteria(release_contract_id);
CREATE INDEX IF NOT EXISTS idx_acceptance_criteria_project_status ON acceptance_criteria(project_id, status);

CREATE TABLE IF NOT EXISTS blockers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  related_entity_id TEXT,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blockers_project ON blockers(project_id);
CREATE INDEX IF NOT EXISTS idx_blockers_project_status ON blockers(project_id, status);
CREATE INDEX IF NOT EXISTS idx_blockers_project_created ON blockers(project_id, created_at);

CREATE TABLE IF NOT EXISTS master_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger TEXT,
  context TEXT,
  proposed_action TEXT NOT NULL,
  enforced_action TEXT NOT NULL,
  rationale TEXT NOT NULL,
  finished_blocked_reasons_json TEXT NOT NULL DEFAULT '[]',
  created_task_ids_json TEXT NOT NULL DEFAULT '[]',
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost REAL,
  status TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_master_runs_project ON master_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_master_runs_project_created ON master_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_master_runs_project_status ON master_runs(project_id, status);

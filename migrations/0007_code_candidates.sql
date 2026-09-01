-- Durable code candidates and promotion runs for Part 7 persistence.

ALTER TABLE projects ADD COLUMN promotion_repository TEXT;
ALTER TABLE projects ADD COLUMN promotion_ref_prefix TEXT;

CREATE TABLE code_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  worker_run_id TEXT NOT NULL REFERENCES worker_runs(id),
  source_repository TEXT NOT NULL,
  source_ref TEXT,
  base_commit_sha TEXT NOT NULL,
  changed_files_json TEXT NOT NULL,
  patch_checksum_sha256 TEXT NOT NULL,
  patch_content_ref TEXT NOT NULL,
  test_command TEXT NOT NULL,
  test_exit_code INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_verification',
  verifier_run_id TEXT REFERENCES verifier_runs(id),
  promotion_run_id TEXT,
  resulting_commit_sha TEXT,
  promoted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, worker_run_id)
);

CREATE INDEX idx_code_candidates_project ON code_candidates(project_id);
CREATE INDEX idx_code_candidates_task ON code_candidates(task_id);
CREATE INDEX idx_code_candidates_status ON code_candidates(status);

CREATE TABLE promotion_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  code_candidate_id TEXT NOT NULL REFERENCES code_candidates(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  worker_run_id TEXT NOT NULL REFERENCES worker_runs(id),
  verifier_run_id TEXT NOT NULL REFERENCES verifier_runs(id),
  destination_repository TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resulting_commit_sha TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(code_candidate_id)
);

CREATE INDEX idx_promotion_runs_project ON promotion_runs(project_id);
CREATE INDEX idx_promotion_runs_status ON promotion_runs(status);

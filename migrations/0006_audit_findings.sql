-- Durable audit findings for the independent watchdog layer.

CREATE TABLE IF NOT EXISTS audit_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  finding_key TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL,
  task_id TEXT,
  worker_run_id TEXT,
  verifier_run_id TEXT,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_findings_project ON audit_findings(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_findings_project_status ON audit_findings(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_findings_project_key ON audit_findings(project_id, finding_key);

-- Bind verification to exact code candidates and persist deterministic browser specs.
ALTER TABLE code_candidates ADD COLUMN parent_candidate_id TEXT REFERENCES code_candidates(id);
ALTER TABLE code_candidates ADD COLUMN accepted_task_id TEXT REFERENCES tasks(id);
ALTER TABLE verifier_runs ADD COLUMN code_candidate_id TEXT REFERENCES code_candidates(id);
ALTER TABLE test_cases ADD COLUMN browser_spec_json TEXT;

CREATE INDEX idx_code_candidates_parent ON code_candidates(parent_candidate_id);
CREATE INDEX idx_verifier_runs_candidate ON verifier_runs(code_candidate_id);

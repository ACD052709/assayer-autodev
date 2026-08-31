-- Optional worker coding-target metadata on projects (backward-compatible).

ALTER TABLE projects ADD COLUMN target_repository TEXT;
ALTER TABLE projects ADD COLUMN target_ref TEXT;
ALTER TABLE projects ADD COLUMN do_not_modify_constraints_json TEXT NOT NULL DEFAULT '[]';

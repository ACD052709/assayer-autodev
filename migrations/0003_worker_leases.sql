-- Worker-run ownership and leases

ALTER TABLE worker_runs ADD COLUMN owner_id TEXT;
ALTER TABLE worker_runs ADD COLUMN lease_token_hash TEXT;
ALTER TABLE worker_runs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE worker_runs ADD COLUMN last_heartbeat_at TEXT;

CREATE INDEX IF NOT EXISTS idx_worker_runs_lease_expiry
  ON worker_runs(status, lease_expires_at);

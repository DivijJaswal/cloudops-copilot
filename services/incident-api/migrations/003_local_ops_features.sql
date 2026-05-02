ALTER TABLE runbooks
  ADD COLUMN IF NOT EXISTS current_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS runbook_versions (
  id TEXT PRIMARY KEY,
  runbook_id TEXT NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  service TEXT NOT NULL,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (runbook_id, version)
);

CREATE TABLE IF NOT EXISTS triage_jobs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  current_step TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB,
  error TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  incident_id TEXT REFERENCES incidents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_users (
  username TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runbook_versions_runbook_version
  ON runbook_versions(runbook_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_triage_jobs_incident_time
  ON triage_jobs(incident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_triage_jobs_status
  ON triage_jobs(status);

CREATE INDEX IF NOT EXISTS idx_audit_events_incident_time
  ON audit_events(incident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_entity
  ON audit_events(entity_type, entity_id);

ALTER TABLE triage_jobs
  ADD CONSTRAINT triage_jobs_status_check
  CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'));

ALTER TABLE app_users
  ADD CONSTRAINT app_users_role_check
  CHECK (role IN ('viewer', 'operator', 'admin'));

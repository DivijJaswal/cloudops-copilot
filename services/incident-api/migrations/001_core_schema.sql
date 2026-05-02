CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'SEV3',
  status TEXT NOT NULL DEFAULT 'OPEN',
  environment TEXT NOT NULL DEFAULT 'stage',
  region TEXT NOT NULL DEFAULT 'local',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  owner TEXT NOT NULL DEFAULT 'unassigned',
  deployment_version TEXT NOT NULL DEFAULT 'unknown',
  signals JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS runbooks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  service TEXT NOT NULL,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS incident_logs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level TEXT NOT NULL DEFAULT 'INFO',
  source TEXT NOT NULL DEFAULT 'application',
  message TEXT NOT NULL,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS triage_feedback (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  rating TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  triage_source TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_service ON incidents(service);
CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runbooks_service ON runbooks(service);
CREATE INDEX IF NOT EXISTS idx_incident_logs_incident_time ON incident_logs(incident_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_logs_level ON incident_logs(level);
CREATE INDEX IF NOT EXISTS idx_triage_feedback_incident_time ON triage_feedback(incident_id, created_at DESC);

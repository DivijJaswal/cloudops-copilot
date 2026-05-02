ALTER TABLE incidents
  ADD CONSTRAINT incidents_severity_check
  CHECK (severity IN ('SEV1', 'SEV2', 'SEV3', 'SEV4'));

ALTER TABLE incidents
  ADD CONSTRAINT incidents_status_check
  CHECK (status IN ('OPEN', 'TRIAGED', 'MITIGATING', 'RESOLVED'));

ALTER TABLE incident_logs
  ADD CONSTRAINT incident_logs_level_check
  CHECK (level IN ('DEBUG', 'INFO', 'WARN', 'ERROR'));

ALTER TABLE triage_feedback
  ADD CONSTRAINT triage_feedback_rating_check
  CHECK (rating IN ('useful', 'incorrect', 'needs-work'));

# Incident Report: INC-DEMO-987095

- Service: incident-api
- Title: Demo demo-rollout-987095 control-plane regression
- Severity: SEV3
- Status: OPEN
- Environment: prod
- Region: us-phoenix-1
- Owner: cloudops-oncall
- Deployment Version: demo.987095
- Created At: 2026-05-02T18:20:42.716Z

## Signals
- demo-rollout-987095 work request retries exhausted
- demo-rollout-987095 API latency and 5xx spike
- operator action denied during rollout

## Runtime Logs
- 2026-05-02T18:20:42.723Z ERROR incident-api: ERROR demo-rollout-987095 request failed after rollout
- 2026-05-02T18:20:42.725Z WARN incident-api: WARN demo-rollout-987095 worker queue depth remains high

## Triage Result
- Source: triage-agent-fallback
- Category: rollout
- Confidence: 0.8200000000000001
- Summary: incident-api has a rollout incident (SEV3) in us-phoenix-1.
- Probable Root Cause: 2026-05-02T18:20:42.723Z ERROR incident-api: ERROR demo-rollout-987095 request failed after rollout

### Recommended Actions
- Pause rollout and verify active work requests.
- Inspect imported runtime logs for the matching request id.
- Replay failed request in staging before resuming.
- Escalate to control-plane owner if denial persists.

### Runbooks
- RB-DEMO-987095: Demo rollout remediation
- RB-API-001: Control-plane patch ingest failure
- RB-DEMO-514341: Demo rollout remediation

### Evidence Used
- Log ERROR incident-api: 2026-05-02T18:20:42.723Z ERROR incident-api: ERROR demo-rollout-987095 request failed after rollout
- Log WARN incident-api: 2026-05-02T18:20:42.725Z WARN incident-api: WARN demo-rollout-987095 worker queue depth remains high
- Signal: demo-rollout-987095 work request retries exhausted
- Signal: demo-rollout-987095 API latency and 5xx spike
- Signal: operator action denied during rollout
- Runbook RB-DEMO-987095: matched demo-rollout-987095, work request, operator action denied
- Runbook RB-API-001: matched work request, control-plane
- Runbook RB-DEMO-514341: matched work request, operator action denied

## Feedback
- 2026-05-02T18:22:15.548Z useful: Useful demo triage result with clear runbook match.

## Audit Timeline
- 2026-05-02T18:22:15.550Z Local Operator triage.feedback_created triage_feedback/FB-deb7214d-090e-4567-8a7b-5f1d57e63b23
- 2026-05-02T18:22:05.730Z Local Operator triage_job.succeeded triage_job/JOB-e515c5af-c1a2-4172-b764-a0b61561fcc8
- 2026-05-02T18:21:05.242Z Local Operator triage_job.queued triage_job/JOB-e515c5af-c1a2-4172-b764-a0b61561fcc8
- 2026-05-02T18:20:42.726Z Local Operator incident.logs_appended incident_logs/INC-DEMO-987095
- 2026-05-02T18:20:42.718Z Local Operator incident.created incident/INC-DEMO-987095

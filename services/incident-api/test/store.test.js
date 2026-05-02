import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createIncidentStore } from "../src/store.js";

async function createTestStore() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const store = createIncidentStore({ pool: new Pool(), closePool: true });
  await store.init();
  return store;
}

async function createTestStoreContext() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const store = createIncidentStore({ pool, closePool: true });
  await store.init();
  return { pool, store };
}

test("store loads seeded incidents and runbooks", async () => {
  const store = await createTestStore();

  assert.equal((await store.listIncidents()).length, 3);
  assert.equal((await store.listRunbooks()).length, 3);
  assert.equal((await store.listIncidentLogs("INC-1001")).length, 3);
  assert.equal((await store.summarize()).open, 3);
  await store.close();
});

test("store records applied schema migrations", async () => {
  const store = await createTestStore();
  const migrations = await store.listAppliedMigrations();

  assert.equal(migrations.length, 3);
  assert.equal(migrations[0].version, "001");
  assert.equal(migrations[0].name, "core_schema");
  assert.equal(migrations[1].version, "002");
  assert.equal(migrations[1].name, "data_integrity_constraints");
  assert.equal(migrations[2].version, "003");
  assert.equal(migrations[2].name, "local_ops_features");
  assert.equal(typeof migrations[0].checksum, "string");
  assert.equal(typeof migrations[1].checksum, "string");
  assert.equal(typeof migrations[2].checksum, "string");
  await store.close();
});

test("database constraints reject invalid direct writes", async () => {
  const { pool, store } = await createTestStoreContext();

  await assert.rejects(
    pool.query(`
      INSERT INTO incidents (id, service, title, severity, status)
      VALUES ('BAD-SEVERITY', 'incident-api', 'Invalid severity', 'SEV9', 'OPEN')
    `)
  );
  await assert.rejects(
    pool.query(`
      INSERT INTO incident_logs (id, incident_id, level, source, message)
      VALUES ('BAD-LOG', 'INC-1001', 'NOTICE', 'incident-api', 'Unsupported log level')
    `)
  );
  await assert.rejects(
    pool.query(`
      INSERT INTO triage_feedback (id, incident_id, rating, note, triage_source)
      VALUES ('BAD-FEEDBACK', 'INC-1001', 'maybe', '', 'test')
    `)
  );

  await store.close();
});

test("store finds runbooks for patch ingest incidents", async () => {
  const store = await createTestStore();
  const incident = await store.getIncident("INC-1001");

  const runbooks = await store.findRunbooks(incident);

  assert.equal(runbooks[0].id, "RB-API-001");
  await store.close();
});

test("store enforces status update behavior", async () => {
  const store = await createTestStore();

  assert.equal(await store.updateStatus("missing", "RESOLVED"), null);
  assert.equal((await store.updateStatus("INC-1001", "RESOLVED")).status, "RESOLVED");
  assert.equal((await store.summarize()).open, 2);
  await store.close();
});

test("store creates runbooks used by incident triage matching", async () => {
  const store = await createTestStore();

  const runbook = await store.createRunbook({
    id: "RB-TEST-004",
    title: "Connection pool saturation",
    service: "incident-api",
    keywords: ["pool", "saturation"],
    steps: ["Inspect database connection pool usage."]
  });
  const incident = await store.createIncident({
    service: "incident-api",
    title: "Pool saturation caused API timeouts",
    signals: ["pool waiters above baseline"]
  });
  await store.appendIncidentLog(incident.id, {
    level: "ERROR",
    source: "incident-api",
    message: "saturation while checking out connection"
  });
  const logEvents = await store.listIncidentLogs(incident.id);
  const matches = await store.findRunbooks({
    ...incident,
    logEvents
  });

  assert.equal(runbook.id, "RB-TEST-004");
  assert.equal((await store.listRunbooks()).length, 4);
  assert.equal(logEvents.length, 1);
  assert.equal(matches[0].id, "RB-TEST-004");
  await store.close();
});

test("store normalizes write inputs and log limits", async () => {
  const store = await createTestStore();

  const incident = await store.createIncident({
    service: " incident-api ",
    title: " Normalized write input ",
    environment: "",
    region: " us-phoenix-1 ",
    owner: " ",
    deploymentVersion: " v1 ",
    signals: [" first signal ", "", 42]
  });
  const logs = await store.appendIncidentLogs(incident.id, [
    { level: " warn ", source: " api ", message: "   " },
    { level: " warn ", source: " api ", message: " queue depth high " }
  ]);
  const listed = await store.listIncidentLogs(incident.id, { limit: "not-a-number" });

  assert.equal(incident.service, "incident-api");
  assert.equal(incident.environment, "stage");
  assert.deepEqual(incident.signals, ["first signal", "42"]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "WARN");
  assert.equal(logs[0].source, "api");
  assert.equal(listed.length, 1);
  await store.close();
});

test("store health check reports database reachability", async () => {
  const store = await createTestStore();

  const health = await store.healthCheck();

  assert.equal(health.status, "ok");
  assert.equal(typeof health.latencyMs, "number");
  await store.close();
});

test("store persists triage feedback for incidents", async () => {
  const store = await createTestStore();

  const feedback = await store.createTriageFeedback("INC-1001", {
    rating: "useful",
    note: "Matched the rollout failure.",
    triageSource: "ollama-rag"
  });
  const listed = await store.listTriageFeedback("INC-1001");

  assert.equal(feedback.rating, "useful");
  assert.equal(feedback.note, "Matched the rollout failure.");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, feedback.id);
  assert.deepEqual(await store.summarizeTriageFeedback(), {
    total: 1,
    byRating: {
      useful: 1
    }
  });
  await store.close();
});

test("store authenticates seeded local users", async () => {
  const store = await createTestStore();

  const user = await store.authenticateUser("operator", "cloudops");
  const badPassword = await store.authenticateUser("operator", "incorrect");
  const missingUser = await store.authenticateUser("missing", "cloudops");

  assert.equal(user.username, "operator");
  assert.equal(user.role, "operator");
  assert.equal(user.displayName, "Local Operator");
  assert.equal(badPassword, null);
  assert.equal(missingUser, null);
  await store.close();
});

test("store versions runbooks when an existing runbook is updated", async () => {
  const store = await createTestStore();

  const first = await store.createRunbook({
    id: "RB-VERSIONED",
    title: "Initial version",
    service: "incident-api",
    keywords: ["initial"],
    steps: ["Inspect initial signal."],
    createdBy: "operator"
  });
  const second = await store.createRunbook({
    id: "RB-VERSIONED",
    title: "Updated version",
    service: "incident-api",
    keywords: ["updated"],
    steps: ["Inspect updated signal."],
    createdBy: "operator"
  });
  const versions = await store.listRunbookVersions("RB-VERSIONED");

  assert.equal(first.currentVersion, 1);
  assert.equal(first.versionCreated, 1);
  assert.equal(second.currentVersion, 2);
  assert.equal(second.versionCreated, 2);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version, 2);
  assert.equal(versions[0].title, "Updated version");
  assert.equal(versions[1].version, 1);
  await store.close();
});

test("store persists triage jobs with progress and results", async () => {
  const store = await createTestStore();

  const job = await store.createTriageJob("INC-1001", { createdBy: "operator" });
  const running = await store.updateTriageJob(job.id, {
    status: "RUNNING",
    currentStep: "match_runbooks",
    progress: 35,
    steps: job.steps.map((step) => step.id === "match_runbooks" ? { ...step, status: "running" } : step)
  });
  const succeeded = await store.updateTriageJob(job.id, {
    status: "SUCCEEDED",
    currentStep: "complete",
    progress: 100,
    result: {
      source: "incident-api-fallback",
      category: "rollout",
      confidence: 0.72
    }
  });
  const listed = await store.listIncidentTriageJobs("INC-1001");

  assert.equal(job.status, "QUEUED");
  assert.equal(running.status, "RUNNING");
  assert.equal(succeeded.status, "SUCCEEDED");
  assert.equal(succeeded.progress, 100);
  assert.equal(succeeded.result.category, "rollout");
  assert.equal(listed[0].id, job.id);
  await store.close();
});

test("store writes audit timeline events and incident reports", async () => {
  const store = await createTestStore();

  const event = await store.createAuditEvent({
    incidentId: "INC-1001",
    entityType: "incident",
    entityId: "INC-1001",
    action: "incident.created",
    actor: "operator",
    metadata: { source: "test" }
  });
  await store.createTriageJob("INC-1001", { id: "JOB-REPORT", createdBy: "operator" });
  await store.updateTriageJob("JOB-REPORT", {
    status: "SUCCEEDED",
    currentStep: "complete",
    progress: 100,
    result: {
      source: "incident-api-fallback",
      category: "rollout",
      confidence: 0.72,
      summary: "Patch ingest failed",
      probableRootCause: "ERROR patch ingest rejected",
      recommendedActions: ["Retry ingest after validation."],
      runbooks: [{ id: "RB-API-001", title: "Partner API patch ingest failures" }]
    }
  });

  const events = await store.listAuditEvents("INC-1001");
  const report = await store.buildIncidentReport("INC-1001");

  assert.equal(events[0].id, event.id);
  assert.equal(events[0].metadata.source, "test");
  assert.match(report, /# Incident Report: INC-1001/);
  assert.match(report, /## Runtime Logs/);
  assert.match(report, /## Triage Result/);
  assert.match(report, /Retry ingest after validation/);
  assert.equal(await store.buildIncidentReport("missing"), null);
  await store.close();
});

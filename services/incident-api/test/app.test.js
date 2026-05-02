import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createApp } from "../src/app.js";
import { createHs256Jwt } from "../src/auth.js";
import { createIncidentStore } from "../src/store.js";

const writeHeaders = {
  "content-type": "application/json",
  "x-user-role": "operator"
};

async function createTestApi(options = {}) {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const store = createIncidentStore({ pool: new Pool(), closePool: true });
  await store.init();

  const app = createApp({
    store,
    triageAgentUrl: null,
    enableAccessLogs: false,
    ...options
  });
  const server = await listen(app);
  const { port } = server.address();

  return {
    store,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await closeServer(server);
      await store.close();
    }
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForJob(baseUrl, jobId) {
  for (let index = 0; index < 30; index += 1) {
    const response = await fetch(`${baseUrl}/triage-jobs/${jobId}`);
    const payload = await response.json();
    if (["SUCCEEDED", "FAILED"].includes(payload.status)) {
      return { response, payload };
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for triage job ${jobId}`);
}

test("API rejects invalid incident severity and status values", async () => {
  const api = await createTestApi();

  const invalidSeverity = await fetch(`${api.baseUrl}/incidents`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      service: "incident-api",
      title: "Invalid severity should be rejected",
      severity: "SEV9"
    })
  });
  const invalidSeverityPayload = await invalidSeverity.json();

  assert.equal(invalidSeverity.status, 400);
  assert.equal(invalidSeverityPayload.field, "severity");
  assert.match(invalidSeverityPayload.requestId, /^req-/);
  assert.deepEqual(invalidSeverityPayload.allowed, ["SEV1", "SEV2", "SEV3", "SEV4"]);

  const invalidStatus = await fetch(`${api.baseUrl}/incidents/INC-1001/status`, {
    method: "PATCH",
    headers: writeHeaders,
    body: JSON.stringify({ status: "DONE" })
  });
  const invalidStatusPayload = await invalidStatus.json();

  assert.equal(invalidStatus.status, 400);
  assert.equal(invalidStatusPayload.field, "status");
  assert.match(invalidStatusPayload.requestId, /^req-/);
  assert.deepEqual(invalidStatusPayload.allowed, ["OPEN", "TRIAGED", "MITIGATING", "RESOLVED"]);

  await api.close();
});

test("API handles malformed log payloads without crashing", async () => {
  const api = await createTestApi();

  const malformedLogs = await fetch(`${api.baseUrl}/incidents/INC-1001/logs`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      logs: [null, 42, ""]
    })
  });
  const malformedLogsPayload = await malformedLogs.json();

  assert.equal(malformedLogs.status, 400);
  assert.equal(malformedLogsPayload.error, "missing_required_fields");

  const invalidLogLevel = await fetch(`${api.baseUrl}/incidents/INC-1001/logs`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      logs: [{ level: "NOTICE", message: "unsupported log level" }]
    })
  });
  const invalidLogLevelPayload = await invalidLogLevel.json();

  assert.equal(invalidLogLevel.status, 400);
  assert.equal(invalidLogLevelPayload.field, "level");

  const validLogs = await fetch(`${api.baseUrl}/incidents/INC-1001/logs`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      logs: [null, { level: "warn", source: "incident-api", message: " queue depth high " }]
    })
  });
  const validLogsPayload = await validLogs.json();

  assert.equal(validLogs.status, 201);
  assert.equal(validLogsPayload.length, 1);
  assert.equal(validLogsPayload[0].level, "WARN");
  assert.equal(validLogsPayload[0].message, "queue depth high");

  await api.close();
});

test("API imports local log files and builds a unified incident timeline", async () => {
  const api = await createTestApi();

  const imported = await fetch(`${api.baseUrl}/incidents/INC-1001/log-import`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      filename: "runtime.log",
      content: [
        "2026-05-02T10:00:00Z ERROR worker: imported patch failure",
        "2026-05-02T10:00:01Z WARN worker: retry budget low",
        "plain imported info line"
      ].join("\n")
    })
  });
  const importedPayload = await imported.json();

  assert.equal(imported.status, 201);
  assert.equal(importedPayload.importedCount, 3);
  assert.equal(importedPayload.logs[0].level, "ERROR");
  assert.equal(importedPayload.logs[0].source, "worker");
  assert.equal(importedPayload.logs[0].attributes.imported, true);
  assert.equal(importedPayload.logs[0].attributes.filename, "runtime.log");

  const timeline = await (await fetch(`${api.baseUrl}/incidents/INC-1001/timeline`)).json();
  assert.equal(timeline.some((event) => event.type === "log" && event.detail.includes("imported patch failure")), true);
  assert.equal(timeline.some((event) => event.type === "audit" && event.title === "incident.logs_imported"), true);
  assert.equal(timeline.some((event) => event.type === "incident" && event.title === "Incident created"), true);

  const unsupported = await fetch(`${api.baseUrl}/incidents/INC-1001/log-import`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      filename: "runtime.csv",
      content: "ERROR unsupported file"
    })
  });
  const unsupportedPayload = await unsupported.json();

  assert.equal(unsupported.status, 400);
  assert.equal(unsupportedPayload.error, "unsupported_log_import_type");

  await api.close();
});

test("API returns structured JSON for malformed request bodies", async () => {
  const api = await createTestApi();

  const response = await fetch(`${api.baseUrl}/incidents`, {
    method: "POST",
    headers: writeHeaders,
    body: "{"
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, "invalid_json");
  assert.match(payload.requestId, /^req-/);
  assert.equal(response.headers.get("x-request-id"), payload.requestId);
  assert.equal(response.headers.get("access-control-expose-headers"), "X-Request-Id");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");

  await api.close();
});

test("API returns JSON for unknown routes", async () => {
  const api = await createTestApi();

  const response = await fetch(`${api.baseUrl}/missing-route`, {
    headers: {
      "x-request-id": "test-request-123"
    }
  });
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-request-id"), "test-request-123");
  assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
  assert.equal(payload.error, "not_found");
  assert.equal(payload.requestId, "test-request-123");
  assert.match(payload.message, /GET \/missing-route/);

  await api.close();
});

test("API keeps metrics route labels bounded for unknown paths", async () => {
  const api = await createTestApi();

  const firstMissing = await fetch(`${api.baseUrl}/missing-route`, {
    headers: { "x-request-id": "req-metrics-missing-1" }
  });
  const secondMissing = await fetch(`${api.baseUrl}/another/missing/path`, {
    headers: { "x-request-id": "req-metrics-missing-2" }
  });
  const metrics = await fetch(`${api.baseUrl}/metrics`);
  const text = await metrics.text();

  assert.equal(firstMissing.status, 404);
  assert.equal(secondMissing.status, 404);
  assert.equal(metrics.status, 200);
  assert.match(text, /cloudops_http_requests_total\{method="GET",route="GET unmatched",status="404"\} 2/);
  assert.equal(text.includes("/missing-route"), false);
  assert.equal(text.includes("/another/missing/path"), false);

  await api.close();
});

test("API emits structured access logs with request ids", async () => {
  const accessLogs = [];
  const api = await createTestApi({
    enableAccessLogs: true,
    logger: {
      info(line) {
        accessLogs.push(JSON.parse(line));
      },
      error(line) {
        accessLogs.push(JSON.parse(line));
      }
    }
  });

  const response = await fetch(`${api.baseUrl}/health?token=secret`, {
    headers: {
      "x-request-id": "req-log-1"
    }
  });

  assert.equal(response.status, 200);
  assert.equal(accessLogs.length, 1);
  assert.equal(accessLogs[0].event, "http_request");
  assert.equal(accessLogs[0].requestId, "req-log-1");
  assert.equal(accessLogs[0].method, "GET");
  assert.equal(accessLogs[0].route, "GET /health");
  assert.equal(accessLogs[0].path, "/health");
  assert.equal(JSON.stringify(accessLogs[0]).includes("secret"), false);
  assert.equal(accessLogs[0].status, 200);
  assert.equal(typeof accessLogs[0].durationMs, "number");

  await api.close();
});

test("API rate limits excessive client requests", async () => {
  const api = await createTestApi({
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 2
  });

  const first = await fetch(`${api.baseUrl}/summary`, {
    headers: { "x-request-id": "req-rate-1" }
  });
  const second = await fetch(`${api.baseUrl}/summary`, {
    headers: { "x-request-id": "req-rate-2" }
  });
  const third = await fetch(`${api.baseUrl}/summary`, {
    headers: { "x-request-id": "req-rate-3" }
  });
  const payload = await third.json();

  assert.equal(first.status, 200);
  assert.equal(first.headers.get("ratelimit-limit"), "2");
  assert.equal(first.headers.get("ratelimit-remaining"), "1");
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("ratelimit-remaining"), "0");
  assert.equal(third.status, 429);
  assert.equal(third.headers.get("x-request-id"), "req-rate-3");
  assert.equal(third.headers.get("retry-after") !== null, true);
  assert.equal(payload.error, "rate_limit_exceeded");
  assert.equal(payload.requestId, "req-rate-3");

  const health = await fetch(`${api.baseUrl}/health`, {
    headers: { "x-request-id": "req-rate-health" }
  });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("ratelimit-limit"), null);

  await api.close();
});

test("API enforces bearer-token auth when JWT secret is configured", async () => {
  const jwtSecret = "test-secret";
  const api = await createTestApi({ jwtSecret });

  const roleHeaderOnly = await fetch(`${api.baseUrl}/incidents`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      service: "incident-api",
      title: "Role header should not bypass JWT auth"
    })
  });
  assert.equal(roleHeaderOnly.status, 401);

  const viewerToken = createHs256Jwt({ sub: "viewer-1", role: "viewer" }, jwtSecret);
  const viewerResponse = await fetch(`${api.baseUrl}/incidents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${viewerToken}`
    },
    body: JSON.stringify({
      service: "incident-api",
      title: "Viewer should not write"
    })
  });
  assert.equal(viewerResponse.status, 403);

  const operatorToken = createHs256Jwt({ sub: "operator-1", role: "operator" }, jwtSecret);
  const operatorResponse = await fetch(`${api.baseUrl}/incidents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${operatorToken}`
    },
    body: JSON.stringify({
      service: "incident-api",
      title: "Operator can write with JWT"
    })
  });
  const incident = await operatorResponse.json();

  assert.equal(operatorResponse.status, 201);
  assert.equal(incident.title, "Operator can write with JWT");

  await api.close();
});

test("API issues local login bearer tokens for write operations", async () => {
  const api = await createTestApi({ allowRoleHeaderFallback: false, jwtSecret: "" });

  const login = await fetch(`${api.baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "operator",
      password: "cloudops"
    })
  });
  const loginPayload = await login.json();

  assert.equal(login.status, 200);
  assert.equal(loginPayload.tokenType, "Bearer");
  assert.equal(loginPayload.user.username, "operator");
  assert.equal(loginPayload.user.role, "operator");

  const created = await fetch(`${api.baseUrl}/incidents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${loginPayload.token}`
    },
    body: JSON.stringify({
      service: "incident-api",
      title: "Login token can create incidents"
    })
  });
  const incident = await created.json();

  assert.equal(created.status, 201);
  assert.equal(incident.title, "Login token can create incidents");

  const invalidLogin = await fetch(`${api.baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "operator",
      password: "bad-password"
    })
  });

  assert.equal(invalidLogin.status, 401);
  await api.close();
});

test("API runs asynchronous triage jobs with persisted progress and audit events", async () => {
  const api = await createTestApi({ triageDelayMs: 25 });

  const queued = await fetch(`${api.baseUrl}/incidents/INC-1001/triage-jobs`, {
    method: "POST",
    headers: writeHeaders
  });
  const job = await queued.json();

  assert.equal(queued.status, 202);
  assert.equal(job.status, "QUEUED");
  assert.equal(job.incidentId, "INC-1001");

  const { payload: completedJob } = await waitForJob(api.baseUrl, job.id);
  assert.equal(completedJob.status, "SUCCEEDED");
  assert.equal(completedJob.progress, 100);
  assert.equal(completedJob.result.source, "incident-api-fallback");
  assert.equal(completedJob.result.evidence.logLines.length > 0, true);
  assert.equal(completedJob.result.evidence.runbooks[0].id, "RB-API-001");
  assert.equal(completedJob.steps.every((step) => step.status === "complete"), true);

  const jobs = await (await fetch(`${api.baseUrl}/incidents/INC-1001/triage-jobs`)).json();
  assert.equal(jobs[0].id, job.id);

  const auditEvents = await (await fetch(`${api.baseUrl}/incidents/INC-1001/audit-events`)).json();
  assert.equal(auditEvents.some((event) => event.action === "triage_job.queued"), true);
  assert.equal(auditEvents.some((event) => event.action === "triage_job.succeeded"), true);

  await api.close();
});

test("API exports incident reports and exposes runbook versions", async () => {
  const api = await createTestApi();

  const runbook = await fetch(`${api.baseUrl}/runbooks`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      id: "RB-API-REPORT",
      title: "Reportable runbook",
      service: "incident-api",
      keywords: ["reportable"],
      steps: ["Use the report export."]
    })
  });
  assert.equal(runbook.status, 201);

  const updatedRunbook = await fetch(`${api.baseUrl}/runbooks`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      id: "RB-API-REPORT",
      title: "Reportable runbook v2",
      service: "incident-api",
      keywords: ["reportable", "updated"],
      steps: ["Use the report export.", "Attach markdown to the ticket."]
    })
  });
  const updatedRunbookPayload = await updatedRunbook.json();
  assert.equal(updatedRunbook.status, 201);
  assert.equal(updatedRunbookPayload.currentVersion, 2);

  const versionsResponse = await fetch(`${api.baseUrl}/runbooks/RB-API-REPORT/versions`);
  const versions = await versionsResponse.json();
  assert.equal(versionsResponse.status, 200);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version, 2);

  const reportResponse = await fetch(`${api.baseUrl}/incidents/INC-1001/report.md`);
  const report = await reportResponse.text();

  assert.equal(reportResponse.status, 200);
  assert.equal(reportResponse.headers.get("content-type")?.includes("text/markdown"), true);
  assert.match(reportResponse.headers.get("content-disposition"), /INC-1001-incident-report\.md/);
  assert.match(report, /# Incident Report: INC-1001/);
  assert.match(report, /## Audit Timeline/);

  await api.close();
});

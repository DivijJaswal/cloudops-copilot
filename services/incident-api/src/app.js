import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import { authorizeBearerToken, createHs256Jwt } from "./auth.js";
import { createIncidentStore } from "./store.js";
import { requestTriage } from "./triageClient.js";

const writeRoles = new Set(["operator", "admin"]);
const feedbackRatings = new Set(["useful", "incorrect", "needs-work"]);
const allowedSeverities = new Set(["SEV1", "SEV2", "SEV3", "SEV4"]);
const allowedStatuses = new Set(["OPEN", "TRIAGED", "MITIGATING", "RESOLVED"]);
const allowedLogLevels = new Set(["DEBUG", "INFO", "WARN", "ERROR"]);
const allowedLogImportExtensions = new Set([".log", ".txt", ".jsonl", ".json"]);

function createRequireWriteRole({ authSecret, allowRoleHeaderFallback }) {
  return (req, res, next) => {
    if (req.header("authorization")?.startsWith("Bearer ")) {
      const auth = authorizeBearerToken(req.header("authorization"), authSecret, writeRoles);
      if (!auth.ok) {
        return sendError(req, res, auth.status, {
          error: auth.error,
          message: auth.message
        });
      }
      req.user = auth.claims;
      return next();
    }

    if (allowRoleHeaderFallback) {
      const role = req.header("x-user-role") ?? "viewer";
      if (writeRoles.has(role)) {
        req.user = { role, authMode: "role-header" };
        return next();
      }
    }

    if (!allowRoleHeaderFallback) {
      return sendError(req, res, 401, {
        error: "missing_bearer_token",
        message: "Write operations require an Authorization bearer token."
      });
    }

    return sendError(req, res, 403, {
      error: "forbidden",
      message: "Write operations require an operator or admin role."
    });
  };
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function normalizeRequestId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : null;
}

function applyRequestId(req, res, next) {
  const requestId = normalizeRequestId(req.header("x-request-id")) ?? `req-${randomUUID()}`;
  req.id = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}

function applySecurityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}

function handleJsonParseError(err, req, res, next) {
  if (err?.type === "entity.parse.failed") {
    return sendError(req, res, 400, {
      error: "invalid_json",
      message: "Request body must be valid JSON."
    });
  }

  if (err?.type === "entity.too.large") {
    return sendError(req, res, 413, {
      error: "payload_too_large",
      message: "Request body exceeds the configured 1 MB limit."
    });
  }

  return next(err);
}

function sendError(req, res, statusCode, payload) {
  return res.status(statusCode).json({
    ...payload,
    requestId: req.id
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function createRateLimiter({ windowMs = 60000, maxRequests = 600, skipPaths = new Set(["/health", "/metrics"]) } = {}) {
  const buckets = new Map();
  let nextSweepAt = Date.now() + windowMs;

  return (req, res, next) => {
    if (maxRequests <= 0 || skipPaths.has(req.path)) {
      return next();
    }

    const now = Date.now();
    if (now >= nextSweepAt) {
      for (const [clientId, bucket] of buckets.entries()) {
        if (bucket.resetAt <= now) {
          buckets.delete(clientId);
        }
      }
      nextSweepAt = now + windowMs;
    }

    const clientId = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const bucket = buckets.get(clientId);
    const currentBucket = bucket && bucket.resetAt > now
      ? bucket
      : { count: 0, resetAt: now + windowMs };
    const resetSeconds = Math.ceil((currentBucket.resetAt - now) / 1000);

    if (currentBucket.count >= maxRequests) {
      res.setHeader("Retry-After", String(resetSeconds));
      res.setHeader("RateLimit-Limit", String(maxRequests));
      res.setHeader("RateLimit-Remaining", "0");
      res.setHeader("RateLimit-Reset", String(resetSeconds));
      buckets.set(clientId, currentBucket);
      return sendError(req, res, 429, {
        error: "rate_limit_exceeded",
        message: "Too many requests. Retry after the current rate-limit window resets."
      });
    }

    currentBucket.count += 1;
    buckets.set(clientId, currentBucket);
    res.setHeader("RateLimit-Limit", String(maxRequests));
    res.setHeader("RateLimit-Remaining", String(Math.max(maxRequests - currentBucket.count, 0)));
    res.setHeader("RateLimit-Reset", String(resetSeconds));
    return next();
  };
}

function requireBodyFields(req, res, fields) {
  const body = req.body ?? {};
  const missing = fields.filter((field) => {
    const value = body[field];
    return typeof value === "string" ? value.trim().length === 0 : !value;
  });
  if (missing.length > 0) {
    sendError(req, res, 400, { error: "missing_required_fields", fields: missing });
    return false;
  }
  return true;
}

function cleanText(value, fallback = undefined) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function cleanUpperText(value, fallback = undefined) {
  const text = cleanText(value, fallback);
  return typeof text === "string" ? text.toUpperCase() : text;
}

function validateAllowedValue(req, res, field, value, allowedValues) {
  if (allowedValues.has(value)) {
    return true;
  }

  sendError(req, res, 400, {
    error: "invalid_field_value",
    field,
    allowed: [...allowedValues]
  });
  return false;
}

function cleanLineList(value, splitter = /\n/) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(splitter)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeLogInput(log) {
  if (typeof log === "string") {
    return { message: log };
  }
  if (log && typeof log === "object" && !Array.isArray(log)) {
    return log;
  }
  return {};
}

function normalizeLogInputs(body) {
  if (!body || typeof body !== "object") {
    return [];
  }

  if (Array.isArray(body.logs)) {
    return body.logs.map(normalizeLogInput);
  }
  if (Array.isArray(body.messages)) {
    return body.messages.map((message) => ({ message }));
  }
  if (body.message) {
    return [body];
  }
  return [];
}

function formatLogForTriage(log) {
  return `${log.observedAt} ${log.level} ${log.source}: ${log.message}`;
}

function extensionFromFilename(filename) {
  const cleanName = cleanText(filename, "runtime.log").toLowerCase();
  const dotIndex = cleanName.lastIndexOf(".");
  return dotIndex >= 0 ? cleanName.slice(dotIndex) : ".log";
}

function parseImportedLogs({ filename, content, source }, incident) {
  const importFilename = cleanText(filename, "runtime.log");
  const extension = extensionFromFilename(importFilename);
  if (!allowedLogImportExtensions.has(extension)) {
    const error = new Error("Unsupported log import file type.");
    error.statusCode = 400;
    error.payload = {
      error: "unsupported_log_import_type",
      allowed: [...allowedLogImportExtensions]
    };
    throw error;
  }

  const importSource = cleanText(source, incident.service);
  const text = typeof content === "string" ? content : "";
  const rawEntries = extension === ".json" ? parseJsonLogFile(text) : parseLineLogFile(text, extension);
  return rawEntries
    .map((entry, index) => normalizeImportedLog(entry, index, importFilename, importSource))
    .filter((entry) => entry.message);
}

function parseJsonLogFile(content) {
  const parsed = JSON.parse(content);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.logs)) return parsed.logs;
  if (Array.isArray(parsed.messages)) return parsed.messages;
  return [parsed];
}

function parseLineLogFile(content, extension) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (extension !== ".jsonl") return line;
      try {
        return JSON.parse(line);
      } catch {
        return line;
      }
    });
}

function normalizeImportedLog(entry, index, filename, importSource) {
  const base = typeof entry === "string" ? parseLogLine(entry) : parseStructuredLog(entry);
  const message = cleanText(base.message);
  if (!message) return {};

  return {
    observedAt: normalizeObservedAt(base.observedAt),
    level: cleanUpperText(base.level, undefined),
    source: cleanText(base.source, importSource),
    message,
    attributes: {
      ...(base.attributes ?? {}),
      imported: true,
      filename,
      lineNumber: index + 1
    }
  };
}

function parseStructuredLog(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { message: "" };
  }

  return {
    observedAt: entry.observedAt ?? entry.timestamp ?? entry.time ?? entry["@timestamp"],
    level: entry.level ?? entry.severity ?? entry.logLevel,
    source: entry.source ?? entry.logger ?? entry.service,
    message: entry.message ?? entry.msg ?? entry.log ?? entry.text ?? JSON.stringify(entry),
    attributes: entry.attributes
  };
}

function parseLogLine(line) {
  const match = line.match(/^(?:(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+)?(?:(DEBUG|INFO|WARN|ERROR)\s+)?(?:(\S+?):\s+)?(.+)$/i);
  if (!match) return { message: line };

  return {
    observedAt: match[1],
    level: match[2],
    source: match[3],
    message: match[4] ?? line
  };
}

function normalizeObservedAt(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function actorFromRequest(req) {
  const user = req.user ?? {};
  return (
    cleanText(user.displayName) ??
    cleanText(user.username) ??
    cleanText(user.sub) ??
    cleanText(user.role) ??
    "anonymous"
  );
}

function reportFilename(incidentId) {
  return `${String(incidentId).replace(/[^A-Za-z0-9._-]/g, "_")}-incident-report.md`;
}

function markTriageSteps(steps, currentStep, status = "RUNNING") {
  const stepList = Array.isArray(steps) ? steps : [];
  const currentIndex = stepList.findIndex((step) => step.id === currentStep);

  return stepList.map((step, index) => {
    if (status === "FAILED" && step.id === currentStep) {
      return { ...step, status: "failed" };
    }
    if (status === "SUCCEEDED") {
      return { ...step, status: "complete" };
    }
    if (currentIndex >= 0 && index < currentIndex) {
      return { ...step, status: "complete" };
    }
    if (step.id === currentStep) {
      return { ...step, status: "running" };
    }
    return { ...step, status: step.status === "complete" ? "complete" : "pending" };
  });
}

function mergeTriageOrchestrationSteps(existingSteps, orchestrationSteps = []) {
  if (!Array.isArray(orchestrationSteps) || orchestrationSteps.length === 0) {
    return markTriageSteps(existingSteps, "save_memory", "SUCCEEDED");
  }

  const labels = new Map((existingSteps ?? []).map((step) => [step.id, step.label]));
  const seen = new Set();
  const merged = [];

  for (const step of existingSteps ?? []) {
    if (orchestrationSteps.includes(step.id) || step.id === "queued") {
      merged.push({ ...step, status: "complete" });
      seen.add(step.id);
    }
  }

  for (const step of orchestrationSteps) {
    if (seen.has(step)) continue;
    merged.push({
      id: step,
      label: labels.get(step) ?? step.replaceAll("_", " "),
      status: "complete"
    });
  }

  return merged;
}

async function checkTriageAgentHealth(agentUrl, timeoutMs = 1500) {
  if (!agentUrl) {
    return {
      status: "fallback",
      configured: false,
      message: "Triage agent URL is not configured; API fallback triage is active."
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${agentUrl}/health`, {
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        status: "down",
        configured: true,
        message: payload.error ?? `Health check returned ${response.status}`
      };
    }

    return {
      status: payload.status === "ok" ? "ok" : "degraded",
      configured: true,
      llmTriage: Boolean(payload.llmTriage),
      vectorMemory: Boolean(payload.vectorMemory),
      triageOrchestration: payload.triageOrchestration ?? "unknown",
      service: payload.service ?? "triage-agent"
    };
  } catch (error) {
    return {
      status: "down",
      configured: true,
      message: error.name === "AbortError" ? "Health check timed out." : "Health check failed."
    };
  } finally {
    clearTimeout(timer);
  }
}

function overallHealthStatus(services) {
  const statuses = Object.values(services).map((service) => service.status);
  if (statuses.includes("down")) return "degraded";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

function createMetrics() {
  return {
    startedAt: Date.now(),
    httpRequests: new Map(),
    httpRequestDurationSeconds: new Map(),
    triageRequests: new Map(),
    triageDurationSecondsSum: 0,
    triageDurationSecondsCount: 0,
    triageFallbackTotal: 0,
    triageErrorsTotal: 0
  };
}

function metricKey(labels) {
  return JSON.stringify(labels);
}

function incrementMetric(map, labels, amount = 1) {
  const key = metricKey(labels);
  const entry = map.get(key) ?? { labels, value: 0 };
  entry.value += amount;
  map.set(key, entry);
}

function getRouteLabel(req, res = null) {
  const routePath = req.route?.path ?? (res?.statusCode === 404 ? "unmatched" : "middleware");
  return `${req.method} ${routePath}`;
}

function getSafeRequestPath(req) {
  return typeof req.path === "string" && req.path.length > 0 ? req.path : "/";
}

function observeHttpRequest(metrics, req, res, startedAt) {
  const labels = {
    method: req.method,
    route: getRouteLabel(req, res),
    status: String(res.statusCode)
  };
  const durationSeconds = (Date.now() - startedAt) / 1000;
  incrementMetric(metrics.httpRequests, labels);
  incrementMetric(metrics.httpRequestDurationSeconds, labels, durationSeconds);
}

function writeStructuredLog(logger, level, event, fields) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields
  };
  const line = JSON.stringify(record);
  const writer = level === "error" ? logger.error : (logger.info ?? logger.log);
  writer.call(logger, line);
}

function logHttpRequest(logger, req, res, startedAt) {
  writeStructuredLog(logger, "info", "http_request", {
    requestId: req.id,
    method: req.method,
    route: getRouteLabel(req, res),
    path: getSafeRequestPath(req),
    status: res.statusCode,
    durationMs: Date.now() - startedAt
  });
}

function logUnhandledError(logger, req, err) {
  writeStructuredLog(logger, "error", "unhandled_error", {
    requestId: req.id,
    method: req.method,
    route: getRouteLabel(req),
    path: getSafeRequestPath(req),
    message: err.message,
    code: err.code,
    stack: err.stack
  });
}

function observeTriage(metrics, triage, startedAt) {
  const source = triage?.source ?? "unknown";
  metrics.triageDurationSecondsSum += (Date.now() - startedAt) / 1000;
  metrics.triageDurationSecondsCount += 1;
  incrementMetric(metrics.triageRequests, { source });

  if (source !== "ollama-rag") {
    metrics.triageFallbackTotal += 1;
  }
}

function observeTriageError(metrics, startedAt) {
  metrics.triageDurationSecondsSum += (Date.now() - startedAt) / 1000;
  metrics.triageDurationSecondsCount += 1;
  metrics.triageErrorsTotal += 1;
}

function escapeMetricLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\"", "\\\"");
}

function formatLabels(labels = {}) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeMetricLabel(value)}"`).join(",")}}`;
}

function appendMetricMap(lines, metricName, map) {
  for (const { labels, value } of map.values()) {
    lines.push(`${metricName}${formatLabels(labels)} ${value}`);
  }
}

function renderMetrics(metrics, summary, feedbackSummary) {
  const lines = [
    "# HELP cloudops_process_uptime_seconds Seconds since the Incident API process started.",
    "# TYPE cloudops_process_uptime_seconds gauge",
    `cloudops_process_uptime_seconds ${(Date.now() - metrics.startedAt) / 1000}`,
    "# HELP cloudops_incidents_total Total incidents loaded by CloudOps Copilot.",
    "# TYPE cloudops_incidents_total gauge",
    `cloudops_incidents_total ${summary.total}`,
    "# HELP cloudops_incidents_open Open incidents loaded by CloudOps Copilot.",
    "# TYPE cloudops_incidents_open gauge",
    `cloudops_incidents_open ${summary.open}`,
    "# HELP cloudops_incidents_by_status Current incident count by status.",
    "# TYPE cloudops_incidents_by_status gauge"
  ];

  for (const [status, count] of Object.entries(summary.byStatus ?? {})) {
    lines.push(`cloudops_incidents_by_status${formatLabels({ status })} ${count}`);
  }

  lines.push(
    "# HELP cloudops_incidents_by_severity Current incident count by severity.",
    "# TYPE cloudops_incidents_by_severity gauge"
  );
  for (const [severity, count] of Object.entries(summary.bySeverity ?? {})) {
    lines.push(`cloudops_incidents_by_severity${formatLabels({ severity })} ${count}`);
  }

  lines.push(
    "# HELP cloudops_http_requests_total HTTP requests handled by route and status.",
    "# TYPE cloudops_http_requests_total counter"
  );
  appendMetricMap(lines, "cloudops_http_requests_total", metrics.httpRequests);

  lines.push(
    "# HELP cloudops_http_request_duration_seconds_sum Total HTTP request duration by route and status.",
    "# TYPE cloudops_http_request_duration_seconds_sum counter"
  );
  appendMetricMap(lines, "cloudops_http_request_duration_seconds_sum", metrics.httpRequestDurationSeconds);

  lines.push(
    "# HELP cloudops_http_request_duration_seconds_count HTTP request duration sample count by route and status.",
    "# TYPE cloudops_http_request_duration_seconds_count counter"
  );
  appendMetricMap(lines, "cloudops_http_request_duration_seconds_count", metrics.httpRequests);

  lines.push(
    "# HELP cloudops_triage_requests_total Triage requests by result source.",
    "# TYPE cloudops_triage_requests_total counter"
  );
  appendMetricMap(lines, "cloudops_triage_requests_total", metrics.triageRequests);

  lines.push(
    "# HELP cloudops_triage_duration_seconds_sum Total triage request duration.",
    "# TYPE cloudops_triage_duration_seconds_sum counter",
    `cloudops_triage_duration_seconds_sum ${metrics.triageDurationSecondsSum}`,
    "# HELP cloudops_triage_duration_seconds_count Triage request duration sample count.",
    "# TYPE cloudops_triage_duration_seconds_count counter",
    `cloudops_triage_duration_seconds_count ${metrics.triageDurationSecondsCount}`,
    "# HELP cloudops_triage_fallback_total Triage requests served by fallback logic.",
    "# TYPE cloudops_triage_fallback_total counter",
    `cloudops_triage_fallback_total ${metrics.triageFallbackTotal}`,
    "# HELP cloudops_triage_errors_total Triage requests that failed before a result was produced.",
    "# TYPE cloudops_triage_errors_total counter",
    `cloudops_triage_errors_total ${metrics.triageErrorsTotal}`,
    "# HELP cloudops_triage_feedback_count Persisted triage feedback count.",
    "# TYPE cloudops_triage_feedback_count gauge",
    `cloudops_triage_feedback_count ${feedbackSummary.total}`,
    "# HELP cloudops_triage_feedback_by_rating Persisted triage feedback count by rating.",
    "# TYPE cloudops_triage_feedback_by_rating gauge"
  );

  for (const [rating, count] of Object.entries(feedbackSummary.byRating ?? {})) {
    lines.push(`cloudops_triage_feedback_by_rating${formatLabels({ rating })} ${count}`);
  }

  return `${lines.join("\n")}\n`;
}

export function createApp(options = {}) {
  const store = options.store ?? createIncidentStore();
  const triageAgentUrl = options.triageAgentUrl ?? process.env.TRIAGE_AGENT_URL;
  const triageTimeoutMs = options.triageTimeoutMs ?? process.env.TRIAGE_AGENT_TIMEOUT_MS;
  const triageDelayMs = Number(options.triageDelayMs ?? process.env.TRIAGE_RESPONSE_DELAY_MS ?? 0);
  const metrics = options.metrics ?? createMetrics();
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN;
  const configuredJwtSecret = cleanText(options.jwtSecret ?? process.env.JWT_SECRET);
  const localAuthSecret = cleanText(process.env.LOCAL_AUTH_SECRET);
  const authSecret = configuredJwtSecret ?? localAuthSecret ?? "cloudops-local-dev-secret";
  const authTokenTtlSeconds = parsePositiveInteger(
    options.authTokenTtlSeconds ?? process.env.LOCAL_AUTH_TOKEN_TTL_SECONDS,
    24 * 60 * 60
  );
  const allowRoleHeaderFallback = options.allowRoleHeaderFallback ?? !configuredJwtSecret;
  const logger = options.logger ?? console;
  const enableAccessLogs = options.enableAccessLogs ?? process.env.ACCESS_LOGS !== "false";
  const rateLimitWindowMs = parsePositiveInteger(
    options.rateLimitWindowMs ?? process.env.RATE_LIMIT_WINDOW_MS,
    60000
  );
  const rateLimitMaxRequests = parseNonNegativeInteger(
    options.rateLimitMaxRequests ?? process.env.RATE_LIMIT_MAX,
    600
  );
  const requireWriteRole = createRequireWriteRole({ authSecret, allowRoleHeaderFallback });
  const app = express();

  async function recordAudit(req, input) {
    try {
      await store.createAuditEvent({
        actor: actorFromRequest(req),
        ...input
      });
    } catch (error) {
      writeStructuredLog(logger, "error", "audit_write_failed", {
        requestId: req.id,
        action: input.action,
        message: error.message
      });
    }
  }

  async function updateTriageJobProgress(job, patch) {
    const steps = patch.steps ?? markTriageSteps(job.steps, patch.currentStep, patch.status);
    const updated = await store.updateTriageJob(job.id, {
      ...patch,
      steps
    });
    return updated ?? job;
  }

  async function runTriageJob(jobId, requestId) {
    const triageStartedAt = Date.now();
    let job = await store.getTriageJob(jobId);
    if (!job) return;

    try {
      job = await updateTriageJobProgress(job, {
        status: "RUNNING",
        currentStep: "collect_evidence",
        progress: 10
      });

      const incident = await store.getIncident(job.incidentId);
      if (!incident) {
        throw new Error(`Incident ${job.incidentId} no longer exists.`);
      }

      const logEvents = await store.listIncidentLogs(job.incidentId, { limit: 500 });
      const incidentWithRuntimeLogs = {
        ...incident,
        logs: logEvents.map(formatLogForTriage),
        logEvents
      };

      job = await updateTriageJobProgress(job, {
        status: "RUNNING",
        currentStep: "match_runbooks",
        progress: 30
      });
      const runbooks = await store.findRunbooks(incidentWithRuntimeLogs);

      job = await updateTriageJobProgress(job, {
        status: "RUNNING",
        currentStep: "retrieve_memory",
        progress: 50
      });

      if (triageDelayMs > 0) {
        await sleep(triageDelayMs);
      }

      job = await updateTriageJobProgress(job, {
        status: "RUNNING",
        currentStep: "draft_llm_triage",
        progress: 72
      });
      const triage = await requestTriage(incidentWithRuntimeLogs, runbooks, triageAgentUrl, {
        timeoutMs: triageTimeoutMs,
        requestId
      });

      job = await updateTriageJobProgress(job, {
        status: "RUNNING",
        currentStep: "save_memory",
        progress: 92
      });
      observeTriage(metrics, triage, triageStartedAt);

      await store.updateTriageJob(job.id, {
        status: "SUCCEEDED",
        currentStep: "complete",
        progress: 100,
        steps: mergeTriageOrchestrationSteps(job.steps, triage.orchestration?.steps),
        result: triage,
        error: null
      });
      await store.createAuditEvent({
        incidentId: job.incidentId,
        entityType: "triage_job",
        entityId: job.id,
        action: "triage_job.succeeded",
        actor: job.createdBy,
        metadata: {
          source: triage.source,
          category: triage.category,
          confidence: triage.confidence,
          requestId
        }
      });
    } catch (error) {
      observeTriageError(metrics, triageStartedAt);
      const latestJob = await store.getTriageJob(jobId);
      if (latestJob) {
        await store.updateTriageJob(latestJob.id, {
          status: "FAILED",
          currentStep: latestJob.currentStep,
          progress: latestJob.progress,
          steps: markTriageSteps(latestJob.steps, latestJob.currentStep, "FAILED"),
          error: error.message
        });
        await store.createAuditEvent({
          incidentId: latestJob.incidentId,
          entityType: "triage_job",
          entityId: latestJob.id,
          action: "triage_job.failed",
          actor: latestJob.createdBy,
          metadata: {
            error: error.message,
            requestId
          }
        });
      }
      writeStructuredLog(logger, "error", "triage_job_failed", {
        requestId,
        jobId,
        message: error.message
      });
    }
  }

  function scheduleTriageJob(jobId, requestId) {
    setTimeout(() => {
      runTriageJob(jobId, requestId).catch((error) => {
        writeStructuredLog(logger, "error", "triage_job_unhandled_failure", {
          requestId,
          jobId,
          message: error.message
        });
      });
    }, 0);
  }

  app.set("trust proxy", options.trustProxy ?? process.env.TRUST_PROXY === "true");
  app.use(applyRequestId);
  app.use(applySecurityHeaders);
  app.use(cors({
    ...(corsOrigin ? {
      origin: corsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean)
    } : {}),
    exposedHeaders: ["X-Request-Id"]
  }));
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      observeHttpRequest(metrics, req, res, startedAt);
      if (enableAccessLogs) {
        logHttpRequest(logger, req, res, startedAt);
      }
    });
    next();
  });
  app.use(createRateLimiter({
    windowMs: rateLimitWindowMs,
    maxRequests: rateLimitMaxRequests
  }));
  app.use(express.json({ limit: "1mb" }));
  app.use(handleJsonParseError);

  app.post("/auth/login", asyncHandler(async (req, res) => {
    if (!requireBodyFields(req, res, ["username", "password"])) return;

    const user = await store.authenticateUser(cleanText(req.body.username), req.body.password);
    if (!user) {
      return sendError(req, res, 401, {
        error: "invalid_credentials",
        message: "Username or password is incorrect."
      });
    }

    const token = createHs256Jwt({
      sub: user.username,
      username: user.username,
      displayName: user.displayName,
      role: user.role
    }, authSecret, { expiresInSeconds: authTokenTtlSeconds });

    req.user = user;
    await recordAudit(req, {
      entityType: "auth",
      entityId: user.username,
      action: "auth.login",
      metadata: { role: user.role }
    });

    res.json({
      token,
      tokenType: "Bearer",
      expiresInSeconds: authTokenTtlSeconds,
      user
    });
  }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "incident-api" });
  });

  app.get("/system/health", asyncHandler(async (_req, res) => {
    const database = await store.healthCheck()
      .catch((error) => ({
        status: "down",
        message: error.message
      }));
    const triageAgent = await checkTriageAgentHealth(triageAgentUrl);
    const services = {
      api: {
        status: "ok",
        service: "incident-api"
      },
      database,
      triageAgent,
      llm: {
        status: triageAgent.configured ? (triageAgent.llmTriage ? "ok" : "degraded") : "fallback",
        enabled: Boolean(triageAgent.llmTriage)
      },
      vectorMemory: {
        status: triageAgent.configured ? (triageAgent.vectorMemory ? "ok" : "degraded") : "fallback",
        enabled: Boolean(triageAgent.vectorMemory)
      }
    };

    res.json({
      status: overallHealthStatus(services),
      checkedAt: new Date().toISOString(),
      services
    });
  }));

  app.get("/summary", asyncHandler(async (_req, res) => {
    res.json(await store.summarize());
  }));

  app.get("/incidents", asyncHandler(async (req, res) => {
    res.json(await store.listIncidents(req.query));
  }));

  app.get("/incidents/:id", asyncHandler(async (req, res) => {
    const incident = await store.getIncident(req.params.id);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }
    res.json(incident);
  }));

  app.post("/incidents", requireWriteRole, asyncHandler(async (req, res) => {
    if (!requireBodyFields(req, res, ["service", "title"])) return;

    const severity = cleanUpperText(req.body.severity, "SEV3");
    if (!validateAllowedValue(req, res, "severity", severity, allowedSeverities)) return;

    const incident = await store.createIncident({
      id: cleanText(req.body.id),
      service: cleanText(req.body.service),
      title: cleanText(req.body.title),
      severity,
      environment: cleanText(req.body.environment),
      region: cleanText(req.body.region),
      owner: cleanText(req.body.owner),
      deploymentVersion: cleanText(req.body.deploymentVersion),
      signals: cleanLineList(req.body.signals)
    });
    await recordAudit(req, {
      incidentId: incident.id,
      entityType: "incident",
      entityId: incident.id,
      action: "incident.created",
      metadata: {
        service: incident.service,
        severity: incident.severity
      }
    });
    res.status(201).json(incident);
  }));

  app.get("/incidents/:id/logs", asyncHandler(async (req, res) => {
    const incident = await store.getIncident(req.params.id);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }

    res.json(await store.listIncidentLogs(req.params.id, { limit: req.query.limit }));
  }));

  app.post("/incidents/:id/logs", requireWriteRole, asyncHandler(async (req, res) => {
    const incident = await store.getIncident(req.params.id);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }

    const logs = normalizeLogInputs(req.body);
    if (logs.length === 0) {
      return sendError(req, res, 400, { error: "missing_required_fields", fields: ["message"] });
    }

    for (const log of logs) {
      if (log.level && !validateAllowedValue(req, res, "level", cleanUpperText(log.level), allowedLogLevels)) return;
    }

    const created = await store.appendIncidentLogs(req.params.id, logs);
    if (created.length === 0) {
      return sendError(req, res, 400, { error: "missing_required_fields", fields: ["message"] });
    }

    await recordAudit(req, {
      incidentId: incident.id,
      entityType: "incident_logs",
      entityId: incident.id,
      action: "incident.logs_appended",
      metadata: {
        count: created.length,
        levels: [...new Set(created.map((log) => log.level))]
      }
    });
    res.status(201).json(created);
  }));

  app.post("/incidents/:id/log-import", requireWriteRole, asyncHandler(async (req, res) => {
    const incident = await store.getIncident(req.params.id);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }
    if (!requireBodyFields(req, res, ["content"])) return;

    let logs;
    try {
      logs = parseImportedLogs(req.body, incident);
    } catch (error) {
      return sendError(req, res, error.statusCode ?? 400, error.payload ?? {
        error: "invalid_log_import",
        message: error.message
      });
    }

    if (logs.length === 0) {
      return sendError(req, res, 400, { error: "missing_required_fields", fields: ["message"] });
    }

    for (const log of logs) {
      if (log.level && !validateAllowedValue(req, res, "level", cleanUpperText(log.level), allowedLogLevels)) return;
    }

    const created = await store.appendIncidentLogs(req.params.id, logs);
    await recordAudit(req, {
      incidentId: incident.id,
      entityType: "incident_logs",
      entityId: incident.id,
      action: "incident.logs_imported",
      metadata: {
        filename: cleanText(req.body.filename, "runtime.log"),
        count: created.length,
        levels: [...new Set(created.map((log) => log.level))]
      }
    });

    res.status(201).json({
      filename: cleanText(req.body.filename, "runtime.log"),
      importedCount: created.length,
      logs: created
    });
  }));

  app.patch("/incidents/:id/status", requireWriteRole, asyncHandler(async (req, res) => {
    if (!requireBodyFields(req, res, ["status"])) return;

    const status = cleanUpperText(req.body.status);
    if (!validateAllowedValue(req, res, "status", status, allowedStatuses)) return;

    const incident = await store.updateStatus(req.params.id, status);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }
    await recordAudit(req, {
      incidentId: incident.id,
      entityType: "incident",
      entityId: incident.id,
      action: "incident.status_updated",
      metadata: { status }
    });
    res.json(incident);
  }));

  app.get("/incidents/:id/triage-feedback", asyncHandler(async (req, res) => {
    const incident = await store.getIncident(req.params.id);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }

    res.json(await store.listTriageFeedback(req.params.id));
  }));

  app.post("/incidents/:id/triage-feedback", requireWriteRole, asyncHandler(async (req, res) => {
    const incident = await store.getIncident(req.params.id);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }
    if (!requireBodyFields(req, res, ["rating"])) return;

    const rating = cleanText(req.body.rating);
    if (!feedbackRatings.has(rating)) {
      return sendError(req, res, 400, {
        error: "invalid_feedback_rating",
        allowed: [...feedbackRatings]
      });
    }

    const feedback = await store.createTriageFeedback(req.params.id, {
      rating,
      note: cleanText(req.body.note, ""),
      triageSource: cleanText(req.body.triageSource, "unknown")
    });
    await recordAudit(req, {
      incidentId: incident.id,
      entityType: "triage_feedback",
      entityId: feedback.id,
      action: "triage.feedback_created",
      metadata: {
        rating: feedback.rating,
        triageSource: feedback.triageSource
      }
    });
    res.status(201).json(feedback);
  }));

  app.get("/incidents/:id/audit-events", asyncHandler(async (req, res) => {
    const incident = await store.getIncident(req.params.id);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }

    res.json(await store.listAuditEvents(req.params.id, { limit: req.query.limit }));
  }));

  app.get("/incidents/:id/timeline", asyncHandler(async (req, res) => {
    const timeline = await store.buildIncidentTimeline(req.params.id);
    if (!timeline) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }

    res.json(timeline);
  }));

  app.get("/incidents/:id/report.md", asyncHandler(async (req, res) => {
    const report = await store.buildIncidentReport(req.params.id);
    if (!report) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }

    res
      .type("text/markdown")
      .setHeader("Content-Disposition", `attachment; filename="${reportFilename(req.params.id)}"`);
    res.send(report);
  }));

  app.get("/incidents/:id/triage-jobs", asyncHandler(async (req, res) => {
    const incident = await store.getIncident(req.params.id);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }

    res.json(await store.listIncidentTriageJobs(req.params.id));
  }));

  app.post("/incidents/:id/triage-jobs", requireWriteRole, asyncHandler(async (req, res) => {
    const incident = await store.getIncident(req.params.id);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }

    const job = await store.createTriageJob(req.params.id, {
      createdBy: actorFromRequest(req)
    });
    await recordAudit(req, {
      incidentId: incident.id,
      entityType: "triage_job",
      entityId: job.id,
      action: "triage_job.queued",
      metadata: { requestId: req.id }
    });
    scheduleTriageJob(job.id, req.id);
    res.status(202).json(job);
  }));

  app.get("/triage-jobs/:id", asyncHandler(async (req, res) => {
    const job = await store.getTriageJob(req.params.id);
    if (!job) {
      return sendError(req, res, 404, { error: "triage_job_not_found" });
    }

    res.json(job);
  }));

  app.post("/incidents/:id/triage", asyncHandler(async (req, res) => {
    const triageStartedAt = Date.now();
    const incident = await store.getIncident(req.params.id);
    if (!incident) {
      return sendError(req, res, 404, { error: "incident_not_found" });
    }

    try {
      const logEvents = await store.listIncidentLogs(req.params.id, { limit: 500 });
      const incidentWithRuntimeLogs = {
        ...incident,
        logs: logEvents.map(formatLogForTriage),
        logEvents
      };
      const runbooks = await store.findRunbooks(incidentWithRuntimeLogs);
      if (triageDelayMs > 0) {
        await sleep(triageDelayMs);
      }
      const triage = await requestTriage(incidentWithRuntimeLogs, runbooks, triageAgentUrl, {
        timeoutMs: triageTimeoutMs,
        requestId: req.id
      });
      observeTriage(metrics, triage, triageStartedAt);
      await recordAudit(req, {
        incidentId: incident.id,
        entityType: "incident",
        entityId: incident.id,
        action: "triage.sync_completed",
        metadata: {
          source: triage.source,
          category: triage.category,
          requestId: req.id
        }
      });
      res.json(triage);
    } catch (error) {
      observeTriageError(metrics, triageStartedAt);
      throw error;
    }
  }));

  app.get("/runbooks", asyncHandler(async (_req, res) => {
    res.json(await store.listRunbooks());
  }));

  app.get("/runbooks/:id/versions", asyncHandler(async (req, res) => {
    const versions = await store.listRunbookVersions(req.params.id);
    if (versions.length === 0) {
      return sendError(req, res, 404, { error: "runbook_not_found" });
    }

    res.json(versions);
  }));

  app.post("/runbooks", requireWriteRole, asyncHandler(async (req, res) => {
    if (!requireBodyFields(req, res, ["title", "service"])) return;

    const runbook = await store.createRunbook({
      id: cleanText(req.body.id),
      title: cleanText(req.body.title),
      service: cleanText(req.body.service),
      keywords: cleanLineList(req.body.keywords, /[\n,]/),
      steps: cleanLineList(req.body.steps),
      createdBy: actorFromRequest(req)
    });
    await recordAudit(req, {
      entityType: "runbook",
      entityId: runbook.id,
      action: runbook.versionCreated > 1 ? "runbook.version_created" : "runbook.created",
      metadata: {
        version: runbook.versionCreated,
        service: runbook.service,
        keywordCount: runbook.keywords.length,
        stepCount: runbook.steps.length
      }
    });
    res.status(201).json(runbook);
  }));

  app.get("/metrics", asyncHandler(async (_req, res) => {
    const [summary, feedbackSummary] = await Promise.all([
      store.summarize(),
      store.summarizeTriageFeedback()
    ]);
    res.type("text/plain").send(renderMetrics(metrics, summary, feedbackSummary));
  }));

  app.use((req, res) => {
    res.status(404).json({
      error: "not_found",
      message: `No API route matches ${req.method} ${req.path}.`,
      requestId: req.id
    });
  });

  app.use((err, req, res, _next) => {
    logUnhandledError(logger, req, err);
    if (err.code === "23505") {
      return sendError(req, res, 409, { error: "duplicate_resource" });
    }
    sendError(req, res, 500, { error: "internal_server_error" });
  });

  return app;
}

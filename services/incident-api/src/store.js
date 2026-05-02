import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { v4 as uuidv4 } from "uuid";
import { createPasswordHash, verifyPassword } from "./auth.js";
import { runMigrations } from "./migrations.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = process.env.CLOUDOPS_REPO_ROOT
  ? path.resolve(process.env.CLOUDOPS_REPO_ROOT)
  : path.resolve(__dirname, "../../..");
const defaultDatabaseUrl = "postgres://cloudops:cloudops@127.0.0.1:5432/cloudops_copilot";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toJsonb(value) {
  return JSON.stringify(value ?? []);
}

function cleanText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function cleanList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function boundedLimit(value, fallback = 200, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, 1), max);
}

function inferLogLevel(message) {
  const upper = message.toUpperCase();
  if (upper.includes("ERROR")) return "ERROR";
  if (upper.includes("WARN")) return "WARN";
  if (upper.includes("DEBUG")) return "DEBUG";
  return "INFO";
}

function mapIncident(row) {
  return {
    id: row.id,
    service: row.service,
    title: row.title,
    severity: row.severity,
    status: row.status,
    environment: row.environment,
    region: row.region,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    owner: row.owner,
    deploymentVersion: row.deployment_version,
    signals: row.signals ?? []
  };
}

function mapRunbook(row) {
  return {
    id: row.id,
    title: row.title,
    service: row.service,
    keywords: row.keywords ?? [],
    steps: row.steps ?? [],
    currentVersion: row.current_version ?? 1
  };
}

function mapRunbookVersion(row) {
  return {
    id: row.id,
    runbookId: row.runbook_id,
    version: row.version,
    title: row.title,
    service: row.service,
    keywords: row.keywords ?? [],
    steps: row.steps ?? [],
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function mapIncidentLog(row) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    observedAt: row.observed_at instanceof Date ? row.observed_at.toISOString() : row.observed_at,
    level: row.level,
    source: row.source,
    message: row.message,
    attributes: row.attributes ?? {}
  };
}

function mapTriageFeedback(row) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    rating: row.rating,
    note: row.note,
    triageSource: row.triage_source,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function mapTriageJob(row) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    status: row.status,
    currentStep: row.current_step,
    progress: row.progress,
    steps: row.steps ?? [],
    result: row.result ?? null,
    error: row.error,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at
  };
}

function mapAuditEvent(row) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    actor: row.actor,
    metadata: row.metadata ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function mapAppUser(row) {
  return {
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function formatLogLine(log) {
  return `${log.observedAt} ${log.level} ${log.source}: ${log.message}`;
}

function timelineEvent(input) {
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    detail: input.detail ?? "",
    occurredAt: input.occurredAt,
    actor: input.actor ?? "system",
    severity: input.severity,
    metadata: input.metadata ?? {}
  };
}

function defaultMigrationsDir() {
  return path.resolve(__dirname, "../migrations");
}

function renderIncidentReport({ incident, logs, feedback, auditEvents, triage }) {
  const lines = [
    `# Incident Report: ${incident.id}`,
    "",
    `- Service: ${incident.service}`,
    `- Title: ${incident.title}`,
    `- Severity: ${incident.severity}`,
    `- Status: ${incident.status}`,
    `- Environment: ${incident.environment}`,
    `- Region: ${incident.region}`,
    `- Owner: ${incident.owner}`,
    `- Deployment Version: ${incident.deploymentVersion}`,
    `- Created At: ${incident.createdAt}`,
    "",
    "## Signals",
    ...(incident.signals.length > 0 ? incident.signals.map((signal) => `- ${signal}`) : ["- No signals recorded."]),
    "",
    "## Runtime Logs",
    ...(logs.length > 0
      ? logs.map((log) => `- ${log.observedAt} ${log.level} ${log.source}: ${log.message}`)
      : ["- No runtime logs recorded."]),
    "",
    "## Triage Result"
  ];

  if (triage) {
    lines.push(
      `- Source: ${triage.source ?? "unknown"}`,
      `- Category: ${triage.category ?? "unknown"}`,
      `- Confidence: ${triage.confidence ?? "unknown"}`,
      `- Summary: ${triage.summary ?? "No summary."}`,
      `- Probable Root Cause: ${triage.probableRootCause ?? "Unknown."}`,
      "",
      "### Recommended Actions",
      ...((triage.recommendedActions ?? []).length > 0
        ? triage.recommendedActions.map((action) => `- ${action}`)
        : ["- No recommended actions."]),
      "",
      "### Runbooks",
      ...((triage.runbooks ?? []).length > 0
        ? triage.runbooks.map((runbook) => `- ${runbook.id}: ${runbook.title}`)
        : ["- No runbooks matched."]),
      "",
      "### Evidence Used",
      ...((triage.evidence?.logLines ?? []).length > 0
        ? triage.evidence.logLines.map((log) => `- Log ${log.level ?? ""} ${log.source ?? ""}: ${log.message}`.trim())
        : ["- No log evidence attached."]),
      ...((triage.evidence?.signals ?? []).length > 0
        ? triage.evidence.signals.map((signal) => `- Signal: ${signal.text}`)
        : []),
      ...((triage.evidence?.runbooks ?? []).length > 0
        ? triage.evidence.runbooks.map((runbook) => `- Runbook ${runbook.id}: matched ${(runbook.matchedKeywords ?? []).join(", ") || "no explicit keywords"}`)
        : [])
    );
  } else {
    lines.push("- No triage result recorded.");
  }

  lines.push(
    "",
    "## Feedback",
    ...(feedback.length > 0
      ? feedback.map((item) => `- ${item.createdAt} ${item.rating}: ${item.note || "No note"}`)
      : ["- No feedback recorded."]),
    "",
    "## Audit Timeline",
    ...(auditEvents.length > 0
      ? auditEvents.map((event) => `- ${event.createdAt} ${event.actor} ${event.action} ${event.entityType}/${event.entityId}`)
      : ["- No audit events recorded."])
  );

  return `${lines.join("\n")}\n`;
}

export function createIncidentStore(options = {}) {
  const dataDir = options.dataDir ?? path.join(repoRoot, "data");
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const pool = options.pool ?? new Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL ?? defaultDatabaseUrl
  });
  const shouldClosePool = options.closePool ?? !options.pool;

  return {
    async init() {
      await runMigrations(pool, migrationsDir);
      await this.seed();
      await this.seedLocalUsers();
      await this.backfillRunbookVersions();
      await this.backfillLegacyIncidentLogs();
    },

    async listAppliedMigrations() {
      const result = await pool.query(`
        SELECT version, name, checksum, applied_at
        FROM schema_migrations
        ORDER BY version ASC
      `);
      return result.rows;
    },

    async seed() {
      const incidents = readJson(path.join(dataDir, "incidents.json"));
      const runbooks = readJson(path.join(dataDir, "runbooks.json"));

      for (const runbook of runbooks) {
        await pool.query(
          `
            INSERT INTO runbooks (id, title, service, keywords, steps, current_version)
            VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 1)
            ON CONFLICT (id) DO NOTHING
          `,
          [runbook.id, runbook.title, runbook.service, toJsonb(runbook.keywords), toJsonb(runbook.steps)]
        );

        await pool.query(
          `
            INSERT INTO runbook_versions (
              id, runbook_id, version, title, service, keywords, steps, created_by
            )
            VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6::jsonb, 'seed')
            ON CONFLICT (runbook_id, version) DO NOTHING
          `,
          [
            `${runbook.id}-v1`,
            runbook.id,
            runbook.title,
            runbook.service,
            toJsonb(runbook.keywords),
            toJsonb(runbook.steps)
          ]
        );
      }

      for (const incident of incidents) {
        await pool.query(
          `
            INSERT INTO incidents (
              id, service, title, severity, status, environment, region, created_at,
              owner, deployment_version, signals
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11::jsonb)
            ON CONFLICT (id) DO NOTHING
          `,
          [
            incident.id,
            incident.service,
            incident.title,
            incident.severity,
            incident.status,
            incident.environment,
            incident.region,
            incident.createdAt,
            incident.owner,
            incident.deploymentVersion,
            toJsonb(incident.signals)
          ]
        );

        await this.appendIncidentLogs(
          incident.id,
          (incident.logs ?? []).map((message, index) => ({
            id: `${incident.id}-seed-log-${index + 1}`,
            observedAt: new Date(new Date(incident.createdAt).getTime() + index * 1000).toISOString(),
            level: inferLogLevel(message),
            source: incident.service,
            message,
            attributes: { seeded: true }
          })),
          { onConflict: "ignore" }
        );
      }
    },

    async seedLocalUsers() {
      const username = cleanText(process.env.LOCAL_DEMO_USERNAME, "operator");
      const password = cleanText(process.env.LOCAL_DEMO_PASSWORD, "cloudops");
      const role = cleanText(process.env.LOCAL_DEMO_ROLE, "operator").toLowerCase();
      const displayName = cleanText(process.env.LOCAL_DEMO_DISPLAY_NAME, "Local Operator");

      await pool.query(
        `
          INSERT INTO app_users (username, display_name, role, password_hash)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (username) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            role = EXCLUDED.role,
            password_hash = EXCLUDED.password_hash
        `,
        [username, displayName, role, createPasswordHash(password)]
      );
    },

    async backfillRunbookVersions() {
      const result = await pool.query("SELECT * FROM runbooks");
      for (const row of result.rows) {
        const runbook = mapRunbook(row);
        await pool.query(
          `
            INSERT INTO runbook_versions (
              id, runbook_id, version, title, service, keywords, steps, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'backfill')
            ON CONFLICT (runbook_id, version) DO NOTHING
          `,
          [
            `${runbook.id}-v${runbook.currentVersion}`,
            runbook.id,
            runbook.currentVersion,
            runbook.title,
            runbook.service,
            toJsonb(runbook.keywords),
            toJsonb(runbook.steps)
          ]
        );
      }
    },

    async backfillLegacyIncidentLogs() {
      try {
        const result = await pool.query(`
          SELECT id, service, created_at, logs
          FROM incidents
          WHERE logs IS NOT NULL
        `);

        for (const incident of result.rows) {
          if (!Array.isArray(incident.logs) || incident.logs.length === 0) continue;

          await this.appendIncidentLogs(
            incident.id,
            incident.logs.map((message, index) => ({
              id: `${incident.id}-legacy-log-${index + 1}`,
              observedAt: new Date(new Date(incident.created_at).getTime() + index * 1000).toISOString(),
              level: inferLogLevel(message),
              source: incident.service,
              message,
              attributes: { migratedFromIncidentJson: true }
            })),
            { onConflict: "ignore" }
          );
        }
      } catch {
        // Fresh schemas do not have the former incidents.logs column.
      }
    },

    async listIncidents(filters = {}) {
      const clauses = [];
      const values = [];

      if (filters.status) {
        values.push(filters.status);
        clauses.push(`status = $${values.length}`);
      }

      if (filters.service) {
        values.push(filters.service);
        clauses.push(`service = $${values.length}`);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const result = await pool.query(
        `
          SELECT *
          FROM incidents
          ${where}
          ORDER BY created_at DESC
        `,
        values
      );
      return result.rows.map(mapIncident);
    },

    async getIncident(id) {
      const result = await pool.query("SELECT * FROM incidents WHERE id = $1", [id]);
      return result.rows[0] ? mapIncident(result.rows[0]) : null;
    },

    async createIncident(input) {
      const incident = {
        id: cleanText(input.id, `INC-${uuidv4()}`),
        service: cleanText(input.service, "unknown-service"),
        title: cleanText(input.title, "Untitled incident"),
        severity: cleanText(input.severity, "SEV3"),
        status: "OPEN",
        environment: cleanText(input.environment, "stage"),
        region: cleanText(input.region, "local"),
        owner: cleanText(input.owner, "unassigned"),
        deploymentVersion: cleanText(input.deploymentVersion, "unknown"),
        signals: cleanList(input.signals)
      };

      const result = await pool.query(
        `
          INSERT INTO incidents (
            id, service, title, severity, status, environment, region,
            owner, deployment_version, signals
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          RETURNING *
        `,
        [
          incident.id,
          incident.service,
          incident.title,
          incident.severity,
          incident.status,
          incident.environment,
          incident.region,
          incident.owner,
          incident.deploymentVersion,
          toJsonb(incident.signals)
        ]
      );

      return mapIncident(result.rows[0]);
    },

    async createRunbook(input) {
      const runbook = {
        id: cleanText(input.id, `RB-${uuidv4()}`),
        title: cleanText(input.title, "Untitled runbook"),
        service: cleanText(input.service, "unknown-service"),
        keywords: cleanList(input.keywords),
        steps: cleanList(input.steps),
        createdBy: cleanText(input.createdBy, "system")
      };

      const existing = await pool.query("SELECT current_version FROM runbooks WHERE id = $1", [runbook.id]);
      const nextVersion = existing.rows[0] ? Number(existing.rows[0].current_version) + 1 : 1;

      const result = await pool.query(
        `
          INSERT INTO runbooks (id, title, service, keywords, steps, current_version)
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            service = EXCLUDED.service,
            keywords = EXCLUDED.keywords,
            steps = EXCLUDED.steps,
            current_version = EXCLUDED.current_version
          RETURNING *
        `,
        [
          runbook.id,
          runbook.title,
          runbook.service,
          toJsonb(runbook.keywords),
          toJsonb(runbook.steps),
          nextVersion
        ]
      );

      await pool.query(
        `
          INSERT INTO runbook_versions (
            id, runbook_id, version, title, service, keywords, steps, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
          ON CONFLICT (runbook_id, version) DO NOTHING
        `,
        [
          `${runbook.id}-v${nextVersion}`,
          runbook.id,
          nextVersion,
          runbook.title,
          runbook.service,
          toJsonb(runbook.keywords),
          toJsonb(runbook.steps),
          runbook.createdBy
        ]
      );

      const mapped = mapRunbook(result.rows[0]);
      mapped.versionCreated = nextVersion;
      return mapped;
    },

    async listRunbookVersions(runbookId) {
      const result = await pool.query(
        `
          SELECT *
          FROM runbook_versions
          WHERE runbook_id = $1
          ORDER BY version DESC
        `,
        [runbookId]
      );
      return result.rows.map(mapRunbookVersion);
    },

    async listIncidentLogs(incidentId, options = {}) {
      const limit = boundedLimit(options.limit);
      const result = await pool.query(
        `
          SELECT *
          FROM incident_logs
          WHERE incident_id = $1
          ORDER BY observed_at ASC
          LIMIT $2
        `,
        [incidentId, limit]
      );
      return result.rows.map(mapIncidentLog);
    },

    async appendIncidentLog(incidentId, input) {
      const logs = await this.appendIncidentLogs(incidentId, [input]);
      return logs[0];
    },

    async appendIncidentLogs(incidentId, inputs, options = {}) {
      const inserted = [];
      for (const input of inputs) {
        const message = cleanText(input?.message);
        if (!message) continue;

        const result = await pool.query(
          `
            INSERT INTO incident_logs (
              id, incident_id, observed_at, level, source, message, attributes
            )
            VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7::jsonb)
            ON CONFLICT (id) DO ${options.onConflict === "ignore" ? "NOTHING" : "UPDATE SET message = EXCLUDED.message"}
            RETURNING *
          `,
          [
            cleanText(input.id, `LOG-${uuidv4()}`),
            incidentId,
            input.observedAt ?? new Date().toISOString(),
            cleanText(input.level, inferLogLevel(message)).toUpperCase(),
            cleanText(input.source, "application"),
            message,
            toJsonb(input.attributes ?? {})
          ]
        );

        if (result.rows[0]) {
          inserted.push(mapIncidentLog(result.rows[0]));
        }
      }
      return inserted;
    },

    async updateStatus(id, status) {
      const result = await pool.query(
        `
          UPDATE incidents
          SET status = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [id, status]
      );
      return result.rows[0] ? mapIncident(result.rows[0]) : null;
    },

    async createTriageFeedback(incidentId, input) {
      const feedback = {
        id: cleanText(input.id, `FB-${uuidv4()}`),
        rating: cleanText(input.rating, "useful"),
        note: cleanText(input.note, ""),
        triageSource: cleanText(input.triageSource, "unknown")
      };

      const result = await pool.query(
        `
          INSERT INTO triage_feedback (id, incident_id, rating, note, triage_source)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `,
        [
          feedback.id,
          incidentId,
          feedback.rating,
          feedback.note,
          feedback.triageSource
        ]
      );

      return mapTriageFeedback(result.rows[0]);
    },

    async listTriageFeedback(incidentId) {
      const result = await pool.query(
        `
          SELECT *
          FROM triage_feedback
          WHERE incident_id = $1
          ORDER BY created_at DESC
        `,
        [incidentId]
      );
      return result.rows.map(mapTriageFeedback);
    },

    async createTriageJob(incidentId, input = {}) {
      const job = {
        id: cleanText(input.id, `JOB-${uuidv4()}`),
        createdBy: cleanText(input.createdBy, "system"),
        steps: input.steps ?? [
          { id: "queued", label: "Queued", status: "complete" },
          { id: "collect_evidence", label: "Collect evidence", status: "pending" },
          { id: "match_runbooks", label: "Match runbooks", status: "pending" },
          { id: "retrieve_memory", label: "Retrieve memory", status: "pending" },
          { id: "draft_llm_triage", label: "Draft LLM triage", status: "pending" },
          { id: "save_memory", label: "Save memory", status: "pending" }
        ]
      };

      const result = await pool.query(
        `
          INSERT INTO triage_jobs (
            id, incident_id, status, current_step, progress, steps, created_by
          )
          VALUES ($1, $2, 'QUEUED', 'queued', 0, $3::jsonb, $4)
          RETURNING *
        `,
        [job.id, incidentId, toJsonb(job.steps), job.createdBy]
      );
      return mapTriageJob(result.rows[0]);
    },

    async updateTriageJob(id, patch) {
      const current = await this.getTriageJob(id);
      if (!current) return null;

      const status = cleanText(patch.status, current.status);
      const currentStep = cleanText(patch.currentStep, current.currentStep);
      const progress = Number.isFinite(Number(patch.progress)) ? Number(patch.progress) : current.progress;
      const steps = patch.steps ?? current.steps;
      const resultPayload = Object.prototype.hasOwnProperty.call(patch, "result") ? patch.result : current.result;
      const error = Object.prototype.hasOwnProperty.call(patch, "error") ? patch.error : current.error;
      const completedAt = ["SUCCEEDED", "FAILED"].includes(status) ? (patch.completedAt ?? new Date().toISOString()) : null;

      const result = await pool.query(
        `
          UPDATE triage_jobs
          SET status = $2,
              current_step = $3,
              progress = $4,
              steps = $5::jsonb,
              result = $6::jsonb,
              error = $7,
              updated_at = NOW(),
              completed_at = $8::timestamptz
          WHERE id = $1
          RETURNING *
        `,
        [
          id,
          status,
          currentStep,
          Math.max(0, Math.min(progress, 100)),
          toJsonb(steps),
          resultPayload == null ? null : JSON.stringify(resultPayload),
          error,
          completedAt
        ]
      );
      return result.rows[0] ? mapTriageJob(result.rows[0]) : null;
    },

    async getTriageJob(id) {
      const result = await pool.query("SELECT * FROM triage_jobs WHERE id = $1", [id]);
      return result.rows[0] ? mapTriageJob(result.rows[0]) : null;
    },

    async listIncidentTriageJobs(incidentId) {
      const result = await pool.query(
        `
          SELECT *
          FROM triage_jobs
          WHERE incident_id = $1
          ORDER BY created_at DESC
        `,
        [incidentId]
      );
      return result.rows.map(mapTriageJob);
    },

    async listRunbooks() {
      const result = await pool.query("SELECT * FROM runbooks ORDER BY id ASC");
      return result.rows.map(mapRunbook);
    },

    async findRunbooks(incident) {
      const result = await pool.query("SELECT * FROM runbooks");
      const haystack = [
        incident.service,
        incident.title,
        ...(incident.signals ?? []),
        ...(incident.logs ?? []),
        ...(incident.logEvents ?? []).map(formatLogLine)
      ]
        .join(" ")
        .toLowerCase();

      return result.rows
        .map((row) => {
          const runbook = mapRunbook(row);
          return {
            runbook,
            score: runbook.keywords.filter((keyword) => haystack.includes(keyword.toLowerCase())).length
          };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((candidate) => candidate.runbook);
    },

    async createAuditEvent(input) {
      const event = {
        id: cleanText(input.id, `AUD-${uuidv4()}`),
        incidentId: cleanText(input.incidentId, null),
        entityType: cleanText(input.entityType, "system"),
        entityId: cleanText(input.entityId, input.incidentId ?? "system"),
        action: cleanText(input.action, "event"),
        actor: cleanText(input.actor, "system"),
        metadata: input.metadata ?? {}
      };

      const result = await pool.query(
        `
          INSERT INTO audit_events (
            id, incident_id, entity_type, entity_id, action, actor, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          RETURNING *
        `,
        [
          event.id,
          event.incidentId,
          event.entityType,
          event.entityId,
          event.action,
          event.actor,
          toJsonb(event.metadata)
        ]
      );
      return mapAuditEvent(result.rows[0]);
    },

    async listAuditEvents(incidentId, options = {}) {
      const limit = boundedLimit(options.limit, 100, 250);
      const result = await pool.query(
        `
          SELECT *
          FROM audit_events
          WHERE incident_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        `,
        [incidentId, limit]
      );
      return result.rows.map(mapAuditEvent);
    },

    async authenticateUser(username, password) {
      const result = await pool.query("SELECT * FROM app_users WHERE username = $1", [username]);
      const row = result.rows[0];
      if (!row || !verifyPassword(password, row.password_hash)) {
        return null;
      }
      return mapAppUser(row);
    },

    async buildIncidentReport(incidentId, triageResult = null) {
      const incident = await this.getIncident(incidentId);
      if (!incident) return null;

      const [logs, feedback, auditEvents, jobs] = await Promise.all([
        this.listIncidentLogs(incidentId, { limit: 500 }),
        this.listTriageFeedback(incidentId),
        this.listAuditEvents(incidentId, { limit: 100 }),
        this.listIncidentTriageJobs(incidentId)
      ]);
      const latestJobResult = jobs.find((job) => job.result)?.result;
      const triage = triageResult ?? latestJobResult;

      return renderIncidentReport({
        incident,
        logs,
        feedback,
        auditEvents,
        triage
      });
    },

    async buildIncidentTimeline(incidentId) {
      const incident = await this.getIncident(incidentId);
      if (!incident) return null;

      const [logs, feedback, auditEvents, jobs] = await Promise.all([
        this.listIncidentLogs(incidentId, { limit: 500 }),
        this.listTriageFeedback(incidentId),
        this.listAuditEvents(incidentId, { limit: 250 }),
        this.listIncidentTriageJobs(incidentId)
      ]);

      const events = [
        timelineEvent({
          id: `${incident.id}-created`,
          type: "incident",
          title: "Incident created",
          detail: incident.title,
          occurredAt: incident.createdAt,
          actor: incident.owner,
          severity: incident.severity,
          metadata: {
            status: incident.status,
            service: incident.service,
            region: incident.region
          }
        }),
        ...logs.map((log) => timelineEvent({
          id: log.id,
          type: "log",
          title: `${log.level} ${log.source}`,
          detail: log.message,
          occurredAt: log.observedAt,
          severity: log.level,
          metadata: log.attributes
        })),
        ...jobs.map((job) => timelineEvent({
          id: job.id,
          type: "triage_job",
          title: `Triage job ${job.status.toLowerCase()}`,
          detail: job.error || job.result?.summary || job.currentStep,
          occurredAt: job.completedAt ?? job.updatedAt ?? job.createdAt,
          actor: job.createdBy,
          severity: job.status,
          metadata: {
            progress: job.progress,
            currentStep: job.currentStep,
            source: job.result?.source,
            category: job.result?.category
          }
        })),
        ...feedback.map((item) => timelineEvent({
          id: item.id,
          type: "feedback",
          title: `Triage feedback: ${item.rating}`,
          detail: item.note || "No note",
          occurredAt: item.createdAt,
          severity: item.rating,
          metadata: {
            triageSource: item.triageSource
          }
        })),
        ...auditEvents.map((event) => timelineEvent({
          id: event.id,
          type: "audit",
          title: event.action,
          detail: `${event.entityType}/${event.entityId}`,
          occurredAt: event.createdAt,
          actor: event.actor,
          metadata: event.metadata
        }))
      ];

      return events.sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
    },

    async summarize() {
      const [{ rows: statuses }, { rows: severities }] = await Promise.all([
        pool.query("SELECT status, COUNT(*)::int AS count FROM incidents GROUP BY status"),
        pool.query("SELECT severity, COUNT(*)::int AS count FROM incidents GROUP BY severity")
      ]);
      const total = statuses.reduce((sum, row) => sum + row.count, 0);
      const open = statuses
        .filter((row) => row.status !== "RESOLVED")
        .reduce((sum, row) => sum + row.count, 0);

      return {
        total,
        open,
        byStatus: Object.fromEntries(statuses.map((row) => [row.status, row.count])),
        bySeverity: Object.fromEntries(severities.map((row) => [row.severity, row.count]))
      };
    },

    async summarizeTriageFeedback() {
      const result = await pool.query(`
        SELECT rating, COUNT(*)::int AS count
        FROM triage_feedback
        GROUP BY rating
      `);
      const byRating = Object.fromEntries(result.rows.map((row) => [row.rating, row.count]));

      return {
        total: result.rows.reduce((sum, row) => sum + row.count, 0),
        byRating
      };
    },

    async healthCheck() {
      const startedAt = Date.now();
      await pool.query("SELECT 1 AS ok");
      return {
        status: "ok",
        latencyMs: Date.now() - startedAt
      };
    },

    async close() {
      if (shouldClosePool) {
        await pool.end();
      }
    }
  };
}

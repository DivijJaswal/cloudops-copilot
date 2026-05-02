import json
import os
import uuid
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def default_repo_root():
    configured = os.getenv("CLOUDOPS_REPO_ROOT")
    if configured:
        return Path(configured)

    for parent in Path(__file__).resolve().parents:
        if (parent / "data").exists():
            return parent

    return Path(__file__).resolve().parents[1]


REPO_ROOT = default_repo_root()
DEFAULT_DATABASE_URL = "postgres://cloudops:cloudops@127.0.0.1:5432/cloudops_copilot"


class PgTriageMemory:
    def __init__(self, database_url=None, embedding_dimensions=None, seed_path=None):
        self.database_url = database_url or os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL)
        self.embedding_dimensions = int(embedding_dimensions or os.getenv("EMBEDDING_DIMENSIONS", "768"))
        self.seed_path = Path(seed_path or os.getenv(
            "TRIAGE_MEMORY_SEED_PATH",
            REPO_ROOT / "data" / "past_triage_cases.json"
        ))

    def init(self):
        with self._connect() as conn:
            conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            conn.execute(f"""
                CREATE TABLE IF NOT EXISTS triage_cases (
                  id TEXT PRIMARY KEY,
                  incident_id TEXT,
                  service TEXT NOT NULL,
                  category TEXT NOT NULL,
                  severity TEXT,
                  title TEXT NOT NULL,
                  incident_text TEXT NOT NULL,
                  root_cause TEXT NOT NULL,
                  resolution_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
                  runbook_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                  triage_result JSONB NOT NULL DEFAULT '{{}}'::jsonb,
                  embedding vector({self.embedding_dimensions}),
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_triage_cases_service
                ON triage_cases(service)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_triage_cases_category
                ON triage_cases(category)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_triage_cases_embedding
                ON triage_cases USING ivfflat (embedding vector_cosine_ops)
                WITH (lists = 16)
            """)

    def seed(self, embed_fn):
        if not self.seed_path.exists():
            return

        cases = json.loads(self.seed_path.read_text())
        for case in cases:
            incident_text = case.get("incidentText") or build_case_text(case)
            embedding = embed_fn(incident_text)
            self.upsert_case({
                "id": case["id"],
                "incident_id": case.get("incidentId"),
                "service": case["service"],
                "category": case["category"],
                "severity": case.get("severity"),
                "title": case["title"],
                "incident_text": incident_text,
                "root_cause": case["rootCause"],
                "resolution_steps": case.get("resolutionSteps", []),
                "runbook_ids": case.get("runbookIds", []),
                "triage_result": case
            }, embedding)

    def search(self, embedding, limit=4):
        vector = to_vector_literal(embedding)
        with self._connect() as conn:
            rows = conn.execute(
                """
                  SELECT
                    id,
                    incident_id,
                    service,
                    category,
                    severity,
                    title,
                    root_cause,
                    resolution_steps,
                    runbook_ids,
                    1 - (embedding <=> %s::vector) AS similarity
                  FROM triage_cases
                  WHERE embedding IS NOT NULL
                  ORDER BY embedding <=> %s::vector
                  LIMIT %s
                """,
                (vector, vector, limit)
            ).fetchall()

        return [
            {
                "id": row["id"],
                "incidentId": row["incident_id"],
                "service": row["service"],
                "category": row["category"],
                "severity": row["severity"],
                "title": row["title"],
                "rootCause": row["root_cause"],
                "resolutionSteps": row["resolution_steps"],
                "runbookIds": row["runbook_ids"],
                "similarity": round(float(row["similarity"]), 4)
            }
            for row in rows
        ]

    def save_case(self, incident, triage_result, embedding):
        case_id = f"generated-{incident.get('id') or uuid.uuid4()}"
        runbook_ids = [
            runbook.get("id")
            for runbook in triage_result.get("runbooks", [])
            if runbook.get("id")
        ]
        incident_text = build_incident_text(incident)

        self.upsert_case({
            "id": case_id,
            "incident_id": incident.get("id"),
            "service": incident.get("service", "unknown-service"),
            "category": triage_result.get("category", "service"),
            "severity": incident.get("severity"),
            "title": incident.get("title", "Untitled incident"),
            "incident_text": incident_text,
            "root_cause": triage_result.get("probableRootCause", "Unknown"),
            "resolution_steps": triage_result.get("recommendedActions", []),
            "runbook_ids": runbook_ids,
            "triage_result": triage_result
        }, embedding)

    def upsert_case(self, case, embedding):
        with self._connect() as conn:
            conn.execute(
                """
                  INSERT INTO triage_cases (
                    id, incident_id, service, category, severity, title, incident_text,
                    root_cause, resolution_steps, runbook_ids, triage_result, embedding
                  )
                  VALUES (
                    %(id)s, %(incident_id)s, %(service)s, %(category)s, %(severity)s,
                    %(title)s, %(incident_text)s, %(root_cause)s, %(resolution_steps)s,
                    %(runbook_ids)s, %(triage_result)s, %(embedding)s::vector
                  )
                  ON CONFLICT (id) DO UPDATE SET
                    incident_id = EXCLUDED.incident_id,
                    service = EXCLUDED.service,
                    category = EXCLUDED.category,
                    severity = EXCLUDED.severity,
                    title = EXCLUDED.title,
                    incident_text = EXCLUDED.incident_text,
                    root_cause = EXCLUDED.root_cause,
                    resolution_steps = EXCLUDED.resolution_steps,
                    runbook_ids = EXCLUDED.runbook_ids,
                    triage_result = EXCLUDED.triage_result,
                    embedding = EXCLUDED.embedding,
                    updated_at = NOW()
                """,
                {
                    **case,
                    "resolution_steps": Jsonb(case["resolution_steps"]),
                    "runbook_ids": Jsonb(case["runbook_ids"]),
                    "triage_result": Jsonb(case["triage_result"]),
                    "embedding": to_vector_literal(embedding)
                }
            )

    def _connect(self):
        return psycopg.connect(self.database_url, row_factory=dict_row)


def build_incident_text(incident):
    return "\n".join([
        f"Service: {incident.get('service', '')}",
        f"Title: {incident.get('title', '')}",
        f"Severity: {incident.get('severity', '')}",
        f"Status: {incident.get('status', '')}",
        f"Environment: {incident.get('environment', '')}",
        f"Region: {incident.get('region', '')}",
        "Signals:",
        "\n".join(f"- {signal}" for signal in incident.get("signals", [])),
        "Logs:",
        "\n".join(f"- {line}" for line in incident.get("logs", []))
    ])


def build_case_text(case):
    return "\n".join([
        f"Service: {case.get('service', '')}",
        f"Title: {case.get('title', '')}",
        f"Category: {case.get('category', '')}",
        f"Severity: {case.get('severity', '')}",
        f"Root Cause: {case.get('rootCause', '')}",
        "Signals:",
        "\n".join(f"- {signal}" for signal in case.get("signals", [])),
        "Resolution Steps:",
        "\n".join(f"- {step}" for step in case.get("resolutionSteps", []))
    ])


def to_vector_literal(embedding):
    return "[" + ",".join(str(float(value)) for value in embedding) + "]"

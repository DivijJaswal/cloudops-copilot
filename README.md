# CloudOps Copilot

CloudOps Copilot is a production-style incident triage and rollout safety platform. It is designed as a resume-grade project for backend, cloud, AI, testing, observability, and deployment skills.

## Demo Walkthrough

Watch the recorded local walkthrough: [cloudops-copilot-walkthrough.webm](artifacts/demo-video/cloudops-copilot-walkthrough.webm).

The demo covers local login, service health, incident selection, runtime log append/import, incident creation, runbook creation, LangGraph/RAG triage, evidence review, operator feedback, report export, and the unified incident timeline. An example exported incident report is included at [INC-DEMO-987095-report.md](artifacts/demo-video/INC-DEMO-987095-report.md).

## MVP Scope

- Incident, runtime log, and work-request API with role-aware write operations and PostgreSQL persistence.
- Python triage agent that uses Ollama plus pgvector RAG over past triage cases to classify incidents, link runbooks, and draft remediation steps.
- LangGraph-backed triage orchestration for evidence collection, runbook ranking, vector memory retrieval, LLM drafting, memory write-back, and deterministic fallback.
- React operator dashboard for incidents, runtime log events, local log file import, runbook creation, local login, service health, async triage progress, unified incident timeline, report export, and evidence-backed triage output.
- Service health aggregation for API, database, triage agent, LLM triage, and vector memory.
- Operator feedback capture for useful, incorrect, or needs-work triage results.
- Runbook versioning, persisted triage jobs, incident audit events, and markdown incident reports.
- Deterministic triage eval harness and local demo seed/reset scripts.
- Seed incidents and runbooks for local demos.
- Unit tests for API store logic and triage logic.
- Docker Compose and Kubernetes manifests for deployment practice.

## Architecture

```text
apps/dashboard            React operator UI
services/incident-api     Node.js/Express REST API
services/triage-agent     Python triage agent API
data/                     Seed incidents and runbooks
infra/k8s/                Kubernetes deployment manifests
```

Triage flow:

```text
Dashboard -> Incident API -> persisted triage job -> Triage Agent
                         -> Postgres incidents/runbooks/runtime logs/audit
Incident API -> fetches runtime logs on demand before triage
Triage Agent -> Ollama embeddings -> pgvector similar past cases
Triage Agent -> Ollama chat model -> triage JSON
Triage Agent -> pgvector memory stores generated triage for future RAG
```

LangGraph triage flow:

```text
collect_evidence -> match_runbooks -> retrieve_memory -> draft_llm_triage -> save_memory
                                      \-> deterministic_triage when LLM triage is unavailable
```

## Local Development

Install JavaScript dependencies with Yarn:

```bash
NODE_OPTIONS=--use-system-ca yarn install
```

Copy the documented environment variables when you want a local shell config:

```bash
cp .env.example .env
```

Run the local doctor when startup fails or before demoing the full stack:

```bash
yarn doctor
```

The doctor checks required tools, Python triage dependencies, Docker reachability, PostgreSQL, Ollama models, and local API health endpoints. Use `yarn doctor:strict` when you want warnings to fail the command.

Start the full local app stack with one command after PostgreSQL is running and Python dependencies are installed:

```bash
yarn local:start
```

`local:start` loads `.env.example`, `.env`, and shell environment variables, verifies PostgreSQL and Python triage dependencies, warns if Ollama is unavailable, seeds demo data, then starts the Incident API, triage agent, and dashboard together. It keeps the dashboard on `http://localhost:5173`, prints service readiness, and stops all child processes when you press `Ctrl+C`.

If a previous dev server is still running, stop it first or change `INCIDENT_API_PORT`, `TRIAGE_AGENT_PORT`, `TRIAGE_AGENT_URL`, `DASHBOARD_PORT`, `CORS_ORIGIN`, and `VITE_API_URL` together in `.env`.

Run tests:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r services/triage-agent/requirements.txt
yarn test
yarn eval:triage
```

The root test command uses `.venv/bin/python` when it exists, so Flask triage-agent tests run instead of being silently skipped by a system Python without dependencies.

Run browser E2E tests:

```bash
yarn playwright install chromium
yarn test:e2e
```

The E2E suite starts an in-memory Incident API and a Vite dashboard automatically, so it does not require Postgres, Ollama, or Docker.

CI runs the same E2E suite against the system Chrome available on the GitHub Ubuntu runner by setting `PLAYWRIGHT_BROWSER_CHANNEL=chrome`, so the workflow does not need a separate Playwright browser install step.

Start the local PostgreSQL database:

```bash
yarn db:up
```

If Docker is unavailable, run PostgreSQL with Homebrew instead:

```bash
brew services start postgresql@17
/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 5432 postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cloudops') THEN CREATE ROLE cloudops LOGIN PASSWORD 'cloudops'; END IF; END \$\$;"
/opt/homebrew/opt/postgresql@17/bin/createdb -h 127.0.0.1 -p 5432 -O cloudops cloudops_copilot
/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 5432 cloudops_copilot -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Install Python dependencies in a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r services/triage-agent/requirements.txt
```

Install and run Ollama locally, then pull the required models:

```bash
brew install ollama
ollama serve
ollama pull llama3.1
ollama pull nomic-embed-text
```

Run services in separate terminals:

```bash
DATABASE_URL=postgres://cloudops:cloudops@127.0.0.1:5432/cloudops_copilot OLLAMA_BASE_URL=http://127.0.0.1:11434 yarn dev:agent
DATABASE_URL=postgres://cloudops:cloudops@127.0.0.1:5432/cloudops_copilot TRIAGE_AGENT_URL=http://127.0.0.1:5001 TRIAGE_AGENT_TIMEOUT_MS=70000 CORS_ORIGIN=http://127.0.0.1:5173,http://localhost:5173 yarn dev:api
yarn dev:dashboard
```

Default URLs:

- Dashboard: `http://localhost:5173`
- Incident API: `http://localhost:8080`
- Triage Agent: `http://localhost:5001`
- PostgreSQL: `postgres://cloudops:cloudops@127.0.0.1:5432/cloudops_copilot`
- Ollama: `http://localhost:11434`

The API applies versioned SQL migrations from `services/incident-api/migrations`, records them in `schema_migrations`, enforces database-level status/severity/log/feedback constraints, and seeds initial incidents/runbooks/runtime logs from `data/*.json` without overwriting changed incidents.

Runtime logs live separately from incidents in the `incident_logs` table. The dashboard reads logs through `GET /incidents/:id/logs`, appends generated log events through `POST /incidents/:id/logs`, and imports local `.log`, `.txt`, `.jsonl`, or `.json` files through `POST /incidents/:id/log-import`. Triage requests fetch logs from this separate log store at runtime, then pass those current log events into runbook matching and the LLM prompt.

The dashboard can add incidents, append runtime logs, and create runbooks directly through the API. Those writes are persisted in PostgreSQL and used by later triage requests.

Local demo helpers:

```bash
yarn demo:seed
yarn demo:reset
yarn eval:triage
```

`demo:seed` applies migrations and makes sure the seed incidents, runbooks, runtime logs, and default local operator exist. `demo:reset` clears local app data and reloads the same demo set. The default dashboard login is `operator` / `cloudops`; override it with `LOCAL_DEMO_USERNAME`, `LOCAL_DEMO_PASSWORD`, `LOCAL_DEMO_ROLE`, and `LOCAL_DEMO_DISPLAY_NAME`.

The Incident API validates incident severity, status, and log levels before writes. Triage calls to the Python agent are bounded by `TRIAGE_AGENT_TIMEOUT_MS`; if the agent hangs or is unavailable, the API returns deterministic fallback triage instead of leaving the dashboard waiting indefinitely. `CORS_ORIGIN` can be set to a comma-separated allowlist for browser access.

The dashboard, Incident API, and triage agent propagate `X-Request-Id` through triage calls, including API fallback triage when the agent is unavailable. Error payloads include the same `requestId`, the dashboard shows it on failures and triage results, and both backend services emit JSON access logs with request id, route, sanitized path, status, and duration. Query strings are intentionally omitted from structured logs. Set `ACCESS_LOGS=false` to silence access logs during local debugging.

The Incident API also applies a dependency-free per-client fixed-window rate limit. Defaults are `RATE_LIMIT_MAX=600` requests per `RATE_LIMIT_WINDOW_MS=60000`; health and metrics endpoints are excluded. Responses include `RateLimit-*` headers, and exhausted clients receive a JSON `429 rate_limit_exceeded` response with the request id. Set `RATE_LIMIT_MAX=0` to disable it for local stress testing, and set `TRUST_PROXY=true` only when the API is behind a trusted reverse proxy that owns `X-Forwarded-For`.

Write APIs use the local `x-user-role` header only when `JWT_SECRET` is unset, which keeps the E2E and local demo paths simple. The dashboard can also call `POST /auth/login` and store a local bearer token. Set `JWT_SECRET` to require HS256 bearer tokens with an `operator` or `admin` role, and generate a local demo token with:

```bash
JWT_SECRET=dev-secret yarn -s auth:token operator
```

The dashboard also reads `GET /system/health` for dependency status, starts async triage with `POST /incidents/:id/triage-jobs`, polls `GET /triage-jobs/:id`, exports reports through `GET /incidents/:id/report.md`, displays a merged timeline from `GET /incidents/:id/timeline`, and posts operator triage feedback through `POST /incidents/:id/triage-feedback`.

Record a local walkthrough video after `yarn local:start` is already running:

```bash
yarn record:demo
```

The recorder signs in with `operator` / `cloudops`, shows service health, inspects an incident, appends and imports runtime logs, creates a demo incident and runbook, runs triage, reviews evidence, submits feedback, exports a report, and shows the unified timeline. The video is saved to `artifacts/demo-video/cloudops-copilot-walkthrough.webm`; the exported markdown report is saved in the same folder. Set `DEMO_HEADLESS=true` to record without opening a visible browser window.

The walkthrough defaults to a slower presentation pace with a 5-second pause between major operations. Tune it with `DEMO_STEP_DELAY_MS`, `DEMO_ACTION_DELAY_MS`, and `DEMO_SLOW_MO_MS` when recording shorter cuts.

The Incident API exposes Prometheus-compatible metrics at `GET /metrics`, including HTTP request counts, request duration sums/counts, incident gauges, triage duration/source/fallback counters, triage error counts, and persisted feedback rating counts. HTTP route labels are bounded so arbitrary missing paths are grouped under `GET unmatched` instead of creating high-cardinality metric series.

The triage agent creates a `triage_cases` vector table, seeds it from `data/past_triage_cases.json`, retrieves similar historical cases with pgvector, and stores new LLM triage output back into the same memory table. Triage execution is orchestrated as a LangGraph workflow with explicit evidence, runbook matching, memory retrieval, LLM drafting, memory save, and fallback nodes. Triage responses include the signals, log lines, runbook keyword matches, and similar cases that influenced the result. If Ollama or vector memory is unavailable, the agent returns a deterministic fallback result with `source: triage-agent-fallback`.

The local `yarn dev:agent` command uses Flask's development server for quick iteration. The container image runs the same Flask app behind Gunicorn with threaded request handling.

## Docker

```bash
docker compose up --build
docker compose exec ollama ollama pull llama3.1
docker compose exec ollama ollama pull nomic-embed-text
```

The Docker dashboard is served through nginx on `http://localhost:5173` and proxies API calls through `/api` to the `incident-api` container.

The dashboard nginx container serves static assets with security headers, including clickjacking, content-sniffing, referrer, permissions, and content security policy controls.

The Compose stack pins Ollama through `OLLAMA_IMAGE=ollama/ollama:0.20.7`. Override `OLLAMA_IMAGE` in `.env` only after testing a newer image locally.

Docker Compose healthchecks gate service startup for PostgreSQL, Ollama, the triage agent, Incident API, and dashboard, so dependent services wait for usable health endpoints instead of only waiting for containers to start.

Start Prometheus and Grafana with the optional observability profile:

```bash
docker compose --profile observability up --build
```

Observability URLs:

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3000` with `admin` / `admin`

Grafana provisions the CloudOps Copilot dashboard from `infra/observability/grafana/dashboards/cloudops-copilot.json`.

## Kubernetes

```bash
kubectl apply -f infra/k8s/namespace.yaml
kubectl -n cloudops-copilot create secret generic postgres-secret \
  --from-literal=POSTGRES_DB=cloudops_copilot \
  --from-literal=POSTGRES_USER=cloudops \
  --from-literal=POSTGRES_PASSWORD='<replace-with-a-strong-password>' \
  --from-literal=DATABASE_URL='postgres://cloudops:<replace-with-a-strong-password>@postgres:5432/cloudops_copilot'
kubectl -n cloudops-copilot create secret generic incident-api-secret \
  --from-literal=JWT_SECRET='<replace-with-a-long-random-secret>'
kubectl apply -f infra/k8s/
kubectl -n cloudops-copilot get pods
```

Example secret manifests live in `infra/examples/` for reference only; the applied `infra/k8s/` manifests intentionally do not commit credential values.

After the Ollama pod is running, pull models into its persistent volume:

```bash
kubectl -n cloudops-copilot exec deploy/ollama -- ollama pull llama3.1
kubectl -n cloudops-copilot exec deploy/ollama -- ollama pull nomic-embed-text
```

The Kubernetes manifests include readiness/liveness probes, resource requests/limits, non-root containers, dropped Linux capabilities, pinned external image tags, externalized PostgreSQL/API secrets, and read-only root filesystems for the API, triage-agent, and dashboard containers with writable runtime-only `emptyDir` mounts.

If your cluster runs Prometheus Operator, apply the optional ServiceMonitor to scrape the Incident API metrics endpoint:

```bash
kubectl apply -f infra/observability/k8s/incident-api-servicemonitor.yaml
```

The ServiceMonitor selects the `incident-api` service and scrapes its named `http` port at `/metrics`. This optional manifest requires the Prometheus Operator `ServiceMonitor` CRD, so the default `yarn validate:k8s` check performs offline validation for the core app manifests under `infra/k8s/` without requiring a live Kubernetes cluster.

## Resume Target

```latex
\resumeItem{Built CloudOps Copilot, an incident triage and rollout safety platform using Node.js, Express.js, Python, React, PostgreSQL/pgvector, LangGraph, Ollama, Docker, and Kubernetes to automate alert classification, runtime log retrieval, runbook matching, and remediation drafting.}
\resumeItem{Implemented RBAC-secured REST APIs, normalized PostgreSQL persistence for incidents/runbooks/runtime logs, dashboard write workflows, and a LangGraph-orchestrated LLM RAG triage agent that retrieves similar past incidents before generating operator actions.}
```

## Next Build Steps

1. Add saved triage eval baselines and compare score deltas in CI.
2. Add dashboard filters for timeline events, runbook versions, and triage job history.
3. Add saved local replay scenarios that import log files, run triage, and compare outputs automatically.

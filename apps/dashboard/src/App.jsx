import React, { useEffect, useMemo, useState } from "react";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:8080";
const operatorToken = import.meta.env.VITE_OPERATOR_TOKEN;

const emptyIncidentForm = {
  id: "",
  service: "partner-api",
  title: "",
  severity: "SEV3",
  environment: "stage",
  region: "us-phoenix-1",
  owner: "db-platform",
  deploymentVersion: "",
  signals: "",
  logs: ""
};

const emptyRunbookForm = {
  id: "",
  title: "",
  service: "partner-api",
  keywords: "",
  steps: ""
};

const emptyLogForm = {
  level: "INFO",
  source: "application",
  message: ""
};

const emptyLoginForm = {
  username: "operator",
  password: "cloudops"
};

function initialStoredValue(key, fallback = null) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function initialStoredJson(key, fallback = null) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeHeadersFor(token) {
  return token
    ? {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      }
    : {
        "content-type": "application/json",
        "x-user-role": "operator"
      };
}

function splitLines(value) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitKeywords(value) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  const requestId = response.headers.get("x-request-id") ?? payload?.requestId ?? null;

  if (!response.ok) {
    const error = new Error(payload?.message ?? payload?.error ?? "request_failed");
    error.payload = payload;
    error.requestId = requestId;
    throw error;
  }

  return payload;
}

function withRequestId(message, error) {
  return error?.requestId ? `${message} Request ID: ${error.requestId}.` : message;
}

function reportDownloadName(incidentId) {
  return `${incidentId.replace(/[^A-Za-z0-9._-]/g, "_")}-incident-report.md`;
}

export default function App() {
  const [incidents, setIncidents] = useState([]);
  const [summary, setSummary] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [triage, setTriage] = useState(null);
  const [triageJob, setTriageJob] = useState(null);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [feedbackLoading, setFeedbackLoading] = useState(null);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(null);
  const [serviceHealth, setServiceHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [selectedLogs, setSelectedLogs] = useState([]);
  const [timelineEvents, setTimelineEvents] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [incidentForm, setIncidentForm] = useState(emptyIncidentForm);
  const [runbookForm, setRunbookForm] = useState(emptyRunbookForm);
  const [logForm, setLogForm] = useState(emptyLogForm);
  const [logImportFile, setLogImportFile] = useState(null);
  const [loginForm, setLoginForm] = useState(emptyLoginForm);
  const [authToken, setAuthToken] = useState(() => initialStoredValue("cloudopsToken", operatorToken ?? ""));
  const [currentUser, setCurrentUser] = useState(() => initialStoredJson("cloudopsUser", null));
  const [writeStatus, setWriteStatus] = useState(null);
  const [triageLoading, setTriageLoading] = useState(false);
  const [appendLogLoading, setAppendLogLoading] = useState(false);
  const [logImportLoading, setLogImportLoading] = useState(false);
  const [incidentCreateLoading, setIncidentCreateLoading] = useState(false);
  const [runbookCreateLoading, setRunbookCreateLoading] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [runbookVersions, setRunbookVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const selectedIncident = useMemo(
    () => incidents.find((incident) => incident.id === selectedId) ?? incidents[0],
    [incidents, selectedId]
  );

  async function loadDashboardData(nextSelectedId) {
    const [incidentData, summaryData] = await Promise.all([
      fetchJson(`${apiUrl}/incidents`),
      fetchJson(`${apiUrl}/summary`)
    ]);

    setIncidents(incidentData);
    setSummary(summaryData);
    setSelectedId(
      nextSelectedId ??
      incidentData.find((incident) => incident.id === selectedId)?.id ??
      incidentData[0]?.id
    );
  }

  async function loadIncidentLogs(incidentId) {
    if (!incidentId) {
      setSelectedLogs([]);
      return;
    }

    const logs = await fetchJson(`${apiUrl}/incidents/${incidentId}/logs`);
    setSelectedLogs(logs);
  }

  async function loadIncidentTimeline(incidentId) {
    if (!incidentId) {
      setTimelineEvents([]);
      return;
    }

    setTimelineLoading(true);
    try {
      const events = await fetchJson(`${apiUrl}/incidents/${incidentId}/timeline`);
      setTimelineEvents(events);
    } finally {
      setTimelineLoading(false);
    }
  }

  async function loadServiceHealth() {
    setHealthLoading(true);

    try {
      setServiceHealth(await fetchJson(`${apiUrl}/system/health`));
    } catch {
      setServiceHealth({
        status: "down",
        checkedAt: new Date().toISOString(),
        services: {
          api: { status: "down", message: "Incident API unreachable." },
          database: { status: "unknown" },
          triageAgent: { status: "unknown" },
          llm: { status: "unknown" },
          vectorMemory: { status: "unknown" }
        }
      });
    } finally {
      setHealthLoading(false);
    }
  }

  useEffect(() => {
    loadDashboardData()
      .catch((error) => setError(withRequestId("Unable to load incident data. Is the API running?", error)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadServiceHealth();
    const timer = window.setInterval(loadServiceHealth, 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    loadIncidentLogs(selectedIncident?.id)
      .catch((error) => setError(withRequestId("Unable to load incident logs.", error)));
  }, [selectedIncident?.id]);

  useEffect(() => {
    loadIncidentTimeline(selectedIncident?.id)
      .catch((error) => setError(withRequestId("Unable to load incident timeline.", error)));
  }, [selectedIncident?.id]);

  useEffect(() => {
    if (!toast) return undefined;

    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function showToast(message) {
    setToast({
      id: Date.now(),
      message
    });
  }

  async function submitLogin(event) {
    event.preventDefault();
    if (loginLoading) return;

    setError(null);
    setLoginLoading(true);

    try {
      const payload = await fetchJson(`${apiUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(loginForm)
      });
      setAuthToken(payload.token);
      setCurrentUser(payload.user);
      window.localStorage.setItem("cloudopsToken", payload.token);
      window.localStorage.setItem("cloudopsUser", JSON.stringify(payload.user));
      showToast(`Signed in as ${payload.user.displayName ?? payload.user.username}.`);
    } catch (error) {
      setError(withRequestId("Unable to sign in with local credentials.", error));
    } finally {
      setLoginLoading(false);
    }
  }

  function logout() {
    setAuthToken(operatorToken ?? "");
    setCurrentUser(null);
    window.localStorage.removeItem("cloudopsToken");
    window.localStorage.removeItem("cloudopsUser");
    showToast("Local session cleared.");
  }

  async function pollTriageJob(jobId) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const job = await fetchJson(`${apiUrl}/triage-jobs/${jobId}`);
      setTriageJob(job);

      if (job.status === "SUCCEEDED") {
        setTriage(job.result);
        return job;
      }
      if (job.status === "FAILED") {
        throw new Error(job.error ?? "Triage job failed.");
      }

      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }

    throw new Error("Triage job timed out before completion.");
  }

  async function runTriage() {
    if (!selectedIncident) return;

    setError(null);
    setTriage(null);
    setTriageJob(null);
    setFeedbackNote("");
    setFeedbackSubmitted(null);
    setTriageLoading(true);

    try {
      const job = await fetchJson(`${apiUrl}/incidents/${selectedIncident.id}/triage-jobs`, {
        method: "POST",
        headers: writeHeadersFor(authToken)
      });
      setTriageJob(job);
      await pollTriageJob(job.id);
      await loadIncidentTimeline(selectedIncident.id);
    } catch (error) {
      setError(withRequestId("Unable to complete triage. Check the triage agent, Ollama, and API status.", error));
    } finally {
      setTriageLoading(false);
    }
  }

  async function downloadIncidentReport() {
    if (!selectedIncident || reportLoading) return;

    setError(null);
    setReportLoading(true);

    try {
      const response = await fetch(`${apiUrl}/incidents/${selectedIncident.id}/report.md`);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const error = new Error(payload?.message ?? payload?.error ?? "report_export_failed");
        error.requestId = response.headers.get("x-request-id") ?? payload?.requestId;
        throw error;
      }

      const markdown = await response.text();
      const url = window.URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = reportDownloadName(selectedIncident.id);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      showToast(`Report exported for ${selectedIncident.id}.`);
    } catch (error) {
      setError(withRequestId("Unable to export incident report.", error));
    } finally {
      setReportLoading(false);
    }
  }

  async function createIncident(event) {
    event.preventDefault();
    if (incidentCreateLoading) return;

    setError(null);
    setWriteStatus("Creating incident...");
    setIncidentCreateLoading(true);

    try {
      const initialLogs = splitLines(incidentForm.logs);
      const incident = await fetchJson(`${apiUrl}/incidents`, {
        method: "POST",
        headers: writeHeadersFor(authToken),
        body: JSON.stringify({
          id: incidentForm.id.trim() || undefined,
          service: incidentForm.service.trim(),
          title: incidentForm.title.trim(),
          severity: incidentForm.severity,
          environment: incidentForm.environment.trim() || "stage",
          region: incidentForm.region.trim() || "local",
          owner: incidentForm.owner.trim() || "unassigned",
          deploymentVersion: incidentForm.deploymentVersion.trim() || "unknown",
          signals: splitLines(incidentForm.signals)
        })
      });

      if (initialLogs.length > 0) {
        await fetchJson(`${apiUrl}/incidents/${incident.id}/logs`, {
          method: "POST",
          headers: writeHeadersFor(authToken),
          body: JSON.stringify({
            logs: initialLogs.map((message) => ({
              level: message.toUpperCase().includes("ERROR") ? "ERROR" : message.toUpperCase().includes("WARN") ? "WARN" : "INFO",
              source: incident.service,
              message
            }))
          })
        });
      }
      setIncidentForm(emptyIncidentForm);
      setTriage(null);
      setFeedbackNote("");
      setFeedbackSubmitted(null);
      await loadDashboardData(incident.id);
      await loadIncidentLogs(incident.id);
      await loadIncidentTimeline(incident.id);
      setWriteStatus(`Created incident ${incident.id}.`);
      showToast(`Incident ${incident.id} submitted.`);
    } catch (error) {
      setWriteStatus(null);
      setError(withRequestId("Unable to create incident. Check required fields and API status.", error));
    } finally {
      setIncidentCreateLoading(false);
    }
  }

  async function appendLog(event) {
    event.preventDefault();
    if (!selectedIncident || appendLogLoading) return;

    setError(null);
    setWriteStatus("Appending log event...");
    setAppendLogLoading(true);

    try {
      await fetchJson(`${apiUrl}/incidents/${selectedIncident.id}/logs`, {
        method: "POST",
        headers: writeHeadersFor(authToken),
        body: JSON.stringify({
          level: logForm.level,
          source: logForm.source.trim() || selectedIncident.service,
          message: logForm.message.trim()
        })
      });

      setLogForm(emptyLogForm);
      setTriage(null);
      setFeedbackNote("");
      setFeedbackSubmitted(null);
      await loadIncidentLogs(selectedIncident.id);
      await loadIncidentTimeline(selectedIncident.id);
      setWriteStatus(`Appended log to ${selectedIncident.id}.`);
      showToast(`Log submitted to ${selectedIncident.id}.`);
    } catch (error) {
      setWriteStatus(null);
      setError(withRequestId("Unable to append log. Check the message and API status.", error));
    } finally {
      setAppendLogLoading(false);
    }
  }

  async function importLogFile(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fileInput = form.elements.logImportFile;
    const selectedFile = logImportFile ?? fileInput?.files?.[0];
    if (!selectedIncident || !selectedFile || logImportLoading) return;

    setError(null);
    setWriteStatus(`Importing ${selectedFile.name}...`);
    setLogImportLoading(true);

    try {
      const content = await selectedFile.text();
      const result = await fetchJson(`${apiUrl}/incidents/${selectedIncident.id}/log-import`, {
        method: "POST",
        headers: writeHeadersFor(authToken),
        body: JSON.stringify({
          filename: selectedFile.name,
          content,
          source: logForm.source.trim() || selectedIncident.service
        })
      });

      setLogImportFile(null);
      form.reset();
      setTriage(null);
      setTriageJob(null);
      setFeedbackNote("");
      setFeedbackSubmitted(null);
      await loadIncidentLogs(selectedIncident.id);
      await loadIncidentTimeline(selectedIncident.id);
      setWriteStatus(`Imported ${result.importedCount} logs from ${result.filename}.`);
      showToast(`Imported ${result.importedCount} logs into ${selectedIncident.id}.`);
    } catch (error) {
      setWriteStatus(null);
      const detail = error.payload?.error ?? error.message;
      setError(withRequestId(`Unable to import log file. ${detail}.`, error));
    } finally {
      setLogImportLoading(false);
    }
  }

  async function createRunbook(event) {
    event.preventDefault();
    if (runbookCreateLoading) return;

    setError(null);
    setWriteStatus("Creating runbook...");
    setRunbookCreateLoading(true);

    try {
      const runbook = await fetchJson(`${apiUrl}/runbooks`, {
        method: "POST",
        headers: writeHeadersFor(authToken),
        body: JSON.stringify({
          id: runbookForm.id.trim() || undefined,
          title: runbookForm.title.trim(),
          service: runbookForm.service.trim(),
          keywords: splitKeywords(runbookForm.keywords),
          steps: splitLines(runbookForm.steps)
        })
      });
      const versions = await fetchJson(`${apiUrl}/runbooks/${runbook.id}/versions`);

      setRunbookForm(emptyRunbookForm);
      setRunbookVersions(versions);
      setTriage(null);
      setFeedbackNote("");
      setFeedbackSubmitted(null);
      setWriteStatus(`Saved runbook ${runbook.id} version ${runbook.versionCreated}.`);
      showToast(`Runbook ${runbook.id} submitted.`);
    } catch (error) {
      setWriteStatus(null);
      setError(withRequestId("Unable to create runbook. Check required fields and API status.", error));
    } finally {
      setRunbookCreateLoading(false);
    }
  }

  async function submitTriageFeedback(rating) {
    if (!selectedIncident || !triage || feedbackLoading) return;

    setError(null);
    setFeedbackLoading(rating);

    try {
      const feedback = await fetchJson(`${apiUrl}/incidents/${selectedIncident.id}/triage-feedback`, {
        method: "POST",
        headers: writeHeadersFor(authToken),
        body: JSON.stringify({
          rating,
          note: feedbackNote.trim(),
          triageSource: triage.source
        })
      });
      setFeedbackSubmitted(feedback);
      setFeedbackNote("");
      await loadIncidentTimeline(selectedIncident.id);
      showToast(`Triage feedback saved for ${selectedIncident.id}.`);
    } catch (error) {
      setError(withRequestId("Unable to save triage feedback. Check API status.", error));
    } finally {
      setFeedbackLoading(null);
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <div>
          <h1>CloudOps Copilot</h1>
          <p>Incident triage, rollout safety, and runbook-assisted remediation.</p>
        </div>
        {authToken ? (
          <div className="session-card">
            <span className="env-pill">{currentUser?.displayName ?? currentUser?.username ?? "operator console"}</span>
            <button type="button" onClick={logout}>Log out</button>
          </div>
        ) : (
          <form className="login-form" onSubmit={submitLogin}>
            <input
              aria-label="Username"
              value={loginForm.username}
              onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value })}
            />
            <input
              aria-label="Password"
              type="password"
              value={loginForm.password}
              onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })}
            />
            <ActionButton type="submit" loading={loginLoading} loadingLabel="Signing in...">
              Sign In
            </ActionButton>
          </form>
        )}
      </header>

      {toast && <Toast message={toast.message} onDismiss={() => setToast(null)} />}

      {loading && <div className="progress" />}
      {error && <div className="alert error">{error}</div>}
      {writeStatus && <div className="alert info">{writeStatus}</div>}

      {serviceHealth && (
        <section className="health-grid" aria-label="Service health">
          <HealthCard
            label="Incident API"
            status={serviceHealth.services.api?.status}
            detail={serviceHealth.services.api?.message ?? "REST API online"}
          />
          <HealthCard
            label="Database"
            status={serviceHealth.services.database?.status}
            detail={formatHealthDetail(serviceHealth.services.database, "PostgreSQL reachable")}
          />
          <HealthCard
            label="Triage Agent"
            status={serviceHealth.services.triageAgent?.status}
            detail={formatTriageAgentDetail(serviceHealth.services.triageAgent)}
          />
          <HealthCard
            label="LLM"
            status={serviceHealth.services.llm?.status}
            detail={serviceHealth.services.llm?.enabled ? "Ollama triage enabled" : "Fallback triage active"}
          />
          <HealthCard
            label="Vector Memory"
            status={serviceHealth.services.vectorMemory?.status}
            detail={serviceHealth.services.vectorMemory?.enabled ? "pgvector RAG enabled" : "RAG memory unavailable"}
          />
          <button className="health-refresh" type="button" onClick={loadServiceHealth} disabled={healthLoading}>
            {healthLoading ? "Refreshing..." : "Refresh"}
          </button>
        </section>
      )}

      {summary && (
        <section className="metric-grid" aria-label="Incident summary">
          <Metric label="Total Incidents" value={summary.total} />
          <Metric label="Open Work" value={summary.open} />
          <Metric label="SEV2" value={summary.bySeverity?.SEV2 ?? 0} />
          <Metric label="Triaged" value={summary.byStatus?.TRIAGED ?? 0} />
        </section>
      )}

      <section className="content-grid">
        <aside className="panel">
          <div className="panel-title">
            <h2>Incident Queue</h2>
            <p>Select an incident to inspect signals and run triage.</p>
          </div>

          <div className="incident-list">
            {incidents.map((incident) => (
              <button
                key={incident.id}
                className={`incident-row ${selectedIncident?.id === incident.id ? "selected" : ""}`}
                disabled={triageLoading}
                onClick={() => {
                  setSelectedId(incident.id);
                  setTriage(null);
                  setTriageJob(null);
                  setFeedbackNote("");
                  setFeedbackSubmitted(null);
                  setSelectedLogs([]);
                }}
              >
                <span>
                  <strong>{incident.id}</strong>
                  <small>{incident.service}</small>
                </span>
                <span className={`severity ${incident.severity.toLowerCase()}`}>{incident.severity}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="panel">
          {selectedIncident && (
            <>
              <div className="section-header">
                <div>
                  <h2>{selectedIncident.title}</h2>
                  <p>
                    {selectedIncident.service} · {selectedIncident.region} · {selectedIncident.deploymentVersion}
                  </p>
                </div>
                <div className="header-actions">
                  <ActionButton onClick={runTriage} loading={triageLoading} loadingLabel="Triaging...">
                    Run Triage
                  </ActionButton>
                  <ActionButton
                    type="button"
                    className="secondary-button"
                    loading={reportLoading}
                    loadingLabel="Exporting..."
                    onClick={downloadIncidentReport}
                  >
                    Export Report
                  </ActionButton>
                </div>
              </div>

              <div className="chips">
                <span>{selectedIncident.status}</span>
                <span>{selectedIncident.environment}</span>
                <span>{selectedIncident.owner}</span>
              </div>

              <h3>Signals</h3>
              <ul className="compact-list">
                {selectedIncident.signals.map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>

              <h3>Runtime Logs</h3>
              <pre>
                {selectedLogs.length > 0
                  ? selectedLogs.map((log) => `${log.observedAt} ${log.level} ${log.source}: ${log.message}`).join("\n")
                  : "No log events stored for this incident."}
              </pre>

              <form className="inline-log-form" onSubmit={appendLog} aria-busy={appendLogLoading}>
                <select
                  value={logForm.level}
                  onChange={(event) => setLogForm({ ...logForm, level: event.target.value })}
                >
                  <option>INFO</option>
                  <option>WARN</option>
                  <option>ERROR</option>
                  <option>DEBUG</option>
                </select>
                <input
                  value={logForm.source}
                  onChange={(event) => setLogForm({ ...logForm, source: event.target.value })}
                  placeholder={selectedIncident.service}
                />
                <input
                  required
                  value={logForm.message}
                  onChange={(event) => setLogForm({ ...logForm, message: event.target.value })}
                  placeholder="Append a generated service log line"
                />
                <ActionButton type="submit" loading={appendLogLoading} loadingLabel="Appending...">
                  Append Log
                </ActionButton>
              </form>

              <form className="log-import-form" onSubmit={importLogFile} aria-busy={logImportLoading}>
                <label>
                  Import Log File
                  <input
                    name="logImportFile"
                    type="file"
                    accept=".log,.txt,.jsonl,.json"
                    onChange={(event) => setLogImportFile(event.target.files?.[0] ?? null)}
                  />
                </label>
                <ActionButton
                  type="submit"
                  className="secondary-button"
                  loading={logImportLoading}
                  loadingLabel="Importing..."
                >
                  Import Logs
                </ActionButton>
              </form>
            </>
          )}
        </section>

        <section className="panel triage-panel">
          <h2>Triage Result</h2>
          {triageLoading && (
            <div className="triage-loading" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <div>
                <strong>Running triage</strong>
                <p>
                  {triageJob
                    ? `${formatJobStep(triageJob.currentStep)} · ${triageJob.progress}%`
                    : "Queueing triage job."}
                </p>
              </div>
            </div>
          )}
          {triageJob && (
            <div className="job-progress" aria-label="Triage job progress">
              <div className="progress-track">
                <span style={{ width: `${triageJob.progress}%` }} />
              </div>
              <ol>
                {triageJob.steps.map((step) => (
                  <li className={step.status} key={step.id}>
                    <span>{step.label}</span>
                    <small>{formatStepStatus(step.status)}</small>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {!triageLoading && !triage && (
            <p className="muted">
              Run triage to classify the incident, retrieve runbooks, and draft remediation steps.
            </p>
          )}
          {triage && (
            <div className="triage-result">
              <div className="alert info">
                {triage.summary} Confidence: {Math.round(triage.confidence * 100)}%. Source: {triage.source}.
                {triage.requestId ? ` Request ID: ${triage.requestId}.` : ""}
              </div>

              <h3>Probable Root Cause</h3>
              <p>{triage.probableRootCause}</p>

              <h3>Recommended Actions</h3>
              <ul className="compact-list">
                {triage.recommendedActions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>

              <h3>Runbooks</h3>
              <div className="chips">
                {triage.runbooks.map((runbook) => (
                  <span key={runbook.id}>{runbook.id}: {runbook.title}</span>
                ))}
              </div>

              {triage.evidence && (
                <>
                  <h3>Evidence Used</h3>
                  <div className="evidence-grid">
                    <EvidenceCard title="Log Lines" items={triage.evidence.logLines} renderItem={(log) => (
                      <>
                        <strong>{log.level} {log.source}</strong>
                        <span>{log.message}</span>
                      </>
                    )} />
                    <EvidenceCard title="Signals" items={triage.evidence.signals} renderItem={(signal) => (
                      <span>{signal.text}</span>
                    )} />
                    <EvidenceCard title="Runbook Matches" items={triage.evidence.runbooks} renderItem={(runbook) => (
                      <>
                        <strong>{runbook.id}: {runbook.title}</strong>
                        <span>{runbook.matchedKeywords?.length > 0 ? runbook.matchedKeywords.join(", ") : "No keyword details"}</span>
                      </>
                    )} />
                  </div>
                </>
              )}

              {triage.similarCases?.length > 0 && (
                <>
                  <h3>Similar Past Triage</h3>
                  <div className="case-list">
                    {triage.similarCases.map((caseItem) => (
                      <article className="case-card" key={caseItem.id}>
                        <strong>{caseItem.id}: {caseItem.title}</strong>
                        <span>{caseItem.category} · {Math.round(caseItem.similarity * 100)}% match</span>
                        <p>{caseItem.rootCause}</p>
                      </article>
                    ))}
                  </div>
                </>
              )}

              <div className="feedback-panel">
                <h3>Triage Feedback</h3>
                <textarea
                  className="feedback-note"
                  rows="2"
                  value={feedbackNote}
                  onChange={(event) => setFeedbackNote(event.target.value)}
                  placeholder="Optional note for future triage tuning"
                />
                <div className="feedback-actions">
                  <ActionButton
                    type="button"
                    loading={feedbackLoading === "useful"}
                    disabled={Boolean(feedbackLoading)}
                    loadingLabel="Saving..."
                    onClick={() => submitTriageFeedback("useful")}
                  >
                    Useful
                  </ActionButton>
                  <ActionButton
                    type="button"
                    loading={feedbackLoading === "needs-work"}
                    disabled={Boolean(feedbackLoading)}
                    loadingLabel="Saving..."
                    onClick={() => submitTriageFeedback("needs-work")}
                  >
                    Needs Work
                  </ActionButton>
                  <ActionButton
                    type="button"
                    loading={feedbackLoading === "incorrect"}
                    disabled={Boolean(feedbackLoading)}
                    loadingLabel="Saving..."
                    onClick={() => submitTriageFeedback("incorrect")}
                  >
                    Incorrect
                  </ActionButton>
                </div>
                {feedbackSubmitted && (
                  <p className="muted">Saved feedback: {feedbackSubmitted.rating}.</p>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="panel timeline-panel">
          <div className="section-header">
            <div>
              <h2>Incident Timeline</h2>
              <p>{timelineLoading ? "Refreshing timeline." : `${timelineEvents.length} recorded events for this incident.`}</p>
            </div>
            {selectedIncident && (
              <button className="health-refresh" type="button" onClick={() => loadIncidentTimeline(selectedIncident.id)}>
                Refresh
              </button>
            )}
          </div>
          <div className="timeline-list">
            {timelineEvents.length > 0 ? timelineEvents.map((event) => (
              <article className={`timeline-event ${event.type}`} key={event.id}>
                <strong>{event.title}</strong>
                <span>{event.actor} · {new Date(event.occurredAt).toLocaleString()}</span>
                <small>{event.type}{event.severity ? ` · ${event.severity}` : ""}</small>
                {event.detail && <p>{event.detail}</p>}
              </article>
            )) : (
              <p className="muted">No timeline events recorded yet.</p>
            )}
          </div>
        </section>

        <section className="panel create-panel">
          <h2>Create Incident</h2>
          <form className="entity-form" onSubmit={createIncident} aria-busy={incidentCreateLoading}>
            <div className="form-grid">
              <label>
                Incident ID
                <input
                  value={incidentForm.id}
                  onChange={(event) => setIncidentForm({ ...incidentForm, id: event.target.value })}
                  placeholder="auto-generated"
                />
              </label>
              <label>
                Service
                <input
                  required
                  value={incidentForm.service}
                  onChange={(event) => setIncidentForm({ ...incidentForm, service: event.target.value })}
                />
              </label>
              <label className="wide-field">
                Title
                <input
                  required
                  value={incidentForm.title}
                  onChange={(event) => setIncidentForm({ ...incidentForm, title: event.target.value })}
                />
              </label>
              <label>
                Severity
                <select
                  value={incidentForm.severity}
                  onChange={(event) => setIncidentForm({ ...incidentForm, severity: event.target.value })}
                >
                  <option>SEV1</option>
                  <option>SEV2</option>
                  <option>SEV3</option>
                  <option>SEV4</option>
                </select>
              </label>
              <label>
                Environment
                <input
                  value={incidentForm.environment}
                  onChange={(event) => setIncidentForm({ ...incidentForm, environment: event.target.value })}
                />
              </label>
              <label>
                Region
                <input
                  value={incidentForm.region}
                  onChange={(event) => setIncidentForm({ ...incidentForm, region: event.target.value })}
                />
              </label>
              <label>
                Owner
                <input
                  value={incidentForm.owner}
                  onChange={(event) => setIncidentForm({ ...incidentForm, owner: event.target.value })}
                />
              </label>
              <label className="wide-field">
                Deployment Version
                <input
                  value={incidentForm.deploymentVersion}
                  onChange={(event) => setIncidentForm({ ...incidentForm, deploymentVersion: event.target.value })}
                  placeholder="partner-api.2026.05.02"
                />
              </label>
              <label className="wide-field">
                Signals
                <textarea
                  rows="4"
                  value={incidentForm.signals}
                  onChange={(event) => setIncidentForm({ ...incidentForm, signals: event.target.value })}
                />
              </label>
              <label className="wide-field">
                Initial Runtime Logs
                <textarea
                  rows="4"
                  value={incidentForm.logs}
                  onChange={(event) => setIncidentForm({ ...incidentForm, logs: event.target.value })}
                />
              </label>
            </div>
            <ActionButton type="submit" loading={incidentCreateLoading} loadingLabel="Creating...">
              Add Incident
            </ActionButton>
          </form>
        </section>

        <section className="panel create-panel">
          <h2>Create Runbook</h2>
          <form className="entity-form" onSubmit={createRunbook} aria-busy={runbookCreateLoading}>
            <div className="form-grid">
              <label>
                Runbook ID
                <input
                  value={runbookForm.id}
                  onChange={(event) => setRunbookForm({ ...runbookForm, id: event.target.value })}
                  placeholder="auto-generated"
                />
              </label>
              <label>
                Service
                <input
                  required
                  value={runbookForm.service}
                  onChange={(event) => setRunbookForm({ ...runbookForm, service: event.target.value })}
                />
              </label>
              <label className="wide-field">
                Title
                <input
                  required
                  value={runbookForm.title}
                  onChange={(event) => setRunbookForm({ ...runbookForm, title: event.target.value })}
                />
              </label>
              <label className="wide-field">
                Keywords
                <textarea
                  rows="3"
                  value={runbookForm.keywords}
                  onChange={(event) => setRunbookForm({ ...runbookForm, keywords: event.target.value })}
                />
              </label>
              <label className="wide-field">
                Steps
                <textarea
                  rows="5"
                  value={runbookForm.steps}
                  onChange={(event) => setRunbookForm({ ...runbookForm, steps: event.target.value })}
                />
              </label>
            </div>
            <ActionButton type="submit" loading={runbookCreateLoading} loadingLabel="Creating...">
              Add Runbook
            </ActionButton>
          </form>
          {runbookVersions.length > 0 && (
            <div className="version-list">
              <h3>{runbookVersions[0].runbookId} Versions</h3>
              {runbookVersions.map((version) => (
                <article className="version-row" key={version.id}>
                  <strong>v{version.version}: {version.title}</strong>
                  <span>{version.createdBy} · {new Date(version.createdAt).toLocaleString()}</span>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <article className="metric-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function EvidenceCard({ title, items = [], renderItem }) {
  return (
    <article className="evidence-card">
      <h4>{title}</h4>
      {items.length > 0 ? (
        <ul>
          {items.map((item, index) => (
            <li key={item.id ?? `${title}-${index}`}>{renderItem(item)}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No evidence attached.</p>
      )}
    </article>
  );
}

function HealthCard({ label, status = "unknown", detail }) {
  return (
    <article className={`health-card ${status}`}>
      <span className="health-label">{label}</span>
      <strong>
        <span className="status-dot" aria-hidden="true" />
        {formatHealthStatus(status)}
      </strong>
      <small>{detail}</small>
    </article>
  );
}

function formatHealthStatus(status) {
  const labels = {
    ok: "OK",
    degraded: "Degraded",
    down: "Down",
    fallback: "Fallback",
    unknown: "Unknown"
  };
  return labels[status] ?? "Unknown";
}

function formatHealthDetail(service, fallback) {
  if (!service) return "Unknown";
  if (service.message) return service.message;
  if (typeof service.latencyMs === "number") return `${fallback} · ${service.latencyMs} ms`;
  return fallback;
}

function formatTriageAgentDetail(service) {
  if (!service) return "Unknown";
  if (service.status === "fallback") return "API fallback triage active";
  if (service.message) return service.message;
  if (service.status === "ok") {
    return service.triageOrchestration ? `Agent reachable · ${service.triageOrchestration}` : "Agent reachable";
  }
  return "Agent unavailable";
}

function formatJobStep(step) {
  return String(step ?? "queued")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatStepStatus(status) {
  const labels = {
    pending: "Pending",
    running: "Running",
    complete: "Complete",
    failed: "Failed"
  };
  return labels[status] ?? "Pending";
}

function ActionButton({ children, loading, loadingLabel, disabled, className = "", ...props }) {
  return (
    <button
      {...props}
      className={`primary-button action-button ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading}
    >
      {loading && <span className="button-spinner" aria-hidden="true" />}
      <span>{loading ? loadingLabel : children}</span>
    </button>
  );
}

function Toast({ message, onDismiss }) {
  return (
    <div className="toast-popup" role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification">
        x
      </button>
    </div>
  );
}

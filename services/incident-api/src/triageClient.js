export function fallbackTriage(incident, runbooks, requestId = null) {
  const runbookMatches = runbooks.slice(0, 3);
  const rootCause =
    incident.logs?.find((line) => line.includes("ERROR")) ??
    incident.signals?.[0] ??
    "No high-confidence root cause found.";

  const result = {
    incidentId: incident.id,
    category: inferCategory(incident),
    confidence: runbookMatches.length > 0 ? 0.72 : 0.48,
    summary: `${incident.service} incident ${incident.id}: ${incident.title}`,
    probableRootCause: rootCause,
    runbooks: runbookMatches,
    recommendedActions: runbookMatches[0]?.steps ?? [
      "Inspect recent deployments.",
      "Check service logs and error-rate dashboards.",
      "Attach findings to the incident ticket."
    ],
    source: "incident-api-fallback",
    ...(requestId ? { requestId } : {})
  };

  return withEvidence(result, incident, runbooks);
}

function parseTimeoutMs(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 70000;
}

function normalizeRequestId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : null;
}

export async function requestTriage(incident, runbooks, agentUrl, options = {}) {
  const requestId = normalizeRequestId(options.requestId);
  if (!agentUrl) {
    return fallbackTriage(incident, runbooks, requestId);
  }

  const timeoutMs = parseTimeoutMs(options.timeoutMs ?? process.env.TRIAGE_AGENT_TIMEOUT_MS);
  const headers = { "content-type": "application/json" };
  if (requestId) {
    headers["x-request-id"] = requestId;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${agentUrl}/triage`, {
      method: "POST",
      headers,
      body: JSON.stringify({ incident, runbooks }),
      signal: controller.signal
    });

    if (!response.ok) {
      return fallbackTriage(incident, runbooks, requestId);
    }

    const payload = await response.json();
    const result = requestId && !payload.requestId ? { ...payload, requestId } : payload;
    return withEvidence(result, incident, runbooks);
  } catch {
    return fallbackTriage(incident, runbooks, requestId);
  } finally {
    clearTimeout(timer);
  }
}

function withEvidence(result, incident, runbooks) {
  return {
    ...result,
    evidence: result.evidence ?? buildEvidence(result, incident, runbooks)
  };
}

function buildEvidence(result, incident, runbooks) {
  const text = [
    incident.title,
    ...(incident.signals ?? []),
    ...(incident.logs ?? [])
  ].join(" ").toLowerCase();
  const selectedRunbookIds = new Set((result.runbooks ?? []).map((runbook) => runbook.id));
  const candidateRunbooks = runbooks.filter((runbook) => selectedRunbookIds.size === 0 || selectedRunbookIds.has(runbook.id));

  return {
    signals: (incident.signals ?? []).slice(0, 8).map((signal, index) => ({
      id: `signal-${index + 1}`,
      text: signal
    })),
    logLines: evidenceLogLines(incident).slice(0, 10),
    runbooks: candidateRunbooks.slice(0, 5).map((runbook) => ({
      id: runbook.id,
      title: runbook.title,
      matchedKeywords: (runbook.keywords ?? []).filter((keyword) => text.includes(keyword.toLowerCase()))
    })),
    similarCases: (result.similarCases ?? []).slice(0, 5).map((caseItem) => ({
      id: caseItem.id,
      title: caseItem.title,
      category: caseItem.category,
      similarity: caseItem.similarity
    }))
  };
}

function evidenceLogLines(incident) {
  const logEvents = Array.isArray(incident.logEvents)
    ? incident.logEvents.map((log, index) => ({
        id: log.id ?? `log-${index + 1}`,
        observedAt: log.observedAt,
        level: log.level,
        source: log.source,
        message: log.message
      }))
    : [];

  const stringLogs = (incident.logs ?? []).map((line, index) => ({
    id: `log-${index + 1}`,
    observedAt: null,
    level: line.includes("ERROR") ? "ERROR" : line.includes("WARN") ? "WARN" : "INFO",
    source: incident.service,
    message: line
  }));
  const logs = logEvents.length > 0 ? logEvents : stringLogs;
  const severe = logs.filter((log) => ["ERROR", "WARN"].includes(String(log.level).toUpperCase()));
  return severe.length > 0 ? severe : logs;
}

function inferCategory(incident) {
  const text = [incident.title, ...(incident.signals ?? []), ...(incident.logs ?? [])]
    .join(" ")
    .toLowerCase();

  if (text.includes("patch") || text.includes("deployment") || text.includes("rollout")) {
    return "rollout";
  }
  if (text.includes("storage") || text.includes("capacity")) {
    return "capacity";
  }
  if (text.includes("latency") || text.includes("timeout")) {
    return "latency";
  }
  return "service";
}

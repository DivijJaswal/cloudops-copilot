import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { requestTriage } from "../src/triageClient.js";

test("triage client falls back when agent request times out", async () => {
  const server = await listenUnresponsiveServer();
  const { port } = server.address();

  const result = await requestTriage(
    {
      id: "INC-TIMEOUT",
      service: "incident-api",
      title: "Agent timeout",
      severity: "SEV3",
      signals: ["triage agent did not respond"],
      logs: []
    },
    [],
    `http://127.0.0.1:${port}`,
    {
      timeoutMs: 10,
      requestId: "req-timeout-123"
    }
  );

  assert.equal(result.source, "incident-api-fallback");
  assert.equal(result.incidentId, "INC-TIMEOUT");
  assert.equal(result.requestId, "req-timeout-123");
  assert.equal(result.evidence.signals[0].text, "triage agent did not respond");

  await closeServer(server);
});

test("triage client forwards request id to the agent", async () => {
  let receivedRequestId = null;
  const server = await listenTriageServer((req, res) => {
    receivedRequestId = req.headers["x-request-id"];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      incidentId: "INC-FORWARD",
      source: "test-agent"
    }));
  });
  const { port } = server.address();

  const result = await requestTriage(
    {
      id: "INC-FORWARD",
      service: "incident-api",
      title: "Forward request id",
      severity: "SEV3",
      signals: ["forward signal"],
      logs: ["ERROR forwarded log line"]
    },
    [{
      id: "RB-FORWARD",
      title: "Forward runbook",
      keywords: ["forwarded", "signal"],
      steps: ["Inspect forwarding path"]
    }],
    `http://127.0.0.1:${port}`,
    {
      timeoutMs: 1000,
      requestId: "req-forward-123"
    }
  );

  assert.equal(receivedRequestId, "req-forward-123");
  assert.equal(result.source, "test-agent");
  assert.equal(result.incidentId, "INC-FORWARD");
  assert.equal(result.requestId, "req-forward-123");
  assert.equal(result.evidence.logLines[0].message, "ERROR forwarded log line");
  assert.deepEqual(result.evidence.runbooks[0].matchedKeywords, ["forwarded", "signal"]);

  await closeServer(server);
});

function listenUnresponsiveServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, _res) => {
      // Intentionally never respond so the client-side timeout path is exercised.
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function listenTriageServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

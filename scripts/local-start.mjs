import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const exampleEnv = loadEnvFile(path.join(repoRoot, ".env.example"));
const localEnv = loadEnvFile(path.join(repoRoot, ".env"));

const defaults = {
  DATABASE_URL: "postgres://cloudops:cloudops@127.0.0.1:5432/cloudops_copilot",
  OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  TRIAGE_AGENT_URL: "http://127.0.0.1:5001",
  TRIAGE_AGENT_TIMEOUT_MS: "70000",
  CORS_ORIGIN: "http://127.0.0.1:5173,http://localhost:5173",
  INCIDENT_API_HOST: "127.0.0.1",
  INCIDENT_API_PORT: "8080",
  TRIAGE_AGENT_HOST: "127.0.0.1",
  TRIAGE_AGENT_PORT: "5001",
  DASHBOARD_HOST: "127.0.0.1",
  DASHBOARD_PORT: "5173",
};

const env = {
  ...defaults,
  ...exampleEnv,
  ...localEnv,
  ...process.env,
  CLOUDOPS_REPO_ROOT: repoRoot,
};

if (!hasConfiguredValue("VITE_API_URL")) {
  env.VITE_API_URL = buildConnectUrl(env.INCIDENT_API_HOST, env.INCIDENT_API_PORT);
}

if (!hasConfiguredValue("TRIAGE_AGENT_URL")) {
  env.TRIAGE_AGENT_URL = buildConnectUrl(env.TRIAGE_AGENT_HOST, env.TRIAGE_AGENT_PORT);
}

if (!hasConfiguredValue("CORS_ORIGIN")) {
  env.CORS_ORIGIN = [
    buildConnectUrl(env.DASHBOARD_HOST, env.DASHBOARD_PORT),
    buildPublicUrl(env.DASHBOARD_HOST, env.DASHBOARD_PORT),
  ].join(",");
}

const pythonCommand = existsSync(path.join(repoRoot, ".venv", "bin", "python"))
  ? path.join(repoRoot, ".venv", "bin", "python")
  : "python3";

const managedProcesses = new Map();
let shuttingDown = false;

process.once("SIGINT", () => {
  void shutdown(0, "Received SIGINT; stopping local services.");
});

process.once("SIGTERM", () => {
  void shutdown(0, "Received SIGTERM; stopping local services.");
});

try {
  await main();
} catch (error) {
  console.error(`\nlocal:start failed: ${error.message}`);
  process.exit(1);
}

async function main() {
  printHeader();
  await runPreflight();
  await seedDemoData();
  startServices();
  await reportReadiness();
  console.log("\nLocal stack is running. Press Ctrl+C to stop all services.");
}

function printHeader() {
  console.log("CloudOps Copilot local runner");
  console.log(`Repo: ${repoRoot}`);
  console.log(`Python: ${path.isAbsolute(pythonCommand) ? path.relative(repoRoot, pythonCommand) : pythonCommand}`);
}

async function runPreflight() {
  console.log("\nPreflight checks");

  await assertPostgresReachable();
  await assertServicePortsAvailable();
  await assertPythonDependencies();
  await warnIfOllamaUnavailable();
}

async function assertPostgresReachable() {
  const database = parseServiceUrl(env.DATABASE_URL, 5432);
  const reachable = await canOpenTcp(database.host, database.port);
  if (!reachable) {
    throw new Error(
      [
        `PostgreSQL is not reachable at ${database.host}:${database.port}.`,
        "Start it first with `yarn db:up`, or use Homebrew PostgreSQL:",
        "  brew services start postgresql@17",
        "  /opt/homebrew/opt/postgresql@17/bin/createdb -h 127.0.0.1 -p 5432 -O cloudops cloudops_copilot",
      ].join("\n"),
    );
  }

  console.log(`  ok PostgreSQL reachable at ${database.host}:${database.port}`);
}

async function assertServicePortsAvailable() {
  const ports = [
    ["Incident API", env.INCIDENT_API_HOST, env.INCIDENT_API_PORT],
    ["Triage Agent", env.TRIAGE_AGENT_HOST, env.TRIAGE_AGENT_PORT],
    ["Dashboard", env.DASHBOARD_HOST, env.DASHBOARD_PORT],
  ];

  for (const [label, host, port] of ports) {
    const reachable = await canOpenTcp(host, Number(port), 300);
    if (reachable) {
      throw new Error(
        `${label} port ${connectHost(host)}:${port} is already in use. Stop the existing process or change the port in .env.`,
      );
    }
    console.log(`  ok ${label} port ${connectHost(host)}:${port} is available`);
  }
}

async function assertPythonDependencies() {
  const result = await exec(
    pythonCommand,
    [
      "-c",
      "import flask, flask_cors, langgraph, psycopg, requests; print('triage dependencies import cleanly')",
    ],
    { timeout: 8000 },
  );

  if (!result.ok) {
    throw new Error(
      [
        "Python triage dependencies are missing.",
        "Run:",
        "  python3 -m venv .venv",
        "  .venv/bin/python -m pip install -r services/triage-agent/requirements.txt",
        "",
        result.stderr || result.error?.message || "Python import check failed.",
      ].join("\n"),
    );
  }

  console.log(`  ok ${result.stdout || "Python triage dependencies import cleanly"}`);
}

async function warnIfOllamaUnavailable() {
  const ollama = parseServiceUrl(env.OLLAMA_BASE_URL, 11434);
  const reachable = await canOpenTcp(ollama.host, ollama.port, 500);
  if (!reachable) {
    console.log(
      `  warn Ollama is not reachable at ${ollama.host}:${ollama.port}; triage will use deterministic fallback until Ollama is running.`,
    );
    return;
  }

  const tags = await fetchJson(`${trimTrailingSlash(env.OLLAMA_BASE_URL)}/api/tags`, 1500);
  if (!tags.ok) {
    console.log(
      `  warn Ollama port is open, but ${trimTrailingSlash(env.OLLAMA_BASE_URL)}/api/tags did not return cleanly.`,
    );
    return;
  }

  const installed = new Set(
    (Array.isArray(tags.json?.models) ? tags.json.models : [])
      .map((model) => normalizeModelName(model.name)),
  );
  const required = [
    env.OLLAMA_CHAT_MODEL || "llama3.1",
    env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text",
  ];
  const missing = required.filter((model) => !installed.has(normalizeModelName(model)));

  if (missing.length > 0) {
    console.log(`  warn Ollama is missing model(s): ${missing.join(", ")}`);
    console.log(`       Run: ${missing.map((model) => `ollama pull ${model}`).join(" && ")}`);
    return;
  }

  console.log(`  ok Ollama reachable with ${required.join(", ")}`);
}

async function seedDemoData() {
  console.log("\nPreparing local demo data");
  await spawnAndWait("seed", "node", ["scripts/demo-seed.mjs"], env);
}

function startServices() {
  console.log("\nStarting services");
  startManagedProcess("api", "yarn", ["workspace", "@cloudops/incident-api", "dev"]);
  startManagedProcess("agent", pythonCommand, ["services/triage-agent/app/server.py"]);
  startManagedProcess(
    "dashboard",
    "yarn",
    [
      "workspace",
      "@cloudops/dashboard",
      "dev",
      "--host",
      env.DASHBOARD_HOST,
      "--port",
      String(env.DASHBOARD_PORT),
      "--strictPort",
    ],
  );
}

async function reportReadiness() {
  const apiUrl = buildConnectUrl(env.INCIDENT_API_HOST, env.INCIDENT_API_PORT);
  const agentUrl = buildConnectUrl(env.TRIAGE_AGENT_HOST, env.TRIAGE_AGENT_PORT);
  const dashboardUrl = buildPublicUrl(env.DASHBOARD_HOST, env.DASHBOARD_PORT);

  console.log("\nWaiting for services");
  const results = await Promise.all([
    waitForHttp("Incident API", `${apiUrl}/health`, 25000),
    waitForHttp("Triage Agent", `${agentUrl}/health`, 25000),
    waitForHttp("Dashboard", dashboardUrl, 30000),
  ]);

  for (const result of results) {
    console.log(`  ${result.ok ? "ok" : "warn"} ${result.label}: ${result.message}`);
  }

  console.log("\nURLs");
  console.log(`  Dashboard: ${dashboardUrl}`);
  console.log(`  Incident API: ${buildPublicUrl(env.INCIDENT_API_HOST, env.INCIDENT_API_PORT)}`);
  console.log(`  Triage Agent: ${buildPublicUrl(env.TRIAGE_AGENT_HOST, env.TRIAGE_AGENT_PORT)}`);
  console.log("  Login: operator / cloudops");
}

function startManagedProcess(label, command, args) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const flushStdout = prefixStream(child.stdout, label);
  const flushStderr = prefixStream(child.stderr, label);

  const record = {
    child,
    closed: false,
    exitPromise: new Promise((resolve) => {
      child.once("close", (code, signal) => {
        flushStdout();
        flushStderr();
        record.closed = true;
        managedProcesses.delete(label);
        resolve({ code, signal });

        if (!shuttingDown) {
          const detail = signal ? `signal ${signal}` : `exit code ${code}`;
          void shutdown(1, `${label} stopped unexpectedly with ${detail}.`);
        }
      });
    }),
  };

  child.once("error", (error) => {
    if (!shuttingDown) {
      void shutdown(1, `${label} failed to start: ${error.message}`);
    }
  });

  managedProcesses.set(label, record);
}

async function spawnAndWait(label, command, args, childEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const flushStdout = prefixStream(child.stdout, label);
    const flushStderr = prefixStream(child.stderr, label);

    child.once("error", reject);
    child.once("close", (code, signal) => {
      flushStdout();
      flushStderr();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

async function shutdown(exitCode, message) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  if (message) {
    console.log(`\n${message}`);
  }

  const records = [...managedProcesses.values()];
  for (const record of records) {
    terminateProcess(record.child, "SIGTERM");
  }

  const killTimer = setTimeout(() => {
    for (const record of records) {
      if (!record.closed) {
        terminateProcess(record.child, "SIGKILL");
      }
    }
  }, 5000);

  await Promise.allSettled(records.map((record) => record.exitPromise));
  clearTimeout(killTimer);
  process.exit(exitCode);
}

function terminateProcess(child, signal) {
  if (!child.pid || child.killed) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") {
      console.error(`Failed to stop process ${child.pid}: ${error.message}`);
    }
  }
}

function prefixStream(stream, label) {
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) {
        console.log(`[${label}] ${line}`);
      }
    }
  });

  return () => {
    if (buffer.length > 0) {
      console.log(`[${label}] ${buffer}`);
      buffer = "";
    }
  };
}

async function waitForHttp(label, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "not reachable";

  while (Date.now() < deadline && !shuttingDown) {
    const response = await fetchJson(url, 1200);
    if (response.ok) {
      return { ok: true, label, message: `${url} is ready` };
    }
    lastStatus = response.status ? `HTTP ${response.status}` : response.error?.message || "not reachable";
    await delay(500);
  }

  return { ok: false, label, message: `${url} was not ready before timeout (${lastStatus})` };
}

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: repoRoot,
        timeout: options.timeout ?? 5000,
        env,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error,
        });
      },
    );
  });
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((values, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return values;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        return values;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[key] = value;
      return values;
    }, {});
}

function hasConfiguredValue(key) {
  return hasValue(localEnv, key) || hasValue(process.env, key);
}

function hasValue(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key) && String(source[key] ?? "").length > 0;
}

function parseServiceUrl(value, fallbackPort) {
  try {
    const parsed = new URL(value);
    return {
      host: connectHost(parsed.hostname || "127.0.0.1"),
      port: Number(parsed.port || fallbackPort),
    };
  } catch {
    return {
      host: "127.0.0.1",
      port: fallbackPort,
    };
  }
}

function canOpenTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: connectHost(host), port: Number(port) });
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timeout);
  }
}

function buildConnectUrl(host, port) {
  return `http://${connectHost(host)}:${Number(port)}`;
}

function buildPublicUrl(host, port) {
  return `http://${publicHost(host)}:${Number(port)}`;
}

function connectHost(host) {
  if (!host || host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host;
}

function publicHost(host) {
  if (!host || host === "127.0.0.1" || host === "0.0.0.0" || host === "::") {
    return "localhost";
  }
  return host;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeModelName(value) {
  return String(value || "").split(":")[0];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

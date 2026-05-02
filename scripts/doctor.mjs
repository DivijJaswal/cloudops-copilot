import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const strict = process.argv.includes("--strict");

const checkResults = [];

const env = {
  ...loadEnvFile(path.join(repoRoot, ".env.example")),
  ...loadEnvFile(path.join(repoRoot, ".env")),
  ...process.env,
};

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

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: repoRoot,
        timeout: options.timeout ?? 5000,
        env: {
          ...process.env,
          ...(options.env ?? {}),
        },
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

function record(status, label, detail, nextStep = "") {
  checkResults.push({ status, label, detail, nextStep });
}

async function checkCommand(label, command, args, required = true) {
  const result = await exec(command, args, { timeout: 5000 });
  if (result.ok) {
    record("pass", label, result.stdout || `${command} is available`);
    return result;
  }

  record(
    required ? "fail" : "warn",
    label,
    result.stderr || result.error?.message || `${command} is unavailable`,
    required ? `Install ${command} before running the full local stack.` : "",
  );
  return result;
}

function parsePortFromUrl(value, fallbackPort) {
  try {
    const parsed = new URL(value);
    return {
      host: parsed.hostname || "127.0.0.1",
      port: Number(parsed.port || fallbackPort),
      database: parsed.pathname.replace(/^\//, ""),
      user: decodeURIComponent(parsed.username || ""),
    };
  } catch {
    return {
      host: "127.0.0.1",
      port: fallbackPort,
      database: "",
      user: "",
    };
  }
}

function canOpenTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
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

async function fetchJson(url, timeoutMs = 1500) {
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

function normalizeModelName(value) {
  return String(value || "").split(":")[0];
}

async function checkPythonDependencies() {
  const venvPython = path.join(repoRoot, ".venv", "bin", "python");
  const pythonCommand = existsSync(venvPython) ? venvPython : "python3";
  const result = await exec(pythonCommand, [
    "-c",
    "import flask, psycopg, requests; print('triage dependencies import cleanly')",
  ]);

  if (result.ok) {
    record("pass", "Python triage dependencies", result.stdout);
    return;
  }

  record(
    "warn",
    "Python triage dependencies",
    result.stderr || result.error?.message || "Python imports failed",
    "Run: python3 -m venv .venv && source .venv/bin/activate && python -m pip install -r services/triage-agent/requirements.txt",
  );
}

async function checkDocker() {
  const result = await exec("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeout: 5000,
  });

  if (result.ok) {
    record("pass", "Docker daemon", `running, server ${result.stdout}`);
    return;
  }

  record(
    "warn",
    "Docker daemon",
    result.stderr || result.error?.message || "Docker daemon is not reachable",
    "Start Docker Desktop/Rancher Desktop, or use the Homebrew PostgreSQL path from README.md.",
  );
}

async function checkPostgres() {
  const config = parsePortFromUrl(env.DATABASE_URL, 5432);
  const reachable = await canOpenTcp(config.host, config.port);
  if (reachable) {
    record(
      "pass",
      "PostgreSQL port",
      `${config.host}:${config.port} is reachable${config.database ? ` for ${config.database}` : ""}`,
    );
    return;
  }

  record(
    "warn",
    "PostgreSQL port",
    `${config.host}:${config.port} is not reachable`,
    "Run: yarn db:up, or start postgresql@17 with Homebrew and create the cloudops_copilot database.",
  );
}

async function checkOllama() {
  const baseUrl = env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const tags = await fetchJson(`${baseUrl.replace(/\/$/, "")}/api/tags`);

  if (!tags.ok) {
    record(
      "warn",
      "Ollama API",
      `${baseUrl} is not reachable`,
      "Run: ollama serve, then pull llama3.1 and nomic-embed-text.",
    );
    return;
  }

  const models = Array.isArray(tags.json?.models) ? tags.json.models : [];
  const installed = models.map((model) => normalizeModelName(model.name));
  const requiredModels = [
    env.OLLAMA_CHAT_MODEL || "llama3.1",
    env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text",
  ];
  const missing = requiredModels.filter(
    (model) => !installed.includes(normalizeModelName(model)),
  );

  if (missing.length === 0) {
    record("pass", "Ollama models", `available: ${requiredModels.join(", ")}`);
    return;
  }

  record(
    "warn",
    "Ollama models",
    `missing: ${missing.join(", ")}`,
    `Run: ${missing.map((model) => `ollama pull ${model}`).join(" && ")}`,
  );
}

async function checkServiceHealth(label, url, nextStep) {
  const response = await fetchJson(url);
  if (response.ok) {
    record("pass", label, `${url} returned HTTP ${response.status}`);
    return;
  }

  record(
    "warn",
    label,
    `${url} is not serving yet`,
    nextStep,
  );
}

async function main() {
  console.log("CloudOps Copilot doctor\n");

  await checkCommand("Node.js", "node", ["--version"]);
  await checkCommand("Yarn", "yarn", ["--version"]);
  await checkCommand("Python", "python3", ["--version"]);
  await checkPythonDependencies();
  await checkDocker();
  await checkPostgres();
  await checkOllama();

  const incidentPort = env.INCIDENT_API_PORT || "8080";
  const triagePort = env.TRIAGE_AGENT_PORT || "5001";
  await checkServiceHealth(
    "Incident API health",
    `http://127.0.0.1:${incidentPort}/health`,
    "Run the API with yarn dev:api after Postgres is available.",
  );
  await checkServiceHealth(
    "Triage agent health",
    `http://127.0.0.1:${triagePort}/health`,
    "Run the agent with source .venv/bin/activate && yarn dev:agent.",
  );

  const failed = checkResults.filter((result) => result.status === "fail");
  const warned = checkResults.filter((result) => result.status === "warn");

  for (const result of checkResults) {
    const marker = result.status === "pass" ? "PASS" : result.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${marker}] ${result.label}: ${result.detail}`);
    if (result.nextStep) {
      console.log(`       ${result.nextStep}`);
    }
  }

  console.log(
    `\nSummary: ${failed.length} failed, ${warned.length} warning${warned.length === 1 ? "" : "s"}.`,
  );

  if (failed.length > 0 || (strict && warned.length > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { chromium } from "playwright";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const baseUrl = process.env.DEMO_BASE_URL ?? "http://localhost:5173";
const apiUrl = process.env.DEMO_API_URL ?? "http://127.0.0.1:8080";
const outputDir = path.resolve(repoRoot, process.env.DEMO_VIDEO_DIR ?? "artifacts/demo-video");
const finalVideoPath = path.join(outputDir, "cloudops-copilot-walkthrough.webm");
const headless = process.env.DEMO_HEADLESS === "true";
const stepDelayMs = Number(process.env.DEMO_STEP_DELAY_MS ?? 5000);
const actionDelayMs = Number(process.env.DEMO_ACTION_DELAY_MS ?? stepDelayMs);
const suffix = Date.now().toString().slice(-6);
const incidentId = `INC-DEMO-${suffix}`;
const runbookId = `RB-DEMO-${suffix}`;
const keyword = `demo-rollout-${suffix}`;

await assertLocalStackReady();
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless,
  slowMo: Number(process.env.DEMO_SLOW_MO_MS ?? Math.min(actionDelayMs, 1000)),
});
const context = await browser.newContext({
  acceptDownloads: true,
  recordVideo: {
    dir: outputDir,
    size: { width: 1440, height: 1000 },
  },
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();

try {
  await page.goto(baseUrl);
  await page.waitForLoadState("domcontentloaded");
  await installCaptionOverlay(page);

  await caption(page, "CloudOps Copilot local dashboard: start from the running app.", 1400);
  await login(page);
  await showHealthAndQueue(page);
  await inspectExistingIncident(page);
  await appendRuntimeLog(page, `WARN existing incident demo heartbeat ${keyword}`);
  await importRuntimeLogs(page, `2026-05-02T10:00:00Z ERROR imported existing incident log ${keyword}`);
  await createIncident(page);
  await createRunbook(page);
  await runTriage(page);
  await submitFeedback(page);
  await exportReport(page);
  await showTimeline(page);

  await caption(page, "Walkthrough complete: login, health, incidents, logs, runbooks, triage, evidence, feedback, reports, and timeline.", 2500);
} finally {
  const video = page.video();
  await context.close();
  await browser.close();

  if (video) {
    const recordedPath = await video.path();
    await rename(recordedPath, finalVideoPath);
    console.log(`Demo video saved to ${finalVideoPath}`);
  }
}

async function assertLocalStackReady() {
  const [dashboard, api, agent] = await Promise.all([
    fetchOk(baseUrl),
    fetchOk(`${apiUrl}/health`),
    fetchOk(process.env.DEMO_TRIAGE_AGENT_URL ?? "http://127.0.0.1:5001/health"),
  ]);

  if (!dashboard.ok || !api.ok || !agent.ok) {
    throw new Error([
      "The local stack must already be running before recording.",
      `Dashboard ${baseUrl}: ${dashboard.message}`,
      `Incident API ${apiUrl}/health: ${api.message}`,
      `Triage Agent: ${agent.message}`,
      "Start it with: yarn local:start",
    ].join("\n"));
  }
}

async function fetchOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return {
      ok: response.ok,
      message: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error.message,
    };
  }
}

async function installCaptionOverlay(page) {
  await page.addStyleTag({
    content: `
      #demo-caption {
        position: fixed;
        left: 24px;
        bottom: 24px;
        z-index: 999999;
        max-width: 760px;
        padding: 14px 18px;
        color: #f8fafc;
        background: rgba(15, 23, 42, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 8px;
        box-shadow: 0 18px 45px rgba(15, 23, 42, 0.28);
        font: 600 18px/1.35 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
    `,
  });
}

async function caption(page, text, durationMs = stepDelayMs) {
  console.log(text);
  await page.evaluate((message) => {
    let captionElement = document.querySelector("#demo-caption");
    if (!captionElement) {
      captionElement = document.createElement("div");
      captionElement.id = "demo-caption";
      document.body.appendChild(captionElement);
    }
    captionElement.textContent = message;
  }, text);
  await page.waitForTimeout(Math.max(durationMs, stepDelayMs));
}

async function pauseOperation(page) {
  await page.waitForTimeout(actionDelayMs);
}

async function login(page) {
  await caption(page, "Sign in with the local operator account.", 1000);
  const username = page.getByLabel("Username");
  const password = page.getByLabel("Password");
  await username.fill("operator");
  await pauseOperation(page);
  await password.fill("cloudops");
  await pauseOperation(page);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.getByText("Signed in as Local Operator.").waitFor({ state: "visible", timeout: 15000 });
  await caption(page, "The dashboard stores the local bearer token and unlocks write workflows.", 1400);
}

async function showHealthAndQueue(page) {
  await caption(page, "Service health shows API, PostgreSQL, the triage agent, LLM status, and vector memory.", 1800);
  await page.getByLabel("Service health").scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await caption(page, "The incident queue is the operator's starting point for selecting active work.", 1400);
  await page.getByRole("heading", { name: "Incident Queue" }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
}

async function inspectExistingIncident(page) {
  await caption(page, "Open an existing seeded incident to review signals and runtime logs.", 1300);
  const seededIncident = page.getByRole("button", { name: /INC-1001/ });
  if (await seededIncident.count()) {
    await seededIncident.click();
    await pauseOperation(page);
  }
  await page.getByRole("button", { name: "Run Triage" }).scrollIntoViewIfNeeded();
  await caption(page, "Each incident view includes metadata, signals, stored runtime logs, and operator actions.", 1600);
}

async function appendRuntimeLog(page, message) {
  await caption(page, "Append a runtime log generated outside the incident record.", 1200);
  await page.getByPlaceholder("Append a generated service log line").fill(message);
  await pauseOperation(page);
  await page.getByRole("button", { name: "Append Log" }).click();
  await page.getByText("Log submitted", { exact: false }).waitFor({ state: "visible", timeout: 15000 });
  await caption(page, "The log is stored separately and appears in the incident log stream.", 1300);
}

async function importRuntimeLogs(page, logLine) {
  await caption(page, "Import external runtime log files directly into the selected incident.", 1200);
  await page.locator('input[name="logImportFile"]').setInputFiles({
    name: `runtime-${suffix}.log`,
    mimeType: "text/plain",
    buffer: Buffer.from(`${logLine}\n2026-05-02T10:00:02Z WARN imported follow-up ${keyword}`),
  });
  await pauseOperation(page);
  await page.getByRole("button", { name: "Import Logs" }).click();
  await page.getByText("Imported 2 logs into", { exact: false }).waitFor({ state: "visible", timeout: 15000 });
  await caption(page, "Imported logs become available to triage at runtime.", 1300);
}

async function createIncident(page) {
  await caption(page, "Create a new incident from the dashboard.", 1200);
  const panel = page.locator("section.create-panel").filter({
    has: page.getByRole("heading", { name: "Create Incident" }),
  });
  await panel.scrollIntoViewIfNeeded();
  await panel.getByLabel("Incident ID").fill(incidentId);
  await pauseOperation(page);
  await panel.getByLabel("Service").fill("incident-api");
  await pauseOperation(page);
  await panel.getByLabel("Title").fill(`Demo ${keyword} control-plane regression`);
  await pauseOperation(page);
  await panel.getByLabel("Environment").fill("prod");
  await panel.getByLabel("Region").fill("us-phoenix-1");
  await panel.getByLabel("Owner").fill("cloudops-oncall");
  await panel.getByLabel("Deployment Version").fill(`demo.${suffix}`);
  await pauseOperation(page);
  await panel.getByLabel("Signals").fill([
    `${keyword} work request retries exhausted`,
    `${keyword} API latency and 5xx spike`,
    "operator action denied during rollout",
  ].join("\n"));
  await pauseOperation(page);
  await panel.getByLabel("Initial Runtime Logs").fill([
    `ERROR ${keyword} request failed after rollout`,
    `WARN ${keyword} worker queue depth remains high`,
  ].join("\n"));
  await pauseOperation(page);
  await panel.getByRole("button", { name: "Add Incident" }).click();
  await page.getByText(`Incident ${incidentId} submitted.`).waitFor({ state: "visible", timeout: 15000 });
  await caption(page, `Created ${incidentId}; it is now selected for triage.`, 1400);
}

async function createRunbook(page) {
  await caption(page, "Create a matching runbook so triage can retrieve remediation steps.", 1300);
  const panel = page.locator("section.create-panel").filter({
    has: page.getByRole("heading", { name: "Create Runbook" }),
  });
  await panel.scrollIntoViewIfNeeded();
  await panel.getByLabel("Runbook ID").fill(runbookId);
  await pauseOperation(page);
  await panel.getByLabel("Service").fill("incident-api");
  await pauseOperation(page);
  await panel.getByLabel("Title").fill("Demo rollout remediation");
  await pauseOperation(page);
  await panel.getByLabel("Keywords").fill(`${keyword}\nwork request\noperator action denied`);
  await pauseOperation(page);
  await panel.getByLabel("Steps").fill([
    "Pause rollout and verify active work requests.",
    "Inspect imported runtime logs for the matching request id.",
    "Replay failed request in staging before resuming.",
    "Escalate to control-plane owner if denial persists.",
  ].join("\n"));
  await pauseOperation(page);
  await panel.getByRole("button", { name: "Add Runbook" }).click();
  await page.getByText(`Runbook ${runbookId} submitted.`).waitFor({ state: "visible", timeout: 15000 });
  await caption(page, "Runbook version history is visible after saving.", 1300);
}

async function runTriage(page) {
  await caption(page, "Run triage: the API fetches current logs, calls the LangGraph agent, and returns evidence-backed actions.", 1800);
  await page.getByRole("button", { name: new RegExp(incidentId) }).click();
  await pauseOperation(page);
  await page.getByRole("button", { name: "Run Triage" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Run Triage" }).click();
  await page.getByRole("status").filter({ hasText: "Running triage" }).waitFor({ state: "visible", timeout: 15000 });
  await caption(page, "The loader shows queued and running triage progress while the agent works.", 1800);
  await page.getByText("Evidence Used").waitFor({ state: "visible", timeout: 120000 });
  await caption(page, "The result includes root cause, recommended actions, runbook matches, source, confidence, and evidence.", 2200);
  await page.getByText("Evidence Used").scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  await caption(page, "Evidence cards show the log lines, signals, and runbook matches that influenced the output.", 1800);
}

async function submitFeedback(page) {
  await caption(page, "Submit operator feedback to improve future triage memory.", 1300);
  await page.getByPlaceholder("Optional note for future triage tuning").fill("Useful demo triage result with clear runbook match.");
  await pauseOperation(page);
  await page.getByRole("button", { name: "Useful" }).click();
  await page.getByText(`Triage feedback saved for ${incidentId}.`).waitFor({ state: "visible", timeout: 15000 });
  await caption(page, "Feedback is persisted and added to the incident timeline.", 1300);
}

async function exportReport(page) {
  await caption(page, "Export a markdown incident report for handoff or review.", 1300);
  await page.getByRole("button", { name: "Export Report" }).scrollIntoViewIfNeeded();
  const downloadPromise = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  await pauseOperation(page);
  await page.getByRole("button", { name: "Export Report" }).click();
  const download = await downloadPromise;
  if (download) {
    await download.saveAs(path.join(outputDir, `${incidentId}-report.md`));
  }
  await page.getByText(`Report exported for ${incidentId}.`).waitFor({ state: "visible", timeout: 15000 });
  await caption(page, "The report captures incident context, logs, triage output, feedback, and audit history.", 1400);
}

async function showTimeline(page) {
  await caption(page, "Use the unified timeline to audit incident, log, triage, report, and feedback events.", 1500);
  await page.getByRole("heading", { name: "Incident Timeline" }).scrollIntoViewIfNeeded();
  await page.getByText("Triage feedback: useful").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(1400);
}

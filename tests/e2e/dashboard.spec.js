import { expect, test } from "@playwright/test";

test("operator can create operational data and run fallback triage", async ({ page, request }) => {
  const suffix = Date.now().toString().slice(-6);
  const incidentId = `INC-E2E-${suffix}`;
  const runbookId = `RB-E2E-${suffix}`;
  const keyword = `e2e-keyword-${suffix}`;
  const apiUrl = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 18080}`;

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "CloudOps Copilot" })).toBeVisible();
  await expect(page.getByText("Incident Queue")).toBeVisible();
  await expect(page.getByLabel("Service health").getByText("Incident API")).toBeVisible();
  await expect(page.getByLabel("Service health").getByText("Database")).toBeVisible();
  await expect(page.getByLabel("Service health").getByText("Triage Agent")).toBeVisible();
  await expect(page.getByLabel("Service health").getByText("Fallback").first()).toBeVisible();

  const incidentPanel = page.locator("section.create-panel").filter({
    has: page.getByRole("heading", { name: "Create Incident" })
  });
  await incidentPanel.getByLabel("Incident ID").fill(incidentId);
  await incidentPanel.getByLabel("Service").fill("incident-api");
  await incidentPanel.getByLabel("Title").fill(`E2E ${keyword} rollout regression`);
  await incidentPanel.getByLabel("Signals").fill(`work request retries exhausted\n${keyword} error spike`);
  await incidentPanel.getByLabel("Initial Runtime Logs").fill(`ERROR ${keyword} request failed after rollout`);
  await incidentPanel.getByRole("button", { name: "Add Incident" }).click();

  await expect(page.getByText(`Incident ${incidentId} submitted.`)).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(incidentId) })).toBeVisible();
  await expect(page.locator("pre")).toContainText(keyword);

  const runbookPanel = page.locator("section.create-panel").filter({
    has: page.getByRole("heading", { name: "Create Runbook" })
  });
  await runbookPanel.getByLabel("Runbook ID").fill(runbookId);
  await runbookPanel.getByLabel("Service").fill("incident-api");
  await runbookPanel.getByLabel("Title").fill("E2E rollout remediation");
  await runbookPanel.getByLabel("Keywords").fill(keyword);
  await runbookPanel.getByLabel("Steps").fill("Pause rollout\nReplay failed request in staging");
  await runbookPanel.getByRole("button", { name: "Add Runbook" }).click();

  await expect(page.getByText(`Runbook ${runbookId} submitted.`)).toBeVisible();

  await page.getByPlaceholder("Append a generated service log line").fill(`WARN ${keyword} queue depth remains high`);
  await page.getByRole("button", { name: "Append Log" }).click();

  await expect(page.getByText(`Log submitted to ${incidentId}.`)).toBeVisible();
  await expect(page.locator("pre")).toContainText("queue depth remains high");

  await page.locator('input[name="logImportFile"]').setInputFiles({
    name: "runtime.log",
    mimeType: "text/plain",
    buffer: Buffer.from(`2026-05-02T10:00:00Z ERROR worker: imported ${keyword} file failure`)
  });
  await page.getByRole("button", { name: "Import Logs" }).click();

  await expect(page.getByText(`Imported 1 logs into ${incidentId}.`)).toBeVisible();
  await expect(page.locator("pre")).toContainText("file failure");

  await page.getByRole("button", { name: "Run Triage" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Running triage" })).toBeVisible();
  await expect(page.getByText("Source: incident-api-fallback")).toBeVisible();
  await expect(page.getByText(`${runbookId}: E2E rollout remediation`).first()).toBeVisible();
  await expect(page.getByText("Pause rollout")).toBeVisible();
  await expect(page.getByText("Evidence Used")).toBeVisible();
  await expect(page.getByText("Runbook Matches")).toBeVisible();

  await page.getByPlaceholder("Optional note for future triage tuning").fill("Useful E2E triage result");
  await page.getByRole("button", { name: "Useful" }).click();

  await expect(page.getByText(`Triage feedback saved for ${incidentId}.`)).toBeVisible();
  await expect(page.getByText("Saved feedback: useful.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Incident Timeline" })).toBeVisible();
  await expect(page.getByText("incident.logs_imported")).toBeVisible();
  await expect(page.getByText("Triage feedback: useful")).toBeVisible();

  const metricsResponse = await request.get(`${apiUrl}/metrics`);
  expect(metricsResponse.ok()).toBeTruthy();
  const metrics = await metricsResponse.text();
  expect(metrics).toContain('cloudops_triage_requests_total{source="incident-api-fallback"}');
  expect(metrics).toContain("cloudops_triage_fallback_total 1");
  expect(metrics).toContain('cloudops_triage_feedback_by_rating{rating="useful"} 1');
});

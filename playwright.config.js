import { defineConfig, devices } from "@playwright/test";

const apiPort = Number(process.env.E2E_API_PORT ?? 18080);
const dashboardPort = Number(process.env.E2E_DASHBOARD_PORT ?? 15173);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: dashboardUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command: `E2E_API_PORT=${apiPort} node scripts/e2e-api-server.mjs`,
      url: `${apiUrl}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000
    },
    {
      command: `VITE_API_URL=${apiUrl} yarn workspace @cloudops/dashboard dev --host 127.0.0.1 --port ${dashboardPort} --strictPort`,
      url: dashboardUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000
    }
  ],
  projects: [
    {
      name: browserChannel ? `chromium-${browserChannel}` : "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(browserChannel ? { channel: browserChannel } : {})
      }
    }
  ]
});

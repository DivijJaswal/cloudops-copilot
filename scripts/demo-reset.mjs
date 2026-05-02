import pg from "pg";
import { createIncidentStore } from "../services/incident-api/src/store.js";

const { Pool } = pg;
const confirmed = process.argv.includes("--yes");

if (!confirmed) {
  console.error("Refusing to reset demo data without --yes.");
  console.error("Run: yarn demo:reset");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://cloudops:cloudops@127.0.0.1:5432/cloudops_copilot"
});
const store = createIncidentStore({ pool, closePool: true });

try {
  await store.init();
  await pool.query(`
    TRUNCATE
      audit_events,
      triage_jobs,
      triage_feedback,
      incident_logs,
      incidents,
      runbook_versions,
      runbooks,
      app_users
    RESTART IDENTITY CASCADE
  `);
  await store.seed();
  await store.seedLocalUsers();
  await store.backfillRunbookVersions();

  const [summary, runbooks] = await Promise.all([
    store.summarize(),
    store.listRunbooks()
  ]);

  console.log("Local demo data has been reset.");
  console.log(`Incidents: ${summary.total}, open: ${summary.open}`);
  console.log(`Runbooks: ${runbooks.length}`);
  console.log("Default login: operator / cloudops");
} finally {
  await store.close();
}

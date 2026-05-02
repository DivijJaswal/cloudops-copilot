import { newDb } from "pg-mem";
import { createApp } from "../services/incident-api/src/app.js";
import { createIncidentStore } from "../services/incident-api/src/store.js";

const db = newDb();
const { Pool } = db.adapters.createPg();
const host = process.env.E2E_API_HOST ?? "127.0.0.1";
const port = Number(process.env.E2E_API_PORT ?? 18080);
const store = createIncidentStore({ pool: new Pool(), closePool: true });

await store.init();

const app = createApp({
  store,
  triageAgentUrl: "",
  triageDelayMs: 300
});

const server = app.listen(port, host, () => {
  console.log(`e2e incident-api listening on http://${host}:${port}`);
});

async function shutdown() {
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

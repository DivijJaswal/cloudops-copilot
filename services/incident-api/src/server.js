import { createApp } from "./app.js";
import { createIncidentStore } from "./store.js";

const port = Number(process.env.INCIDENT_API_PORT ?? 8080);
const host = process.env.INCIDENT_API_HOST ?? "127.0.0.1";
const store = createIncidentStore();

await store.init();

const app = createApp({ store });
const server = app.listen(port, host, () => {
  console.log(`incident-api listening on http://${host}:${port}`);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`incident-api received ${signal}; shutting down`);

  try {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await store.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

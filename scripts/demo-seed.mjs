import { createIncidentStore } from "../services/incident-api/src/store.js";

const store = createIncidentStore();

try {
  await store.init();
  const [summary, runbooks] = await Promise.all([
    store.summarize(),
    store.listRunbooks()
  ]);

  console.log("Local demo data is ready.");
  console.log(`Incidents: ${summary.total}, open: ${summary.open}`);
  console.log(`Runbooks: ${runbooks.length}`);
  console.log("Default login: operator / cloudops");
} finally {
  await store.close();
}

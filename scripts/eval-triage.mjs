import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fallbackTriage } from "../services/incident-api/src/triageClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const runbooks = readJson("data/runbooks.json");
const evalCases = readJson("data/eval_cases.json");

let passed = 0;
const results = [];

for (const evalCase of evalCases) {
  const candidateRunbooks = rankRunbooks(evalCase.incident, runbooks);
  const triage = fallbackTriage(evalCase.incident, candidateRunbooks, `eval-${evalCase.id}`);
  const actualRunbookIds = triage.runbooks.map((runbook) => runbook.id);
  const categoryOk = triage.category === evalCase.expectedCategory;
  const runbooksOk = evalCase.expectedRunbookIds.every((runbookId) => actualRunbookIds.includes(runbookId));
  const ok = categoryOk && runbooksOk;

  if (ok) passed += 1;
  results.push({
    id: evalCase.id,
    ok,
    expectedCategory: evalCase.expectedCategory,
    actualCategory: triage.category,
    expectedRunbooks: evalCase.expectedRunbookIds.join(","),
    actualRunbooks: actualRunbookIds.join(",") || "none"
  });
}

console.table(results);

const total = evalCases.length;
const score = total === 0 ? 0 : Math.round((passed / total) * 100);
console.log(`Triage eval score: ${passed}/${total} (${score}%)`);

if (passed !== total) {
  process.exitCode = 1;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function rankRunbooks(incident, availableRunbooks) {
  const text = [
    incident.service,
    incident.title,
    ...(incident.signals ?? []),
    ...(incident.logs ?? [])
  ].join(" ").toLowerCase();

  return availableRunbooks
    .map((runbook) => ({
      runbook,
      score: runbook.keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((candidate) => candidate.runbook);
}

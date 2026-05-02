import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const pythonCandidates = [
  process.env.PYTHON,
  path.join(repoRoot, ".venv", "bin", "python"),
  "python3",
  "python"
].filter(Boolean);

function resolvePython() {
  for (const candidate of pythonCandidates) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) {
      continue;
    }
    return candidate;
  }
  return null;
}

const python = resolvePython();
if (!python) {
  console.error("No Python interpreter found. Create .venv or install python3.");
  process.exit(1);
}

const result = spawnSync(
  python,
  ["-m", "unittest", "discover", "-s", "services/triage-agent/tests"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONPATH: "services/triage-agent",
      CLOUDOPS_REQUIRE_TRIAGE_DEPS: "true"
    }
  }
);

if (result.error) {
  console.error(`Unable to run Python tests with ${python}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

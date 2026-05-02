import { createHs256Jwt } from "../services/incident-api/src/auth.js";

const secret = process.env.JWT_SECRET;
const role = process.argv[2] ?? "operator";
const subject = process.argv[3] ?? "local-operator";

if (!secret) {
  console.error("Set JWT_SECRET before generating a demo token.");
  process.exit(1);
}

console.log(createHs256Jwt({ sub: subject, role }, secret));

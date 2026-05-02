import assert from "node:assert/strict";
import test from "node:test";
import { createHs256Jwt, rolesFromClaims, verifyHs256Jwt } from "../src/auth.js";

test("HS256 JWT helper signs and verifies operator claims", () => {
  const token = createHs256Jwt(
    { sub: "operator-1", roles: ["operator"] },
    "test-secret",
    { expiresInSeconds: 60 }
  );

  const claims = verifyHs256Jwt(token, "test-secret");

  assert.equal(claims.sub, "operator-1");
  assert.deepEqual([...rolesFromClaims(claims)], ["operator"]);
});

test("HS256 JWT helper rejects invalid signatures and expired tokens", () => {
  const token = createHs256Jwt(
    { sub: "operator-1", role: "operator" },
    "test-secret",
    { expiresInSeconds: 60 }
  );
  assert.throws(() => verifyHs256Jwt(token, "wrong-secret"), /Invalid bearer token signature/);

  const expired = createHs256Jwt(
    { sub: "operator-1", role: "operator", exp: 1 },
    "test-secret",
    { expiresInSeconds: 60 }
  );
  assert.throws(() => verifyHs256Jwt(expired, "test-secret"), /Bearer token expired/);
});

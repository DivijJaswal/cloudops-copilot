import crypto from "node:crypto";

const passwordHashPrefix = "scrypt";

function encodeBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeBase64UrlJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function sign(unsignedToken, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(unsignedToken)
    .digest("base64url");
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createHs256Jwt(claims, secret, options = {}) {
  if (!secret) {
    throw new Error("JWT secret is required");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64UrlJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeBase64UrlJson({
    iat: now,
    exp: now + (options.expiresInSeconds ?? 24 * 60 * 60),
    ...claims
  });
  const unsignedToken = `${header}.${payload}`;
  return `${unsignedToken}.${sign(unsignedToken, secret)}`;
}

export function verifyHs256Jwt(token, secret, options = {}) {
  if (!secret) {
    throw new Error("JWT secret is required");
  }

  const [headerPart, payloadPart, signaturePart] = String(token ?? "").split(".");
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new Error("Malformed bearer token");
  }

  const header = decodeBase64UrlJson(headerPart);
  if (header.alg !== "HS256") {
    throw new Error("Unsupported JWT algorithm");
  }

  const unsignedToken = `${headerPart}.${payloadPart}`;
  const expectedSignature = sign(unsignedToken, secret);
  if (!timingSafeEqual(signaturePart, expectedSignature)) {
    throw new Error("Invalid bearer token signature");
  }

  const payload = decodeBase64UrlJson(payloadPart);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp <= now) {
    throw new Error("Bearer token expired");
  }
  if (typeof payload.nbf === "number" && payload.nbf > now) {
    throw new Error("Bearer token is not active yet");
  }

  return payload;
}

export function rolesFromClaims(claims) {
  const roles = new Set();
  if (typeof claims.role === "string") {
    roles.add(claims.role.toLowerCase());
  }
  if (Array.isArray(claims.roles)) {
    for (const role of claims.roles) {
      if (typeof role === "string") {
        roles.add(role.toLowerCase());
      }
    }
  }
  if (typeof claims.scope === "string") {
    for (const scope of claims.scope.split(/\s+/)) {
      if (scope) {
        roles.add(scope.toLowerCase());
      }
    }
  }
  return roles;
}

export function authorizeBearerToken(authorizationHeader, secret, allowedRoles) {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "missing_bearer_token",
      message: "Write operations require an Authorization bearer token."
    };
  }

  try {
    const claims = verifyHs256Jwt(authorizationHeader.slice("Bearer ".length), secret);
    const roles = rolesFromClaims(claims);
    const allowed = [...allowedRoles].some((role) => roles.has(role));
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        error: "forbidden",
        message: "Bearer token does not include an operator or admin role."
      };
    }
    return { ok: true, claims, roles };
  } catch (error) {
    return {
      ok: false,
      status: 401,
      error: "invalid_bearer_token",
      message: error.message
    };
  }
}

export function createPasswordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  if (!password) {
    throw new Error("Password is required");
  }

  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${passwordHashPrefix}:${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  const [prefix, salt, expectedHash] = String(storedHash ?? "").split(":");
  if (prefix !== passwordHashPrefix || !salt || !expectedHash) {
    return false;
  }

  const actualHash = crypto.scryptSync(String(password ?? ""), salt, 64).toString("hex");
  return timingSafeEqual(actualHash, expectedHash);
}

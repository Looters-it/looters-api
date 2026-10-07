import { createHash, randomBytes } from "node:crypto";

/** A new session token: 256 random bits, safe to put in a cookie. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What is stored in place of the token. The token is high-entropy random
 * data, so a plain SHA-256 is enough: there is nothing to brute-force.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

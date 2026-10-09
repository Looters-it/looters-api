import type { FastifyRequest } from "fastify";
import { forbidden, unauthorized } from "../http/errors.js";
import type { AuthContext, SessionService } from "./sessions.js";

export interface AuthGuard {
  /** The caller's session, or null for an anonymous request. */
  optional(request: FastifyRequest): Promise<AuthContext | null>;
  /** The caller's session; 401 when there is none. */
  user(request: FastifyRequest): Promise<AuthContext>;
  /** The caller's session; 401 when there is none, 403 unless a platform admin. */
  admin(request: FastifyRequest): Promise<AuthContext>;
}

export function createAuthGuard(sessions: SessionService, cookieName: string): AuthGuard {
  const optional = async (request: FastifyRequest) => {
    const auth = await sessions.resolve(request.cookies[cookieName]);
    // For the request log: who made the call.
    request.userId = auth?.user.id ?? null;
    // The cookie expires with the session: when one moves, so must the other.
    if (auth?.renewed) request.sessionRenewedUntil = auth.expiresAt;
    return auth;
  };
  const user = async (request: FastifyRequest) => {
    const auth = await optional(request);
    if (!auth) throw unauthorized();
    return auth;
  };
  const admin = async (request: FastifyRequest) => {
    const auth = await user(request);
    if (auth.user.role !== "ADMIN") throw forbidden();
    return auth;
  };
  return { optional, user, admin };
}

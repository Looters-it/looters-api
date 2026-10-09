import { randomUUID } from "node:crypto";
import { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { RateLimiter } from "../auth/rate-limit.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth guard once the session is known, for the request log. */
    userId: string | null;
    /** Set by the auth guard when the session was renewed: the new expiry of its cookie. */
    sessionRenewedUntil: Date | null;
  }
}

/**
 * What the server options need for the logs: one id per request, generated
 * here and never taken from the client, and no automatic request lines, since
 * `registerRequestLogging` writes its own.
 */
export const loggingServerOptions = () =>
  ({
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
  }) satisfies Partial<FastifyServerOptions>;

/** Never written to the logs, whatever ends up in a logged object. */
export const REDACTED_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  "*.password",
  "*.token",
];

const clientErrorBody = z.object({
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  /** Where in the interface: the path of the page, without query string. */
  path: z.string().max(500).optional(),
  kind: z.enum(["render", "error", "rejection"]).optional(),
});

/**
 * Structured logs (one JSON line per event, with a stable `event` field to
 * search and alert on):
 *
 * - `request`: every request once it is answered, with the route pattern
 *   (not the raw URL, so lines group), status, duration, user and match;
 * - `unhandled_error`: a failure nobody foresaw, with its stack; the answer
 *   carries the same request id, so a report from a player leads to the line;
 * - `client_error`: an error reported by the web interface.
 */
export function registerRequestLogging(app: FastifyInstance): void {
  app.decorateRequest("userId", null);
  app.decorateRequest("sessionRenewedUntil", null);

  app.addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", request.id);
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    const route = request.routeOptions.url ?? "unmatched";
    // The liveness probe runs every few seconds and says nothing.
    if (route === "/api/health" && reply.statusCode < 400) {
      done();
      return;
    }
    const params = request.params as { id?: string } | undefined;
    const line = {
      event: "request",
      method: request.method,
      route,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      userId: request.userId,
      matchId: route.startsWith("/api/matches/:id") ? (params?.id ?? null) : null,
    };
    if (reply.statusCode >= 500) request.log.error(line);
    else request.log.info(line);
    done();
  });

  // Errors of the web interface, so that they are seen without asking players for a
  // screenshot. Anyone can call it, so it is limited by address and only ever logged.
  const limiter = new RateLimiter({ max: 20, windowMs: 60_000 });
  app.post("/api/client-errors", (request, reply) => {
    if (limiter.retryAfterSeconds(request.ip) > 0) return reply.code(204).send();
    limiter.hit(request.ip);
    const body = clientErrorBody.safeParse(request.body);
    if (body.success) request.log.warn({ event: "client_error", ...body.data });
    return reply.code(204).send();
  });
}

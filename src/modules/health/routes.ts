import type { FastifyInstance } from "fastify";

export interface HealthDeps {
  /** Resolves when the database answers. */
  pingDatabase: () => Promise<void>;
  /** Time of the last reply received from the `jobs` service, if any. */
  lastJobsPongAt: () => Date | null;
  /** Whether the producer of the battle queue is connected to Kafka. */
  battleQueueConnected: () => boolean;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  // Liveness: the process is up.
  app.get("/api/health", { logLevel: "warn" }, () => ({ status: "ok" }));

  // Readiness: the database answers. Also reports whether `jobs` has replied
  // and whether the battle queue is connected, without failing on them.
  app.get("/api/health/ready", async (_request, reply) => {
    let database = true;
    try {
      await deps.pingDatabase();
    } catch {
      database = false;
    }
    const pongAt = deps.lastJobsPongAt();
    return reply.code(database ? 200 : 503).send({
      status: database ? "ok" : "unavailable",
      database,
      jobs: { lastPongAt: pongAt ? pongAt.toISOString() : null },
      battleQueue: deps.battleQueueConnected(),
    });
  });
}

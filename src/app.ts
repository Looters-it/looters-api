import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerHealthRoutes, type HealthDeps } from "./modules/health/routes.js";

export interface AppDeps {
  health: HealthDeps;
  logger?: FastifyServerOptions["logger"];
}

/** Builds the HTTP application without starting it, so tests can inject requests. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } }),
  );

  registerHealthRoutes(app, deps.health);
  return app;
}

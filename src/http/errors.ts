import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

/** An error with the shape every client receives: `{ error: { code, message } }`. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const unauthorized = () => new AppError(401, "UNAUTHENTICATED", "Authentication required");
export const forbidden = () => new AppError(403, "FORBIDDEN", "Not allowed");
export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } }),
  );

  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.status)
        .headers(error.headers)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      const fields = [...new Set(error.issues.map((issue) => issue.path.join(".")))];
      return reply.code(400).send({
        error: { code: "VALIDATION", message: error.issues[0]?.message ?? "Invalid input", fields },
      });
    }
    // Malformed JSON, unsupported media type, payload too large…
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: "BAD_REQUEST", message: error.message } });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal error" } });
  });
}

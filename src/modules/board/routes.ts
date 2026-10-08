import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthGuard } from "../../auth/guard.js";
import { boardQuery, messageBody, type BoardService } from "./service.js";

const matchParams = z.object({ id: z.string().min(1) });
const eventParams = matchParams.extend({ eventId: z.string().min(1) });

export function registerBoardRoutes(
  app: FastifyInstance,
  board: BoardService,
  guard: AuthGuard,
): void {
  app.get("/api/matches/:id/board", async (request) =>
    board.list(
      matchParams.parse(request.params).id,
      boardQuery.parse(request.query),
      await guard.optional(request),
    ),
  );

  app.post("/api/matches/:id/board", async (request, reply) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return reply.code(201).send(await board.post(id, messageBody.parse(request.body), auth));
  });

  app.delete("/api/matches/:id/board/:eventId", async (request, reply) => {
    const auth = await guard.user(request);
    const { id, eventId } = eventParams.parse(request.params);
    await board.remove(id, eventId, auth);
    return reply.code(204).send();
  });
}

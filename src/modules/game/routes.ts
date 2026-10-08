import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthGuard } from "../../auth/guard.js";
import { allocateBody, allocationRuleBody, annexBody, type GameService } from "./service.js";

const matchParams = z.object({ id: z.string().min(1) });
const unitParams = matchParams.extend({ geoUnitId: z.coerce.number().int().positive() });

export function registerGameRoutes(
  app: FastifyInstance,
  game: GameService,
  guard: AuthGuard,
): void {
  app.get("/api/matches/:id/units/:geoUnitId", async (request) => {
    const { id, geoUnitId } = unitParams.parse(request.params);
    return game.unit(id, geoUnitId, await guard.optional(request));
  });

  app.post("/api/matches/:id/annex", async (request) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return game.annex(id, annexBody.parse(request.body), auth);
  });

  app.post("/api/matches/:id/allocate", async (request) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return game.allocate(id, allocateBody.parse(request.body), auth);
  });

  app.put("/api/matches/:id/allocation-rule", async (request) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return game.setAllocationRule(id, allocationRuleBody.parse(request.body), auth);
  });
}

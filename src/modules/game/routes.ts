import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthGuard } from "../../auth/guard.js";
import { attackBody, attackPreviewBody, respondBody, type BattleService } from "./battles.js";
import {
  allocateBody,
  allocationRuleBody,
  annexBody,
  capitalBody,
  type GameService,
} from "./service.js";

const matchParams = z.object({ id: z.string().min(1) });
const unitParams = matchParams.extend({ geoUnitId: z.coerce.number().int().positive() });

const battleParams = matchParams.extend({ battleId: z.string().min(1) });

export function registerGameRoutes(
  app: FastifyInstance,
  game: GameService,
  battles: BattleService,
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

  app.post("/api/matches/:id/capital", async (request) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return game.moveCapital(id, capitalBody.parse(request.body), auth);
  });

  app.post("/api/matches/:id/attacks/preview", async (request) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return battles.preview(id, attackPreviewBody.parse(request.body), auth);
  });

  app.post("/api/matches/:id/attacks", async (request, reply) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return reply.code(201).send(await battles.declare(id, attackBody.parse(request.body), auth));
  });

  app.post("/api/matches/:id/battles/:battleId/respond", async (request) => {
    const auth = await guard.user(request);
    const { id, battleId } = battleParams.parse(request.params);
    return battles.respond(id, battleId, respondBody.parse(request.body), auth);
  });
}

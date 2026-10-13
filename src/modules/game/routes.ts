import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthGuard } from "../../auth/guard.js";
import {
  buildBody,
  mergeBody,
  mergePreviewBody,
  moveStructureBody,
  renameBody,
  upgradeBody,
  type StructureService,
} from "./structures.js";
import { chatBody, inviteBody, transferBody, type AllianceService } from "./alliances.js";
import {
  attackBody,
  attackPreviewBody,
  respondBody,
  supportBody,
  type BattleService,
} from "./battles.js";
import {
  allocateBody,
  allocationRuleBody,
  annexBody,
  capitalBody,
  type GameService,
} from "./service.js";

const matchParams = z.object({ id: z.string().min(1) });
const allianceParams = matchParams.extend({ allianceId: z.string().min(1) });
const unitParams = matchParams.extend({ geoUnitId: z.coerce.number().int().positive() });

const battleParams = matchParams.extend({ battleId: z.string().min(1) });

const inviteParams = matchParams.extend({ inviteId: z.string().min(1) });
const structureParams = matchParams.extend({ structureId: z.string().min(1) });
const territoryParams = matchParams.extend({ territoryId: z.string().min(1) });

export function registerGameRoutes(
  app: FastifyInstance,
  game: GameService,
  battles: BattleService,
  structures: StructureService,
  alliances: AllianceService,
  guard: AuthGuard,
): void {
  app.get("/api/matches/:id/fronts", async (request) =>
    game.fronts(matchParams.parse(request.params).id, await guard.optional(request)),
  );

  app.get("/api/matches/:id/outline", async (request) =>
    game.outline(matchParams.parse(request.params).id, await guard.optional(request)),
  );
  app.get("/api/matches/:id/shapes", async (request) =>
    game.shapes(matchParams.parse(request.params).id, await guard.optional(request)),
  );

  app.get("/api/matches/:id/targets", async (request) =>
    game.targets(matchParams.parse(request.params).id, await guard.optional(request)),
  );

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

  app.post("/api/matches/:id/battles/:battleId/withdraw", async (request) => {
    const auth = await guard.user(request);
    const { id, battleId } = battleParams.parse(request.params);
    return battles.withdraw(id, battleId, auth);
  });

  app.post("/api/matches/:id/battles/:battleId/support", async (request) => {
    const auth = await guard.user(request);
    const { id, battleId } = battleParams.parse(request.params);
    return battles.support(id, battleId, supportBody.parse(request.body), auth);
  });

  // ---------- Structures and merged areas ----------

  app.get("/api/matches/:id/structures/catalogue", async (request) => {
    const auth = await guard.user(request);
    return structures.catalogue(matchParams.parse(request.params).id, auth);
  });
  app.post("/api/matches/:id/structures", async (request, reply) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return reply.code(201).send(await structures.build(id, buildBody.parse(request.body), auth));
  });
  app.post("/api/matches/:id/structures/:structureId/move", async (request) => {
    const auth = await guard.user(request);
    const { id, structureId } = structureParams.parse(request.params);
    return structures.move(id, structureId, moveStructureBody.parse(request.body), auth);
  });
  app.post("/api/matches/:id/structures/:structureId/upgrade", async (request) => {
    const auth = await guard.user(request);
    const { id, structureId } = structureParams.parse(request.params);
    return structures.upgrade(id, structureId, upgradeBody.parse(request.body), auth);
  });

  app.get("/api/matches/:id/areas", async (request) =>
    structures.areas(matchParams.parse(request.params).id, await guard.optional(request)),
  );
  app.post("/api/matches/:id/merge/preview", async (request) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return structures.previewMerge(id, mergePreviewBody.parse(request.body), auth);
  });
  app.post("/api/matches/:id/merge", async (request, reply) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return reply.code(201).send(await structures.merge(id, mergeBody.parse(request.body), auth));
  });
  app.patch("/api/matches/:id/territories/:territoryId", async (request) => {
    const auth = await guard.user(request);
    const { id, territoryId } = territoryParams.parse(request.params);
    return structures.rename(id, territoryId, renameBody.parse(request.body), auth);
  });

  // ---------- Alliances ----------

  app.post("/api/matches/:id/alliances/invites", async (request, reply) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return reply.code(201).send(await alliances.invite(id, inviteBody.parse(request.body), auth));
  });
  for (const action of ["accept", "decline", "withdraw"] as const) {
    app.post(`/api/matches/:id/alliances/invites/:inviteId/${action}`, async (request) => {
      const auth = await guard.user(request);
      const { id, inviteId } = inviteParams.parse(request.params);
      return alliances.answer(id, inviteId, action, auth);
    });
  }
  for (const action of ["end", "keep"] as const) {
    app.post(`/api/matches/:id/alliances/:allianceId/${action}`, async (request) => {
      const auth = await guard.user(request);
      const { id, allianceId } = allianceParams.parse(request.params);
      return alliances[action](id, allianceId, auth);
    });
  }
  app.post("/api/matches/:id/alliances/transfer", async (request) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return alliances.transfer(id, transferBody.parse(request.body), auth);
  });
  app.get("/api/matches/:id/alliances/:allianceId/chat", async (request) => {
    const auth = await guard.user(request);
    const { id, allianceId } = allianceParams.parse(request.params);
    return alliances.chat(id, allianceId, auth);
  });
  app.post("/api/matches/:id/alliances/:allianceId/chat", async (request, reply) => {
    const auth = await guard.user(request);
    const { id, allianceId } = allianceParams.parse(request.params);
    return reply
      .code(201)
      .send(await alliances.say(id, allianceId, chatBody.parse(request.body), auth));
  });
}

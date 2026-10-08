import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { AuthGuard } from "../../auth/guard.js";
import { notFound } from "../../http/errors.js";
import { EMPIRE_COLORS, EMPIRE_EMBLEMS, MAX_PLAYERS_LIMIT } from "../../rules/catalogue.js";
import { DEFAULT_MATCH_RULES } from "../../rules/config.js";
import type { TileCache } from "../geo/tile-cache.js";
import {
  generateTile,
  insideGrid,
  LABEL_MIN_ZOOM,
  sendTile,
  tileCoordinates,
  TILE_MAX_ZOOM,
  TILE_MIN_ZOOM,
} from "../geo/tiles.js";
import {
  createMatchBody,
  empireBody,
  joinBody,
  listMatchesQuery,
  matchParams,
  updateMatchBody,
} from "./schemas.js";
import { MatchService } from "./service.js";
import { z } from "zod";

export interface MatchRoutesDeps {
  prisma: PrismaClient;
  guard: AuthGuard;
  tileCache: TileCache;
  service?: MatchService;
}

const tileParams = tileCoordinates
  .extend({ id: z.string().min(1) })
  .refine(insideGrid, "Tile outside the grid");

/** Municipalities that belong to a match, as a condition on the GeoUnit alias `u`. */
const inMatch = (matchId: string) =>
  Prisma.sql`u.id IN (SELECT "geoUnitId" FROM "TerritoryUnit" WHERE "matchId" = ${matchId})`;

export function registerMatchRoutes(app: FastifyInstance, deps: MatchRoutesDeps): void {
  const { prisma, guard, tileCache } = deps;
  const matches = deps.service ?? new MatchService(prisma);

  /** What the creation and join forms need: defaults, limits and the empire catalogue. */
  app.get("/api/matches/options", () => ({
    rules: DEFAULT_MATCH_RULES,
    maxPlayersLimit: MAX_PLAYERS_LIMIT,
    colors: EMPIRE_COLORS,
    emblems: EMPIRE_EMBLEMS,
  }));

  app.get("/api/matches", async (request) =>
    matches.list(listMatchesQuery.parse(request.query), await guard.optional(request)),
  );
  app.get("/api/matches/mine", async (request) => matches.mine(await guard.user(request)));

  app.post("/api/matches", async (request, reply) => {
    const auth = await guard.user(request);
    return reply.code(201).send(await matches.create(createMatchBody.parse(request.body), auth));
  });

  app.get("/api/matches/:id", async (request) =>
    matches.get(matchParams.parse(request.params).id, await guard.optional(request)),
  );
  app.patch("/api/matches/:id", async (request) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return matches.update(id, updateMatchBody.parse(request.body), auth);
  });
  app.delete("/api/matches/:id", async (request, reply) => {
    const auth = await guard.user(request);
    await matches.remove(matchParams.parse(request.params).id, auth);
    return reply.code(204).send();
  });
  app.post("/api/matches/:id/open", async (request) =>
    matches.open(matchParams.parse(request.params).id, await guard.user(request)),
  );

  app.get("/api/matches/:id/state", async (request) =>
    matches.state(matchParams.parse(request.params).id, await guard.optional(request)),
  );
  app.post("/api/matches/:id/join", async (request, reply) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return reply.code(201).send(await matches.join(id, joinBody.parse(request.body), auth));
  });
  app.patch("/api/matches/:id/empire", async (request) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return matches.updateEmpire(id, empireBody.parse(request.body), auth);
  });

  // ---------- Map of the match ----------
  // The municipalities of a match are fixed when registrations open, so its
  // tiles never change: the count is enough as a version.

  const unitCount = async (matchId: string) => prisma.territoryUnit.count({ where: { matchId } });

  app.get("/api/matches/:id/map", async (request) => {
    const { id } = matchParams.parse(request.params);
    const match = await matches.get(id, await guard.optional(request));
    const rows = await prisma.$queryRaw<{ count: number; bounds: number[] | null }[]>`
      SELECT count(*)::int AS count,
        CASE WHEN count(*) = 0 THEN NULL ELSE ARRAY[
          ST_XMin(ST_Extent(u.geom)), ST_YMin(ST_Extent(u.geom)),
          ST_XMax(ST_Extent(u.geom)), ST_YMax(ST_Extent(u.geom))] END AS bounds
      FROM "GeoUnit" u WHERE ${inMatch(id)}`;
    const count = rows[0]?.count ?? 0;
    return {
      id,
      name: match.name,
      unitCount: count,
      bounds: rows[0]?.bounds ?? null,
      version: String(count),
      tiles: `/api/matches/${id}/tiles/{z}/{x}/{y}.mvt?v=${count}`,
      minZoom: TILE_MIN_ZOOM,
      maxZoom: TILE_MAX_ZOOM,
      labelMinZoom: LABEL_MIN_ZOOM,
    };
  });

  /** Every municipality of the match with a point inside it. */
  app.get("/api/matches/:id/units", async (request) => {
    const { id } = matchParams.parse(request.params);
    await matches.get(id, await guard.optional(request));
    return prisma.$queryRaw<{ id: number; name: string; lon: number; lat: number }[]>`
      SELECT u.id, u.name, round(u."centroidLon"::numeric, 5)::float8 AS lon,
        round(u."centroidLat"::numeric, 5)::float8 AS lat
      FROM "GeoUnit" u WHERE ${inMatch(id)} ORDER BY u.id`;
  });

  app.get("/api/matches/:id/tiles/:z/:x/:y.mvt", async (request, reply) => {
    const { id, z: zoom, x, y } = tileParams.parse(request.params);
    const requested = (request.query as { v?: string }).v;
    const key = (version: string) => `match:${id}:${version}:${zoom}/${x}/${y}`;

    const known = requested ? tileCache.get(key(requested)) : undefined;
    if (known) return sendTile(reply, known, true);

    const count = await unitCount(id);
    // Geometry is public; a match with no territories is a draft or does not exist.
    if (count === 0) throw notFound("Match");
    const version = String(count);
    let tile = tileCache.get(key(version));
    if (!tile) {
      tile = await generateTile(prisma, inMatch(id), { zoom, x, y });
      tileCache.set(key(version), tile);
    }
    return sendTile(reply, tile, requested === version);
  });
}

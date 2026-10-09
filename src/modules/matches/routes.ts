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
  invitationBody,
  invitationParams,
  listMatchesQuery,
  matchParams,
  updateMatchBody,
} from "./schemas.js";
import { LOGO_MAX_BYTES, LOGO_MIME_TYPES, readLogo } from "./logo.js";
import { PREVIEW_TTL_MS, matchPreview, type MatchPreview } from "./preview.js";
import { MatchService } from "./service.js";
import { z } from "zod";

export interface MatchRoutesDeps {
  prisma: PrismaClient;
  guard: AuthGuard;
  tileCache: TileCache;
  service?: MatchService;
}

const empireParams = matchParams.extend({ empireId: z.string().min(1) });

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

  // ---------- Invitations to a private match ----------
  app.get("/api/matches/:id/invitations", async (request) =>
    matches.invitations(matchParams.parse(request.params).id, await guard.user(request)),
  );
  app.post("/api/matches/:id/invitations", async (request, reply) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    const { username } = invitationBody.parse(request.body);
    return reply.code(201).send(await matches.invite(id, username, auth));
  });
  app.delete("/api/matches/:id/invitations/:invitationId", async (request) => {
    const auth = await guard.user(request);
    const { id, invitationId } = invitationParams.parse(request.params);
    return matches.uninvite(id, invitationId, auth);
  });
  // The invitations of the viewer, to any match.
  app.get("/api/invitations", async (request) => matches.myInvitations(await guard.user(request)));
  app.delete("/api/invitations/:id", async (request, reply) => {
    await matches.declineInvitation(
      matchParams.parse(request.params).id,
      await guard.user(request),
    );
    return reply.code(204).send();
  });

  app.get("/api/matches/:id/state", async (request) =>
    matches.state(matchParams.parse(request.params).id, await guard.optional(request)),
  );
  app.post("/api/matches/:id/join", async (request, reply) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return reply.code(201).send(await matches.join(id, joinBody.parse(request.body), auth));
  });
  // ---------- Logo of an empire ----------
  // Sent as the bare image, not as a form: decided by its bytes, capped in size.
  app.addContentTypeParser(
    LOGO_MIME_TYPES,
    { parseAs: "buffer", bodyLimit: LOGO_MAX_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.put("/api/matches/:id/empire/logo", async (request) => {
    const auth = await guard.user(request);
    const { id } = matchParams.parse(request.params);
    return matches.setLogo(id, readLogo(request.body), auth);
  });
  app.delete("/api/matches/:id/empires/:empireId/logo", async (request) => {
    const auth = await guard.user(request);
    const { id, empireId } = empireParams.parse(request.params);
    return matches.removeLogo(id, empireId, auth);
  });
  app.get("/api/matches/:id/empires/:empireId/logo", async (request, reply) => {
    const { id, empireId } = empireParams.parse(request.params);
    const logo = await matches.logo(id, empireId, await guard.optional(request));
    const versioned = (request.query as { v?: string }).v !== undefined;
    return (
      reply
        .header("content-type", logo.mime)
        // Never interpreted as anything but the image its bytes say it is.
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'")
        .header("cache-control", versioned ? "public, max-age=31536000, immutable" : "no-cache")
        .send(Buffer.from(logo.data))
    );
  });

  app.delete("/api/matches/:id/empire", async (request) => {
    const auth = await guard.user(request);
    return matches.withdraw(matchParams.parse(request.params).id, auth);
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

  /**
   * A small picture of the match for its card on the homepage: the municipalities
   * reduced to a grid of cells, each free or of the colour of the empire that holds
   * most of it. Public like the map itself, and kept for a while: a card need not be
   * up to the second.
   */
  const previews = new Map<string, { at: number; body: Promise<MatchPreview> }>();
  app.get("/api/matches/:id/preview", async (request, reply) => {
    const { id } = matchParams.parse(request.params);
    const match = await matches.get(id, await guard.optional(request));
    const kept = previews.get(id);
    const fresh = kept && Date.now() - kept.at < PREVIEW_TTL_MS;
    const body = fresh ? kept.body : matchPreview(prisma, id);
    if (!fresh) {
      if (previews.size > 500) previews.clear();
      previews.set(id, { at: Date.now(), body });
      body.catch(() => previews.delete(id));
    }
    // What is not for everyone is not for a shared cache either.
    const audience = match.visibility === "PUBLIC" ? "public" : "private";
    return reply.header("cache-control", `${audience}, max-age=30`).send(await body);
  });

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
  app.get("/api/matches/:id/units", async (request, reply) => {
    const { id } = matchParams.parse(request.params);
    await matches.get(id, await guard.optional(request));
    // The same few thousand rows for every player of the match: read and serialised
    // once, kept with the tiles and under the same version (the number of municipalities).
    const version = String(await unitCount(id));
    const body = await tileCache.load(`match-units:${id}:${version}`, async () =>
      Buffer.from(
        JSON.stringify(
          await prisma.$queryRaw<{ id: number; name: string; lon: number; lat: number }[]>`
            SELECT u.id, u.name, round(u."centroidLon"::numeric, 5)::float8 AS lon,
              round(u."centroidLat"::numeric, 5)::float8 AS lat
            FROM "GeoUnit" u WHERE ${inMatch(id)} ORDER BY u.id`,
        ),
      ),
    );
    return reply.header("content-type", "application/json; charset=utf-8").send(body);
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
    const tile = await tileCache.load(key(version), () =>
      generateTile(prisma, inMatch(id), { zoom, x, y }),
    );
    return sendTile(reply, tile, requested === version);
  });
}

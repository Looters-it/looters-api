import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../../http/errors.js";
import type { TileCache } from "./tile-cache.js";
import {
  generateTile,
  insideGrid,
  LABEL_MIN_ZOOM,
  sendTile,
  tileCoordinates,
  TILE_MAX_ZOOM,
  TILE_MIN_ZOOM,
} from "./tiles.js";

export interface GeoPublicDeps {
  prisma: PrismaClient;
  tileCache: TileCache;
}

/** How long a computed data version is trusted before it is read again. */
const VERSION_TTL_MS = 2000;

const areaParams = z.object({ id: z.string().min(1) });
const tileParams = tileCoordinates
  .extend({ id: z.string().min(1) })
  .refine(insideGrid, "Tile outside the grid");

/** Ids of a folder and of everything below it. */
const subtree = (id: string) => Prisma.sql`
  WITH RECURSIVE tree AS (
    SELECT id FROM "GeoArea" WHERE id = ${id}
    UNION ALL
    SELECT child.id FROM "GeoArea" child JOIN tree ON child."parentId" = tree.id
  ) SELECT id FROM tree`;

/**
 * Read-only geography for the map. Boundaries are public data and the
 * homepage shows them to guests, so these routes need no session.
 * Nothing here knows about matches: ownership is applied by the client
 * as feature state on top of these tiles.
 */
export function registerGeoPublicRoutes(app: FastifyInstance, deps: GeoPublicDeps): void {
  const { prisma } = deps;
  const cache = deps.tileCache;

  /**
   * Changes whenever the municipalities under a folder change. It is part of
   * the tile URL, so tiles can be cached forever by browsers and proxies.
   */
  const versions = new Map<string, { value: string | null; at: number }>();
  const dataVersion = async (areaId: string): Promise<string | null> => {
    const known = versions.get(areaId);
    if (known && Date.now() - known.at < VERSION_TTL_MS) return known.value;
    return freshDataVersion(areaId);
  };
  /** Always reads the database: for the calls that hand the version to the client. */
  const freshDataVersion = async (areaId: string): Promise<string | null> => {
    const value = await readDataVersion(areaId);
    versions.set(areaId, { value, at: Date.now() });
    return value;
  };
  const readDataVersion = async (areaId: string): Promise<string | null> => {
    const rows = await prisma.$queryRaw<{ exists: boolean; count: number; last: number | null }[]>`
      SELECT EXISTS (SELECT 1 FROM "GeoArea" WHERE id = ${areaId}) AS "exists",
        count(u.id)::int AS count, max(u.id) AS last
      FROM "GeoUnit" u WHERE u."areaId" IN (${subtree(areaId)})`;
    const row = rows[0];
    if (!row?.exists) return null;
    return `${row.count}-${row.last ?? 0}`;
  };

  /** Geographic areas that have municipalities, largest first. */
  app.get("/api/geo/areas", async () => {
    const rows = await prisma.$queryRaw<{ id: string; name: string; unitCount: number }[]>`
      WITH RECURSIVE tree AS (
        SELECT id AS root, id FROM "GeoArea" WHERE "parentId" IS NULL
        UNION ALL
        SELECT tree.root, child.id FROM "GeoArea" child JOIN tree ON child."parentId" = tree.id
      )
      SELECT root.id, root.name, count(u.id)::int AS "unitCount"
      FROM tree JOIN "GeoArea" root ON root.id = tree.root
      JOIN "GeoUnit" u ON u."areaId" = tree.id
      GROUP BY root.id, root.name
      ORDER BY count(u.id) DESC, root.name`;
    return rows;
  });

  /** The whole folder tree with the municipalities under each node, to choose where a match is played. */
  app.get("/api/geo/tree", async () => {
    const rows = await prisma.$queryRaw<
      { id: string; name: string; parentId: string | null; unitCount: number }[]
    >`
      WITH RECURSIVE tree AS (
        SELECT id AS top, id FROM "GeoArea"
        UNION ALL
        SELECT tree.top, child.id FROM "GeoArea" child JOIN tree ON child."parentId" = tree.id
      )
      SELECT a.id, a.name, a."parentId", count(u.id)::int AS "unitCount"
      FROM "GeoArea" a JOIN tree ON tree.top = a.id
      LEFT JOIN "GeoUnit" u ON u."areaId" = tree.id
      GROUP BY a.id, a.name, a."parentId"
      ORDER BY a.name`;
    return rows;
  });

  /** What the map needs to show a folder: extent and tile address. */
  app.get("/api/geo/areas/:id/map", async (request) => {
    const { id } = areaParams.parse(request.params);
    const version = await freshDataVersion(id);
    if (version === null) throw notFound("Folder");
    const rows = await prisma.$queryRaw<{ name: string; count: number; bounds: number[] | null }[]>`
      SELECT (SELECT name FROM "GeoArea" WHERE id = ${id}) AS name, count(*)::int AS count,
        CASE WHEN count(*) = 0 THEN NULL ELSE ARRAY[
          ST_XMin(ST_Extent(geom)), ST_YMin(ST_Extent(geom)),
          ST_XMax(ST_Extent(geom)), ST_YMax(ST_Extent(geom))] END AS bounds
      FROM "GeoUnit" WHERE "areaId" IN (${subtree(id)})`;
    const row = rows[0];
    return {
      id,
      name: row?.name ?? "",
      unitCount: row?.count ?? 0,
      /** [west, south, east, north] in degrees; null while the folder is empty. */
      bounds: row?.bounds ?? null,
      version,
      tiles: `/api/geo/areas/${id}/tiles/{z}/{x}/{y}.mvt?v=${version}`,
      minZoom: TILE_MIN_ZOOM,
      maxZoom: TILE_MAX_ZOOM,
      labelMinZoom: LABEL_MIN_ZOOM,
    };
  });

  /** Every municipality of a folder with a point inside it: for search, centring and labels. */
  app.get("/api/geo/areas/:id/units", async (request, reply) => {
    const { id } = areaParams.parse(request.params);
    const version = await freshDataVersion(id);
    if (version === null) throw notFound("Folder");
    const units = await prisma.$queryRaw<{ id: number; name: string; lon: number; lat: number }[]>`
      SELECT id, name, round("centroidLon"::numeric, 5)::float8 AS lon,
        round("centroidLat"::numeric, 5)::float8 AS lat
      FROM "GeoUnit" WHERE "areaId" IN (${subtree(id)}) ORDER BY id`;
    return reply.header("etag", `"${version}"`).header("cache-control", "no-cache").send(units);
  });

  /**
   * Mapbox Vector Tile with two layers: `units` (polygons; the feature id is
   * the GeoUnit id, `name` its name) and, from LABEL_MIN_ZOOM, `labels`
   * (one point per municipality, inside it).
   */
  app.get("/api/geo/areas/:id/tiles/:z/:x/:y.mvt", async (request, reply) => {
    const { id, z: zoom, x, y } = tileParams.parse(request.params);
    const requested = (request.query as { v?: string }).v;
    const send = (body: Buffer, immutable: boolean) => sendTile(reply, body, immutable);

    // A tile cached under the version the client names was generated from
    // exactly that data: it is served without touching the database.
    const coordinates = `${zoom}/${x}/${y}`;
    const known = requested ? cache.get(`${id}:${requested}:${coordinates}`) : undefined;
    if (known) return send(known, true);

    const version = await dataVersion(id);
    if (version === null) throw notFound("Folder");

    const key = `${id}:${version}:${coordinates}`;
    const tile = await cache.load(key, () =>
      generateTile(prisma, Prisma.sql`u."areaId" IN (${subtree(id)})`, { zoom, x, y }),
    );

    // Immutable only when the URL names the version that was served.
    return send(tile, requested === version);
  });
}

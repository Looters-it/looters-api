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

/** Parts of an outline smaller than this are left out, in square degrees (about two km²). */
const OUTLINE_MIN_PART = 0.0002;
/** How far a simplified outline may stray from the border, in degrees (about 400 m). */
const OUTLINE_TOLERANCE = 0.004;

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

  /**
   * Draws again the outline of every area whose municipalities have changed since it
   * was drawn. Joining thousands of borders takes seconds, so the outline is kept on
   * the folder; whoever asks while it is being drawn waits for the same work.
   */
  let drawing: Promise<void> | null = null;
  const drawOutlines = (): Promise<void> => {
    drawing ??= (async () => {
      const stale = await prisma.$queryRaw<{ id: string; made: string }[]>`
        SELECT area.id, own.made
        FROM "GeoArea" area JOIN (
          SELECT "areaId", count(*) || '-' || max(id) || '-' || sum(id) AS made
          FROM "GeoUnit" GROUP BY "areaId"
        ) own ON own."areaId" = area.id
        WHERE area."outlineOf" IS DISTINCT FROM own.made`;
      for (const { id, made } of stale) {
        // Small islands are left out, unless the area is nothing else; the rest is
        // simplified to what can be told apart with a whole region in view.
        await prisma.$executeRaw`
          WITH parts AS (
            SELECT (ST_Dump(ST_Union("geomSimple"))).geom AS part
            FROM "GeoUnit" WHERE "areaId" = ${id}
          ), kept AS (
            SELECT part FROM parts
            WHERE ST_Area(part) > ${OUTLINE_MIN_PART}::float8
              OR part = (SELECT part FROM parts ORDER BY ST_Area(part) DESC LIMIT 1)
          )
          UPDATE "GeoArea" SET "outlineOf" = ${made}, outline = (
            SELECT ST_AsGeoJSON(
              ST_SimplifyPreserveTopology(ST_Collect(part), ${OUTLINE_TOLERANCE}::float8), 4)
            FROM kept)
          WHERE id = ${id}`;
      }
    })().finally(() => {
      drawing = null;
    });
    return drawing;
  };

  /**
   * The atlas: every area a match can be played on, on one map. An area is a
   * folder that holds municipalities of its own; each comes with its outline, its
   * extent, a point to name it at and the areas it touches, so that neighbours can
   * be told apart by colour. The municipalities themselves are not sent.
   */
  let atlas: { of: string; body: unknown } | null = null;
  app.get("/api/geo/atlas", async () => {
    await drawOutlines();
    // The answer is put together once for each state of folders and municipalities.
    const state = await prisma.$queryRaw<{ of: string }[]>`
      SELECT md5(coalesce(string_agg(
        id || ':' || name || ':' || coalesce("parentId", '') || ':' || coalesce("outlineOf", ''),
        '|' ORDER BY id), '')) AS of
      FROM "GeoArea"`;
    const of = state[0]?.of ?? "";
    if (atlas?.of === of) return atlas.body;
    const rows = await prisma.$queryRaw<
      {
        id: string;
        name: string;
        rootId: string;
        rootName: string;
        unitCount: number;
        lon: number;
        lat: number;
        bounds: number[];
        borders: string[];
        outline: string | null;
      }[]
    >`
      WITH RECURSIVE up AS (
        SELECT id AS leaf, id, "parentId", name FROM "GeoArea"
        UNION ALL
        SELECT up.leaf, parent.id, parent."parentId", parent.name
        FROM "GeoArea" parent JOIN up ON up."parentId" = parent.id
      ), root AS (
        SELECT leaf, id, name FROM up WHERE "parentId" IS NULL
      ), touching AS (
        SELECT DISTINCT a."areaId" AS one, b."areaId" AS other
        FROM "GeoAdjacency" adjacency
        JOIN "GeoUnit" a ON a.id = adjacency."aId"
        JOIN "GeoUnit" b ON b.id = adjacency."bId"
        WHERE a."areaId" <> b."areaId"
      )
      SELECT area.id, area.name, root.id AS "rootId", root.name AS "rootName",
        count(u.id)::int AS "unitCount",
        round(((ST_XMin(ST_Extent(u.geom)) + ST_XMax(ST_Extent(u.geom))) / 2)::numeric, 5)::float8 AS lon,
        round(((ST_YMin(ST_Extent(u.geom)) + ST_YMax(ST_Extent(u.geom))) / 2)::numeric, 5)::float8 AS lat,
        ARRAY[ST_XMin(ST_Extent(u.geom)), ST_YMin(ST_Extent(u.geom)),
          ST_XMax(ST_Extent(u.geom)), ST_YMax(ST_Extent(u.geom))] AS bounds,
        ARRAY(
          SELECT other FROM touching WHERE one = area.id
          UNION SELECT one FROM touching WHERE other = area.id
          ORDER BY 1
        ) AS borders,
        area.outline
      FROM "GeoArea" area
      JOIN root ON root.leaf = area.id
      JOIN "GeoUnit" u ON u."areaId" = area.id
      GROUP BY area.id, area.name, root.id, root.name, area.outline
      ORDER BY root.name, area.name`;
    const areas = rows.flatMap((row) =>
      row.outline ? [{ ...row, outline: JSON.parse(row.outline) as unknown }] : [],
    );
    const all = areas.map((area) => area.bounds);
    const body = {
      unitCount: areas.reduce((sum, area) => sum + area.unitCount, 0),
      /** [west, south, east, north] of everything; null while there is nothing. */
      bounds:
        all.length === 0
          ? null
          : [
              Math.min(...all.map((box) => box[0] ?? 0)),
              Math.min(...all.map((box) => box[1] ?? 0)),
              Math.max(...all.map((box) => box[2] ?? 0)),
              Math.max(...all.map((box) => box[3] ?? 0)),
            ],
      areas,
    };
    atlas = { of, body };
    return body;
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

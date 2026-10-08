import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyReply } from "fastify";
import { z } from "zod";

/** Zoom range of the tiles; the map overzooms beyond the last level. */
export const TILE_MIN_ZOOM = 4;
export const TILE_MAX_ZOOM = 12;
/** Municipality names are in the tiles from this zoom on. */
export const LABEL_MIN_ZOOM = 9;
/** From this zoom the full geometry is used instead of the simplified one. */
const FULL_DETAIL_ZOOM = 11;
/** Below this zoom borders are simplified to about one screen pixel before being encoded. */
const PIXEL_SIMPLIFY_BELOW_ZOOM = 9;
/** Width of the world in Web Mercator metres. */
const WORLD_METRES = 40_075_016.68;

export const tileCoordinates = z.object({
  z: z.coerce.number().int().min(TILE_MIN_ZOOM).max(TILE_MAX_ZOOM),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
});
export const insideGrid = (tile: { z: number; x: number; y: number }) =>
  tile.x < 2 ** tile.z && tile.y < 2 ** tile.z;

/**
 * Builds a Mapbox Vector Tile with two layers: `units` (polygons; the feature
 * id is the GeoUnit id, `name` its name) and, from LABEL_MIN_ZOOM, `labels`
 * (one point inside each municipality). `where` selects the municipalities,
 * as a condition on the GeoUnit alias `u`.
 */
export async function generateTile(
  prisma: PrismaClient,
  where: Prisma.Sql,
  tile: { zoom: number; x: number; y: number },
): Promise<Buffer> {
  const { zoom, x, y } = tile;
  const geometry = zoom >= FULL_DETAIL_ZOOM ? Prisma.sql`u.geom` : Prisma.sql`u."geomSimple"`;
  // One pixel of a 512-pixel tile, in metres: finer detail cannot be seen.
  const pixel = WORLD_METRES / (2 ** zoom * 512);
  const projected =
    zoom < PIXEL_SIMPLIFY_BELOW_ZOOM
      ? Prisma.sql`ST_Simplify(ST_Transform(found.geom, 3857), ${pixel}::float8, true)`
      : Prisma.sql`ST_Transform(found.geom, 3857)`;

  const rows = await prisma.$queryRaw<{ tile: Buffer }[]>`
    WITH tile AS (
      SELECT ST_TileEnvelope(${zoom}::int, ${x}::int, ${y}::int) AS envelope,
        -- Slightly larger than the tile, so borders cut by its edge are not lost.
        ST_Transform(ST_TileEnvelope(${zoom}::int, ${x}::int, ${y}::int, margin => 0.02), 4326) AS reach
    ), found AS (
      SELECT u.id, u.name, u."centroidLon" AS lon, u."centroidLat" AS lat, u."areaKm2",
        ${geometry} AS geom
      FROM "GeoUnit" u, tile
      WHERE (${where}) AND u.geom && tile.reach
    ), units AS (
      SELECT found.id, found.name,
        ST_AsMVTGeom(${projected}, tile.envelope, 4096, 64, true) AS shape
      FROM found, tile
    ), labels AS (
      SELECT found.id, found.name, round(found."areaKm2")::int AS area,
        ST_AsMVTGeom(ST_Transform(ST_SetSRID(ST_MakePoint(found.lon, found.lat), 4326), 3857),
          tile.envelope, 4096, 0, true) AS point
      FROM found, tile WHERE ${zoom >= LABEL_MIN_ZOOM}::boolean
    )
    SELECT (SELECT coalesce(ST_AsMVT(units, 'units', 4096, 'shape', 'id'), ''::bytea) FROM units WHERE shape IS NOT NULL)
        || (SELECT coalesce(ST_AsMVT(labels, 'labels', 4096, 'point', 'id'), ''::bytea) FROM labels WHERE point IS NOT NULL)
      AS tile`;
  return Buffer.from(rows[0]?.tile ?? []);
}

/** Sends a tile. `immutable` lets browsers and proxies keep it for a year. */
export function sendTile(reply: FastifyReply, tile: Buffer, immutable: boolean) {
  return reply
    .header("content-type", "application/vnd.mapbox-vector-tile")
    .header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
    .send(tile);
}

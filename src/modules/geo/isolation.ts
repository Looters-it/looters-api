import type { PrismaClient } from "@prisma/client";

/** How close another country must lie to count as touching, in degrees (about 200 m). */
const TOUCH = 0.002;
/** How far from the coastline a municipality still counts as on the sea, in degrees (about 2 km). */
const COAST_REACH = 0.02;
/** An exclave has at least this share of its border on another country. */
const EXCLAVE_SHARE = 0.25;

/**
 * Says of every municipality without a border in its own country why that is: an
 * island, or an exclave lying in another country. A border added by hand does not
 * count: an island joined by a bridge is still an island.
 *
 * An exclave is told by how much of its border runs along municipalities of another
 * geographic area (root folder): Campione d'Italia in Switzerland, Llívia in France.
 * An island just off a foreign coast has almost none, and stays an island. What it
 * finds therefore depends on the countries that are loaded: it is asked again whenever
 * municipalities are added. It takes the best part of a minute with a hundred thousand.
 */
export async function classifyIsolated(prisma: PrismaClient): Promise<number> {
  const changed = await prisma.$executeRaw`
    WITH RECURSIVE up AS (
      SELECT id AS leaf, id, "parentId" FROM "GeoArea"
      UNION ALL
      SELECT up.leaf, parent.id, parent."parentId"
      FROM "GeoArea" parent JOIN up ON up."parentId" = parent.id
    ), root AS (
      SELECT leaf, id FROM up WHERE "parentId" IS NULL
    ), alone AS (
      SELECT u.id, u.geom, root.id AS root
      FROM "GeoUnit" u JOIN root ON root.leaf = u."areaId"
      WHERE NOT EXISTS (
        SELECT 1 FROM "GeoAdjacency" g
        WHERE (g."aId" = u.id OR g."bId" = u.id) AND NOT g.manual)
    ), abroad AS (
      SELECT alone.id, ST_Union(other.geom) AS land
      FROM alone
      JOIN "GeoUnit" other ON other.geom && ST_Expand(alone.geom, ${TOUCH}::float8 * 2)
        AND ST_DWithin(other.geom, alone.geom, ${TOUCH}::float8)
      JOIN root there ON there.leaf = other."areaId"
      WHERE there.id <> alone.root
      GROUP BY alone.id
    ), kind AS (
      SELECT alone.id, CASE WHEN coalesce(
          ST_Length(ST_Intersection(ST_Boundary(alone.geom), ST_Buffer(abroad.land, ${TOUCH}::float8)))
            / nullif(ST_Length(ST_Boundary(alone.geom)), 0), 0) >= ${EXCLAVE_SHARE}::float8
        THEN 'EXCLAVE'::"GeoIsolation" ELSE 'ISLAND'::"GeoIsolation" END AS isolation
      FROM alone LEFT JOIN abroad ON abroad.id = alone.id
    )
    UPDATE "GeoUnit" u SET isolation = kind.isolation
    FROM "GeoUnit" all_units LEFT JOIN kind ON kind.id = all_units.id
    WHERE u.id = all_units.id AND u.isolation IS DISTINCT FROM kind.isolation`;
  // On the sea: every island, and the land the coast runs along or close by (the
  // coastline is rougher than the borders, hence the reach). Without a coastline
  // loaded (`pnpm areas:coast`) only the islands are.
  const onSea = await prisma.$executeRaw`
    UPDATE "GeoUnit" u SET coastal = shore.coastal
    FROM (
      SELECT unit.id, (unit.isolation = 'ISLAND' OR EXISTS (
        SELECT 1 FROM "GeoCoast" coast
        WHERE coast.geom && ST_Expand(unit.geom, ${COAST_REACH}::float8)
          AND ST_DWithin(coast.geom, unit.geom, ${COAST_REACH}::float8))) IS TRUE AS coastal
      FROM "GeoUnit" unit
    ) shore
    WHERE u.id = shore.id AND u.coastal <> shore.coastal`;
  return changed + onSea;
}

let running: Promise<void> | null = null;
let again = false;

/**
 * Classifies without making anyone wait: when the api starts and when an upload is
 * seen done. One at a time; asked while one runs, another follows it.
 */
export function classifyInBackground(
  prisma: PrismaClient,
  onError: (error: unknown) => void,
): void {
  if (running) {
    again = true;
    return;
  }
  running = classifyIsolated(prisma)
    .then(() => undefined, onError)
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        classifyInBackground(prisma, onError);
      }
    });
}

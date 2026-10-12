/**
 * Loads the coastline of the world (Natural Earth, 1:10,000,000, public domain) into
 * the database, in short pieces, and says again which municipalities are on the sea.
 * Run once; again only to replace the coastline.
 *
 *   pnpm areas:coast
 */
import { PrismaClient } from "@prisma/client";
import { classifyIsolated } from "../src/modules/geo/isolation.js";

const COASTLINE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson";
/** Points in a piece: short pieces keep the index of the coast worth having. */
const PIECE = 64;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

const response = await fetch(COASTLINE);
if (!response.ok) throw new Error(`${String(response.status)} from the coastline`);
const collection = (await response.json()) as {
  features: { geometry: { type: string; coordinates: unknown } }[];
};
const lines = collection.features.flatMap((feature) =>
  feature.geometry.type === "MultiLineString"
    ? (feature.geometry.coordinates as number[][][])
    : [feature.geometry.coordinates as number[][]],
);
const pieces: string[] = [];
for (const line of lines) {
  // Each piece begins on the point the one before ends on: the coast has no gaps.
  for (let start = 0; start < line.length - 1; start += PIECE - 1) {
    const points = line.slice(start, start + PIECE);
    if (points.length < 2) continue;
    pieces.push(`LINESTRING(${points.map(([x, y]) => `${String(x)} ${String(y)}`).join(",")})`);
  }
}
await prisma.$transaction(
  async (tx) => {
    await tx.$executeRaw`TRUNCATE "GeoCoast"`;
    for (let start = 0; start < pieces.length; start += 500) {
      const batch = pieces.slice(start, start + 500);
      await tx.$executeRaw`
        INSERT INTO "GeoCoast" (geom)
        SELECT ST_GeomFromText(wkt, 4326) FROM unnest(${batch}::text[]) AS wkt`;
    }
  },
  { timeout: 300_000 },
);
console.log(`${String(pieces.length)} pieces of coast`);
await classifyIsolated(prisma);
const found = await prisma.$queryRaw<{ coastal: number; all: number }[]>`
  SELECT count(*) FILTER (WHERE coastal)::int AS coastal, count(*)::int AS "all" FROM "GeoUnit"`;
console.log(
  `${String(found[0]?.coastal ?? 0)} of ${String(found[0]?.all ?? 0)} municipalities on the sea`,
);
await prisma.$disconnect();

/**
 * Splits an area that holds every Italian municipality into its twenty regions: one
 * folder for each region under the area, with the municipalities moved into it. The
 * area itself stays playable as a whole (a match on a folder takes everything under
 * it), and each region becomes playable on its own.
 *
 * The region of a municipality is read from its ISTAT code, whose first three digits
 * are the province. It can be run again: folders that exist are reused, and only the
 * municipalities still directly in the area are moved. Nothing a match holds changes:
 * matches point at municipalities, not at folders.
 *
 *   pnpm regions            # the area called "Italia"
 *   pnpm regions "Italy"    # another name
 */
import { PrismaClient } from "@prisma/client";

/** Provinces by ISTAT code, old and new (Sardinia was renumbered in 2025: 112–119). */
const REGIONS: Record<string, number[]> = {
  Piemonte: [1, 2, 3, 4, 5, 6, 96, 103],
  "Valle d'Aosta": [7],
  Lombardia: [12, 13, 14, 15, 16, 17, 18, 19, 20, 97, 98, 108],
  "Trentino-Alto Adige": [21, 22],
  Veneto: [23, 24, 25, 26, 27, 28, 29],
  "Friuli-Venezia Giulia": [30, 31, 32, 93],
  Liguria: [8, 9, 10, 11],
  "Emilia-Romagna": [33, 34, 35, 36, 37, 38, 39, 40, 99],
  Toscana: [45, 46, 47, 48, 49, 50, 51, 52, 53, 100],
  Umbria: [54, 55],
  Marche: [41, 42, 43, 44, 109],
  Lazio: [56, 57, 58, 59, 60],
  Abruzzo: [66, 67, 68, 69],
  Molise: [70, 94],
  Campania: [61, 62, 63, 64, 65],
  Puglia: [71, 72, 73, 74, 75, 110],
  Basilicata: [76, 77],
  Calabria: [78, 79, 80, 101, 102],
  Sicilia: [81, 82, 83, 84, 85, 86, 87, 88, 89],
  Sardegna: [90, 91, 92, 95, 104, 105, 106, 107, 111, 112, 113, 114, 115, 116, 117, 118, 119],
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const rootName = process.argv[2] ?? "Italia";

const root = await prisma.geoArea.findFirst({
  where: { parentId: null, name: { equals: rootName, mode: "insensitive" } },
});
if (!root) throw new Error(`no area called "${rootName}"`);

const moved = await prisma.$transaction(
  async (tx) => {
    const counts: Record<string, number> = {};
    for (const [name, provinces] of Object.entries(REGIONS)) {
      const folder =
        (await tx.geoArea.findFirst({ where: { parentId: root.id, name } })) ??
        (await tx.geoArea.create({ data: { name, parentId: root.id } }));
      const prefixes = provinces.map((code) => String(code).padStart(3, "0"));
      counts[name] = await tx.$executeRaw`
        UPDATE "GeoUnit" SET "areaId" = ${folder.id}
        WHERE "areaId" = ${root.id} AND length(code) = 6 AND left(code, 3) = ANY(${prefixes})`;
    }
    return counts;
  },
  { timeout: 120_000 },
);

const totals = await prisma.$queryRaw<{ name: string; units: number }[]>`
  SELECT a.name, count(u.id)::int AS units FROM "GeoArea" a
  LEFT JOIN "GeoUnit" u ON u."areaId" = a.id
  WHERE a."parentId" = ${root.id} GROUP BY a.name ORDER BY a.name`;
console.table(totals.map((row) => ({ ...row, "moved now": moved[row.name] ?? 0 })));
const left = await prisma.geoUnit.count({ where: { areaId: root.id } });
console.log(
  left === 0
    ? `every municipality of "${root.name}" is in a region`
    : `${String(left)} municipalities stay directly in "${root.name}": their code names no known province`,
);
await prisma.$disconnect();

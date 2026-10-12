/**
 * Splits an area into its regions from a file: one folder for each region under the
 * area, with the municipalities moved into it by their official code. The file is
 * `{"Region": ["code", …], …}`, as `pnpm areas:fetch` writes it next to each country.
 *
 * The area itself stays playable as a whole, and each region becomes playable on its
 * own. It can be run again: folders that exist are reused, and only the municipalities
 * still directly in the area are moved. Nothing a match holds changes.
 *
 *   pnpm areas:split "France" geodata/france.regions.json
 */
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const [rootName, file] = process.argv.slice(2);
if (!rootName || !file) throw new Error('usage: pnpm areas:split "<area>" <regions.json>');
const regions = JSON.parse(await readFile(file, "utf8")) as Record<string, string[]>;
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

const root = await prisma.geoArea.findFirst({
  where: { parentId: null, name: { equals: rootName, mode: "insensitive" } },
});
if (!root) throw new Error(`no area called "${rootName}"`);

const moved = await prisma.$transaction(
  async (tx) => {
    const counts: Record<string, number> = {};
    for (const [name, codes] of Object.entries(regions)) {
      const folder =
        (await tx.geoArea.findFirst({ where: { parentId: root.id, name } })) ??
        (await tx.geoArea.create({ data: { name, parentId: root.id } }));
      counts[name] = await tx.$executeRaw`
        UPDATE "GeoUnit" SET "areaId" = ${folder.id}
        WHERE "areaId" = ${root.id} AND code = ANY(${codes})`;
    }
    return counts;
  },
  { timeout: 300_000 },
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
    : `${String(left)} municipalities stay directly in "${root.name}": the file names no region for them`,
);
await prisma.$disconnect();

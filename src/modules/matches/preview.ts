import type { PrismaClient } from "@prisma/client";

/** How long a preview is served before it is drawn again. */
export const PREVIEW_TTL_MS = 30_000;
/** Cells across, at most; the height follows the shape of the area. */
const MAX_COLUMNS = 64;
const MAX_ROWS = 80;

export interface MatchPreview {
  columns: number;
  rows: number;
  /** Cells with free municipalities only: x, y, x, y… */
  free: number[];
  /** Cells held by an empire, by its colour: x, y, x, y… */
  owned: Record<string, number[]>;
}

/**
 * Reduces a match to a grid: every municipality falls in the cell of its
 * centre, and a cell takes the colour of the empire with most municipalities
 * in it. Only what is public is used: who owns what, and the colours.
 */
export async function matchPreview(prisma: PrismaClient, matchId: string): Promise<MatchPreview> {
  const units = await prisma.$queryRaw<{ lon: number; lat: number; color: string | null }[]>`
    SELECT u."centroidLon" AS lon, u."centroidLat" AS lat, e.color
    FROM "TerritoryUnit" tu
    JOIN "GeoUnit" u ON u.id = tu."geoUnitId"
    JOIN "Territory" t ON t.id = tu."territoryId"
    LEFT JOIN "Empire" e ON e.id = t."ownerEmpireId"
    WHERE tu."matchId" = ${matchId}`;
  if (units.length === 0) return { columns: 1, rows: 1, free: [], owned: {} };

  const west = Math.min(...units.map((u) => u.lon));
  const east = Math.max(...units.map((u) => u.lon));
  const south = Math.min(...units.map((u) => u.lat));
  const north = Math.max(...units.map((u) => u.lat));
  // A degree of longitude is shorter than one of latitude, by the cosine of the latitude.
  const squeeze = Math.cos((((south + north) / 2) * Math.PI) / 180);
  const width = Math.max((east - west) * squeeze, 1e-6);
  const height = Math.max(north - south, 1e-6);
  // About one cell for each municipality, so that a small area is a shape and not a
  // scattering of dots; a large one stops at the size of the picture.
  const columns = Math.max(
    6,
    Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt((units.length * width) / height) * 0.85)),
  );
  const rows = Math.max(1, Math.min(MAX_ROWS, Math.round((columns * height) / width)));

  const cells = new Map<number, Map<string, number>>();
  for (const unit of units) {
    const x = Math.min(columns - 1, Math.floor(((unit.lon - west) / (east - west || 1)) * columns));
    const y = Math.min(rows - 1, Math.floor(((north - unit.lat) / height) * rows));
    const cell = cells.get(y * columns + x) ?? new Map<string, number>();
    cell.set(unit.color ?? "", (cell.get(unit.color ?? "") ?? 0) + 1);
    cells.set(y * columns + x, cell);
  }
  const preview: MatchPreview = { columns, rows, free: [], owned: {} };
  for (const [index, counts] of cells) {
    // An empire shows even where free municipalities are more: it is what one looks for.
    const owners = [...counts].filter(([color]) => color !== "").sort((a, b) => b[1] - a[1]);
    const color = owners[0]?.[0];
    const target = color ? (preview.owned[color] ??= []) : preview.free;
    target.push(index % columns, Math.floor(index / columns));
  }
  return preview;
}

import { Prisma, type PrismaClient } from "@prisma/client";

/** How long the empires of a preview are served before they are drawn again. */
export const PREVIEW_TTL_MS = 30_000;
/** The picture is this many units across: borders are simplified to about one of them. */
const DETAIL = 300;

export interface MatchPreview {
  /** `min-x min-y width height`, for the SVG that draws the paths. */
  viewBox: string;
  /** The outline of the whole area of the match, as an SVG path. */
  outline: string;
  /** What each empire holds, as an SVG path in its colour. */
  empires: { color: string; path: string }[];
}

interface Frame {
  viewBox: string;
  outline: string;
  squeeze: number;
  tolerance: number;
}

/** The municipalities of a match, as a condition on the GeoUnit alias `u`. */
const inMatch = (matchId: string) =>
  Prisma.sql`u.id IN (SELECT "geoUnitId" FROM "TerritoryUnit" WHERE "matchId" = ${matchId})`;

/**
 * The outline of a match: its municipalities merged into one shape, with the
 * real borders simplified to the size of a card. It never changes once the
 * match is open (the municipalities are fixed then) and merging thousands of
 * polygons takes a second or two, so it is drawn once and kept.
 */
const frames = new Map<string, Promise<Frame>>();

function frameOf(prisma: PrismaClient, matchId: string): Promise<Frame> {
  const kept = frames.get(matchId);
  if (kept) return kept;
  const frame = (async () => {
    const boxes = await prisma.$queryRaw<
      { west: number | null; east: number; south: number; north: number }[]
    >`SELECT ST_XMin(e) AS west, ST_XMax(e) AS east, ST_YMin(e) AS south, ST_YMax(e) AS north
      FROM (SELECT ST_Extent(u."geomSimple") AS e FROM "GeoUnit" u WHERE ${inMatch(matchId)}) box`;
    const box = boxes[0];
    if (box?.west == null) return { viewBox: "0 0 1 1", outline: "", squeeze: 1, tolerance: 0 };
    // A degree of longitude is shorter than one of latitude, by the cosine of the latitude.
    const squeeze = Math.cos((((box.south + box.north) / 2) * Math.PI) / 180);
    const width = (box.east - box.west) * squeeze;
    const height = box.north - box.south;
    const tolerance = Math.max(width, height) / DETAIL;
    const rows = await prisma.$queryRaw<{ path: string | null }[]>`
      SELECT ST_AsSVG(ST_Simplify(ST_Scale(ST_Union(u."geomSimple"), ${squeeze}, 1), ${tolerance}), 0, 4) AS path
      FROM "GeoUnit" u WHERE ${inMatch(matchId)}`;
    return {
      // ST_AsSVG flips the latitude, so that north is up.
      viewBox: [box.west * squeeze, -box.north, width, height].map((n) => n.toFixed(4)).join(" "),
      outline: rows[0]?.path ?? "",
      squeeze,
      tolerance,
    };
  })();
  if (frames.size > 500) frames.clear();
  frames.set(matchId, frame);
  frame.catch(() => frames.delete(matchId));
  return frame;
}

/**
 * A small map of a match for its card: the real outline of its area and,
 * inside it, what every empire holds, each with its real borders. Only what
 * is public is used: who owns what, and the colours.
 */
export async function matchPreview(prisma: PrismaClient, matchId: string): Promise<MatchPreview> {
  const frame = await frameOf(prisma, matchId);
  if (frame.outline === "") return { viewBox: frame.viewBox, outline: "", empires: [] };
  const empires = await prisma.$queryRaw<{ color: string; path: string | null }[]>`
    SELECT e.color,
      ST_AsSVG(ST_Simplify(ST_Scale(ST_Union(u."geomSimple"), ${frame.squeeze}, 1), ${frame.tolerance / 2}), 0, 4) AS path
    FROM "Territory" t
    JOIN "Empire" e ON e.id = t."ownerEmpireId"
    JOIN "TerritoryUnit" tu ON tu."territoryId" = t.id
    JOIN "GeoUnit" u ON u.id = tu."geoUnitId"
    WHERE t."matchId" = ${matchId}
    GROUP BY e.id, e.color
    ORDER BY e."joinedAt"`;
  return {
    viewBox: frame.viewBox,
    outline: frame.outline,
    empires: empires.flatMap((empire) =>
      empire.path ? [{ color: empire.color, path: empire.path }] : [],
    ),
  };
}

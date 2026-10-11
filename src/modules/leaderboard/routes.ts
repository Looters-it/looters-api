import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthGuard } from "../../auth/guard.js";

const SORTS = {
  rank: Prisma.sql`rank`,
  username: Prisma.sql`lower(username)`,
  matches: Prisma.sql`matches`,
  elo: Prisma.sql`elo`,
  turns: Prisma.sql`turns`,
} as const;

export const leaderboardQuery = z.object({
  // Part of the name of a player.
  search: z.string().trim().max(60).optional(),
  // Only who has played at least this many matches.
  minMatches: z.coerce.number().int().min(1).max(100_000).default(1),
  sort: z.enum(["rank", "username", "matches", "elo", "turns"]).default("rank"),
  order: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface LeaderboardRow {
  /** The place in the whole ranking, whatever is searched: level players share it. */
  rank: number;
  username: string;
  matches: number;
  elo: number;
  turns: number;
}

/**
 * The global ranking: for who is signed in. Every player who has finished at least one
 * match, with what the matches left them (see `award` in the jobs).
 */
export function registerLeaderboardRoutes(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; guard: AuthGuard },
): void {
  app.get("/api/leaderboard", async (request) => {
    await deps.guard.user(request);
    const query = leaderboardQuery.parse(request.query);
    // The name is searched as written: what LIKE reads as a wildcard is not one here.
    const like = `%${(query.search ?? "").replace(/[\\%_]/g, "\\$&")}%`;
    const direction = query.order === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const rows = await deps.prisma.$queryRaw<(LeaderboardRow & { total: number })[]>`
      WITH ranked AS (
        SELECT u.username, u.elo, u."ratedMatches" AS matches, u."ratedTurns" AS turns,
          rank() OVER (ORDER BY u.elo DESC)::int AS rank
        FROM "User" u WHERE NOT u."isBot" AND u."ratedMatches" > 0
      )
      SELECT rank, username, matches, elo, turns, count(*) OVER ()::int AS total
      FROM ranked
      WHERE username ILIKE ${like} AND matches >= ${query.minMatches}
      ORDER BY ${SORTS[query.sort]} ${direction}, rank, lower(username)
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
    let total = rows[0]?.total ?? 0;
    // A page past the end has no row to say how many there are.
    if (rows.length === 0 && query.page > 1) {
      const counted = await deps.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM "User" u
        WHERE NOT u."isBot" AND u."ratedMatches" >= ${query.minMatches} AND u.username ILIKE ${like}`;
      total = counted[0]?.total ?? 0;
    }
    return {
      players: rows.map(({ total: _, ...row }) => row),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

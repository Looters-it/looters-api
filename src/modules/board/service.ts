import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AuthContext } from "../../auth/sessions.js";
import { recordEvent } from "../../events/events.js";
import { AppError, forbidden, notFound } from "../../http/errors.js";
import { rulesOf, type MatchService } from "../matches/service.js";

/**
 * What appears on the board, by kind. The board is the public face of the
 * event log: every announcement is a typed domain event, and the web
 * interface writes its text from the event's type and data. Events that are
 * not listed here (a turn closing, a battle being declared) stay off it.
 */
export const BOARD_KINDS = {
  messages: ["MESSAGE"],
  empires: ["EMPIRE_CREATED", "EMPIRE_WITHDRAWN", "EMPIRE_FALLEN"],
  annexations: ["ANNEXED"],
  battles: ["BATTLE_RESOLVED"],
  capitals: ["CAPITAL_BUILT", "CAPITAL_MOVED", "CAPITAL_PROMOTED"],
  areas: ["AREA_CREATED", "AREA_RENAMED"],
  // ALLIANCE_JOINED and ALLIANCE_LEFT are what matches played before pacts recorded.
  alliances: [
    "ALLIANCE_FORMED",
    "ALLIANCE_ENDING",
    "ALLIANCE_KEPT",
    "ALLIANCE_ENDED",
    "ALLIANCE_JOINED",
    "ALLIANCE_LEFT",
  ],
  match: ["MATCH_STARTED", "MATCH_FINISHED"],
} as const;

export type BoardKind = keyof typeof BOARD_KINDS;
const ALL_TYPES: string[] = Object.values(BOARD_KINDS).flat();

export const boardQuery = z.object({
  kind: z.enum(Object.keys(BOARD_KINDS) as [BoardKind, ...BoardKind[]]).optional(),
  /** Only what concerns this empire: its messages and the events it took part in. */
  empireId: z.string().min(1).optional(),
  /** Older than this event: for loading further back. */
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

/** What the history of a turn lists: every announcement, not the players' messages. */
const HISTORY_TYPES = ALL_TYPES.filter((type) => type !== "MESSAGE");

interface EventRow {
  id: string;
  type: string;
  turn: number;
  createdAt: Date;
  empireId: string | null;
  territoryId: string | null;
  geoUnitId: number | null;
  data: Prisma.JsonValue;
}

export const messageBody = z.strictObject({ text: z.string().trim().min(1).max(5000) });

export class BoardService {
  onChange: (matchId: string, kind: string) => void = () => undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly matches: MatchService,
  ) {}

  /** The board of a match, newest first. Anyone who can see the match can read it. */
  async list(matchId: string, query: z.infer<typeof boardQuery>, viewer: AuthContext | null) {
    await this.matches.get(matchId, viewer);
    const types = query.kind ? [...BOARD_KINDS[query.kind]] : ALL_TYPES;

    let before: Date | undefined;
    if (query.before) {
      const anchor = await this.prisma.gameEvent.findFirst({
        where: { id: query.before, matchId },
        select: { createdAt: true },
      });
      before = anchor?.createdAt;
    }
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        type: string;
        turn: number;
        createdAt: Date;
        empireId: string | null;
        territoryId: string | null;
        geoUnitId: number | null;
        data: Prisma.JsonValue;
      }[]
    >`
      SELECT e.id, e.type, e.turn, e."createdAt", e."empireId", e."territoryId", e.data,
        -- A municipality of the territory the event is about, to centre the map on it.
        (SELECT min(tu."geoUnitId") FROM "TerritoryUnit" tu WHERE tu."territoryId" = e."territoryId") AS "geoUnitId"
      FROM "GameEvent" e
      WHERE e."matchId" = ${matchId} AND e."isPublic" AND e."removedAt" IS NULL
        AND e.type = ANY(${types})
        ${
          query.empireId
            ? Prisma.sql`AND (e."empireId" = ${query.empireId} OR e.data->>'defenderEmpireId' = ${query.empireId})`
            : Prisma.empty
        }
        ${before ? Prisma.sql`AND e."createdAt" < ${before}` : Prisma.empty}
      ORDER BY e."createdAt" DESC, e.id DESC
      LIMIT ${query.limit}`;
    return rows;
  }

  /**
   * The closed turns of a match, newest first, with how many things happened
   * in each (PROMPT §2.12). A turn is closed when its snapshot exists.
   */
  async history(matchId: string, viewer: AuthContext | null) {
    await this.matches.get(matchId, viewer);
    return this.prisma.$queryRaw<{ turn: number; closedAt: Date; events: number }[]>`
      SELECT s.turn, s."createdAt" AS "closedAt",
        (SELECT count(*)::int FROM "GameEvent" e
          WHERE e."matchId" = s."matchId" AND e."isPublic"
            -- What happened before the start (the empires being founded) belongs to the first turn.
            AND (e.turn = s.turn OR (s.turn = 1 AND e.turn < 1))
            AND e.type = ANY(${HISTORY_TYPES})) AS events
      FROM "TurnSnapshot" s
      WHERE s."matchId" = ${matchId}
      ORDER BY s.turn DESC`;
  }

  /**
   * A closed turn: what happened in it, in order, and who owned each
   * municipality when it ended. Like the board it carries names and outcomes
   * only: the resources of that moment are not kept anywhere, so nothing of
   * another empire can leak from the past.
   */
  async turn(matchId: string, turn: number, viewer: AuthContext | null) {
    await this.matches.get(matchId, viewer);
    const snapshot = await this.prisma.turnSnapshot.findUnique({
      where: { matchId_turn: { matchId, turn } },
    });
    if (!snapshot) throw notFound("Turn");
    const events = await this.prisma.$queryRaw<EventRow[]>`
      SELECT e.id, e.type, e.turn, e."createdAt", e."empireId", e."territoryId", e.data,
        (SELECT min(tu."geoUnitId") FROM "TerritoryUnit" tu WHERE tu."territoryId" = e."territoryId") AS "geoUnitId"
      FROM "GameEvent" e
      WHERE e."matchId" = ${matchId} AND e."isPublic"
        AND (e.turn = ${turn} OR (${turn} = 1 AND e.turn < 1))
        AND e.type = ANY(${HISTORY_TYPES})
      ORDER BY e."createdAt", e.id`;
    return {
      turn,
      closedAt: snapshot.createdAt,
      events,
      /** Municipality id → the empire that owned it; free municipalities are absent. */
      ownership: snapshot.ownership as Record<string, string>,
    };
  }

  /**
   * Posts a message in the name of the viewer's empire. Only empires still in
   * play can write; fallen ones and guests only read (PROMPT §2.11).
   */
  async post(matchId: string, body: z.infer<typeof messageBody>, viewer: AuthContext) {
    const event = await this.prisma.$transaction(async (tx) => {
      const match = await tx.match.findUnique({ where: { id: matchId } });
      if (!match) throw notFound("Match");
      if (match.status === "FINISHED") {
        throw new AppError(409, "MATCH_NOT_RUNNING", "The match is over");
      }
      const rules = rulesOf(match);
      if (body.text.length > rules.boardMaxChars) {
        throw new AppError(400, "MESSAGE_TOO_LONG", `At most ${rules.boardMaxChars} characters`);
      }
      // Locked so that two messages of the same empire are judged one after the other.
      const empires = await tx.$queryRaw<{ id: string; name: string; status: string }[]>`
        SELECT id, name, status::text FROM "Empire"
        WHERE "matchId" = ${matchId} AND "userId" = ${viewer.user.id} FOR UPDATE`;
      const empire = empires[0];
      if (!empire) throw new AppError(403, "NOT_A_PLAYER", "You have no empire in this match");
      if (empire.status !== "ACTIVE") {
        throw new AppError(409, "EMPIRE_FALLEN", "A fallen empire can only read the board");
      }

      const last = await tx.gameEvent.findFirst({
        where: { matchId, type: "MESSAGE", empireId: empire.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      const wait = last
        ? Math.ceil(rules.boardMessageIntervalSec - (Date.now() - last.createdAt.getTime()) / 1000)
        : 0;
      if (wait > 0) {
        throw new AppError(429, "RATE_LIMITED", "Wait before writing again", {
          "retry-after": String(wait),
        });
      }
      await recordEvent(tx, matchId, match.currentTurn, {
        type: "MESSAGE",
        empireId: empire.id,
        data: { empireName: empire.name, text: body.text },
      });
      return tx.gameEvent.findFirstOrThrow({
        where: { matchId, type: "MESSAGE", empireId: empire.id },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
    });
    this.onChange(matchId, "board");
    return event;
  }

  /** Removes a player's message. Only the owner of the match and the platform admin can. */
  async remove(matchId: string, eventId: string, viewer: AuthContext) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { ownerId: true, status: true },
    });
    if (!match) throw notFound("Match");
    if (match.ownerId !== viewer.user.id && viewer.user.role !== "ADMIN") throw forbidden();
    // Automatic announcements are the record of what happened: they are not removed.
    const { count } = await this.prisma.gameEvent.updateMany({
      where: { id: eventId, matchId, type: "MESSAGE", removedAt: null },
      data: { removedAt: new Date(), removedById: viewer.user.id },
    });
    if (count === 0) throw notFound("Message");
    this.onChange(matchId, "board");
  }
}

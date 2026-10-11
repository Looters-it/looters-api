import { randomUUID } from "node:crypto";
import { Prisma, type Match, type PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/sessions.js";
import { recordEvent } from "../../events/events.js";
import { AppError, forbidden, notFound } from "../../http/errors.js";
import { enqueueJob, moveTurnClose } from "../../queue/jobs.js";
import { matchRulesSchema, resolveMatchRules, type MatchRules } from "../../rules/config.js";
import { drawHiddenResources, secureRandom, type Random } from "../../rules/hidden-resources.js";
import { costOf } from "../../rules/attack.js";
import { turnIncome } from "../../rules/income.js";
import { preliminaryEndsAt } from "../../rules/phases.js";
import { structureDefinition } from "../../rules/structures.js";
import type { z } from "zod";
import {
  PLANNED_EDITABLE,
  RUSH_TURN_SECONDS,
  type createMatchBody,
  type empireBody,
  type joinBody,
  type listMatchesQuery,
  type updateMatchBody,
} from "./schemas.js";

type Tx = Prisma.TransactionClient;
type Viewer = AuthContext | null;

const conflict = (code: string, message: string) => new AppError(409, code, message);

/** Opponents of a single player, when the request does not say how many. */
const SINGLEPLAYER_BOTS = 3;

/** The rules of a match, as stored in full when it was created. */
export const rulesOf = (match: Pick<Match, "config">): MatchRules =>
  matchRulesSchema.parse(match.config);

/** Municipalities under the given folders, each counted once. */
const unitsOfAreas = (areaIds: string[]) => Prisma.sql`
  WITH RECURSIVE tree AS (
    SELECT id FROM "GeoArea" WHERE id IN (${Prisma.join(areaIds)})
    UNION
    SELECT child.id FROM "GeoArea" child JOIN tree ON child."parentId" = tree.id
  ) SELECT u.id, u.name FROM "GeoUnit" u WHERE u."areaId" IN (SELECT id FROM tree)`;

const summarySelect = {
  id: true,
  name: true,
  status: true,
  mode: true,
  pace: true,
  visibility: true,
  startAt: true,
  maxDays: true,
  maxPlayers: true,
  turnHours: true,
  currentTurn: true,
  turnEndsAt: true,
  pausedAt: true,
  finishedAt: true,
  winnerEmpireId: true,
  winnerEmpireIds: true,
  config: true,
  ownerId: true,
  owner: { select: { username: true } },
  areas: { select: { area: { select: { id: true, name: true } } } },
  _count: { select: { empires: true } },
} satisfies Prisma.MatchSelect;

type SummaryRow = Prisma.MatchGetPayload<{ select: typeof summarySelect }>;

function summary(row: SummaryRow, viewer: Viewer) {
  const isOwner = viewer?.user.id === row.ownerId;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    mode: row.mode,
    pace: row.pace,
    visibility: row.visibility,
    startAt: row.startAt,
    maxDays: row.maxDays,
    maxPlayers: row.maxPlayers,
    turnHours: row.turnHours,
    currentTurn: row.currentTurn,
    turnEndsAt: row.turnEndsAt,
    /** Until then the turn is in its preliminary part: see rules/phases. */
    preliminaryEndsAt: row.status === "ONGOING" ? preliminaryEndsAt(row) : null,
    /** Since when the match is paused, if it is: the clock of the turn stands still. */
    pausedAt: row.pausedAt,
    finishedAt: row.finishedAt,
    winnerEmpireId: row.winnerEmpireId,
    /** More than one when the match ended with empires exactly level. */
    winnerEmpireIds: row.winnerEmpireIds,
    players: row._count.empires,
    owner: row.owner.username,
    areas: row.areas.map((entry) => entry.area),
    // The rules are public: players need them to decide.
    config: row.config,
    isOwner,
  };
}

function moveInTurns(
  type: string,
  data: Prisma.JsonValue,
  rules: MatchRules,
  currentTurn: number,
): number | null {
  const every = structureDefinition(type)?.moveEveryTurns?.(rules);
  if (every === undefined) return null;
  const lastMove = (data as { lastMoveTurn?: number }).lastMoveTurn;
  return lastMove === undefined ? 0 : Math.max(0, lastMove + every - currentTurn);
}

/** Lets a few through at a time; the others wait in the order they came. */
class Gate {
  private free: number;
  private readonly waiting: (() => void)[] = [];
  constructor(size: number) {
    this.free = size;
  }
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    return () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    };
  }
}

/** How many matches are written to the database at the same time. */
const CREATING_AT_ONCE = 2;

export class MatchService {
  private readonly creating = new Gate(CREATING_AT_ONCE);
  /** Called after a change that the followers of a match should see. */
  onChange: (matchId: string, kind: string) => void = () => undefined;
  /** Players of a match that are watching it right now. */
  matchOnline: (matchId: string) => number = () => 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly random: Random = secureRandom,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------- Reading ----------

  /**
   * Who may look at a match that is not for everyone: its owner, the empires in
   * it (its bots too, which play through the same doors as a player) and, when
   * it is private, whoever the owner invited.
   */
  private async admitted(
    match: { id: string; ownerId: string; mode: string; visibility: string },
    viewer: Viewer,
    inside?: boolean,
  ): Promise<boolean> {
    if (match.mode !== "SINGLEPLAYER" && match.visibility === "PUBLIC") return true;
    if (!viewer) return false;
    if (match.ownerId === viewer.user.id || inside) return true;
    const where = { matchId: match.id, userId: viewer.user.id };
    if (
      inside === undefined &&
      (await this.prisma.empire.findFirst({ where, select: { id: true } }))
    ) {
      return true;
    }
    if (match.mode === "SINGLEPLAYER") return false;
    return (await this.prisma.matchInvitation.findFirst({ where, select: { id: true } })) !== null;
  }

  /** A match the viewer may not look at does not exist, as far as they can tell. */
  private async visible(id: string, viewer: Viewer): Promise<SummaryRow> {
    const row = await this.prisma.match.findUnique({ where: { id }, select: summarySelect });
    if (!row || !(await this.admitted(row, viewer))) throw notFound("Match");
    return row;
  }

  private async owned(id: string, viewer: AuthContext): Promise<SummaryRow> {
    const row = await this.visible(id, viewer);
    if (row.ownerId !== viewer.user.id) throw forbidden();
    return row;
  }

  async get(id: string, viewer: Viewer) {
    return summary(await this.visible(id, viewer), viewer);
  }

  /**
   * The matches anyone can take part in, multiplayer and public: those planned
   * or ongoing, soonest first, or the finished ones, latest first. Private and
   * single-player matches are reached from "mine" and from the invitations.
   */
  async list(query: z.infer<typeof listMatchesQuery>, viewer: Viewer) {
    const players = Prisma.sql`(SELECT count(*) FROM "Empire" e WHERE e."matchId" = m.id)`;
    const size = {
      free: Prisma.sql`${players} < m."maxPlayers"`,
      s: Prisma.sql`${players} <= 20`,
      m: Prisma.sql`${players} BETWEEN 21 AND 50`,
      l: Prisma.sql`${players} > 50`,
    };
    const finished = query.status === "finished";
    const where = Prisma.sql`${finished ? Prisma.sql`m.status = 'FINISHED'` : Prisma.sql`m.status IN ('PLANNED', 'ONGOING')`}
      AND m.visibility = 'PUBLIC' AND m.mode = 'MULTIPLAYER'
      ${query.name ? Prisma.sql`AND m.name ILIKE ${"%" + query.name.replace(/[%_\\]/g, "\\$&") + "%"}` : Prisma.empty}
      ${query.size ? Prisma.sql`AND ${size[query.size]}` : Prisma.empty}`;

    const [ids, totals] = await Promise.all([
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT m.id FROM "Match" m WHERE ${where}
        ORDER BY ${finished ? Prisma.sql`m."finishedAt" DESC NULLS LAST` : Prisma.sql`(m.status = 'PLANNED') DESC, m."startAt"`}, m.id
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM "Match" m WHERE ${where}`,
    ]);
    const rows = await this.prisma.match.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      select: summarySelect,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      page: query.page,
      pageSize: query.pageSize,
      total: totals[0]?.total ?? 0,
      matches: ids.flatMap(({ id }) => {
        const row = byId.get(id);
        return row ? [summary(row, viewer)] : [];
      }),
    };
  }

  /** The viewer's own matches still to be played: the ones they own and the ones they play. */
  async mine(viewer: AuthContext) {
    const rows = await this.prisma.match.findMany({
      where: {
        OR: [{ ownerId: viewer.user.id }, { empires: { some: { userId: viewer.user.id } } }],
        status: { not: "FINISHED" },
      },
      orderBy: { startAt: "asc" },
      select: summarySelect,
    });
    return rows.map((row) => summary(row, viewer));
  }

  // ---------- Owner ----------

  private async assertAreas(areaIds: string[]) {
    const found = await this.prisma.geoArea.count({ where: { id: { in: areaIds } } });
    if (found !== new Set(areaIds).size) throw notFound("Folder");
  }

  /**
   * Creates a match, planned and open to players at once: one game territory
   * per municipality of the chosen areas, each with its hidden starting
   * resources. With a date it starts then; without, as soon as its first player
   * has chosen a capital.
   */
  async create(body: z.infer<typeof createMatchBody>, viewer: AuthContext) {
    await this.assertAreas(body.areaIds);
    const areaIds = [...new Set(body.areaIds)];
    const single = body.mode === "SINGLEPLAYER";
    const now = this.now();
    if (body.startAt && body.startAt <= now) {
      throw conflict("START_IN_PAST", "The start must be in the future");
    }
    // Alone means against bots: some from the first turn, and room for them.
    const rules = resolveMatchRules(
      single
        ? {
            ...body.config,
            botsEnabled: true,
            botsAtStart: Math.max(1, body.config.botsAtStart ?? SINGLEPLAYER_BOTS),
            botsMax: Math.max(
              body.config.botsMax ?? 0,
              body.config.botsAtStart ?? SINGLEPLAYER_BOTS,
              1,
            ),
            minPlayersToStart: 1,
          }
        : body.config,
    );
    const visibility = single ? "PRIVATE" : body.visibility;
    const units = await this.prisma.$queryRaw<{ id: number; name: string }[]>(
      unitsOfAreas(areaIds),
    );
    if (units.length < 2) throw conflict("NO_UNITS", "The chosen areas have no municipalities");

    // Thousands of rows in one transaction: a few at a time, so that many matches
    // created together wait for their turn instead of taking every connection from
    // the matches being played.
    const release = await this.creating.acquire();
    try {
      return await this.createRows(body, viewer, {
        areaIds,
        single,
        now,
        rules,
        visibility,
        units,
      });
    } finally {
      release();
    }
  }

  private async createRows(
    body: z.infer<typeof createMatchBody>,
    viewer: AuthContext,
    made: {
      areaIds: string[];
      single: boolean;
      now: Date;
      rules: MatchRules;
      visibility: "PUBLIC" | "PRIVATE";
      units: { id: number; name: string }[];
    },
  ) {
    const { areaIds, single, now, rules, visibility, units } = made;
    const id = await this.prisma.$transaction(
      async (tx) => {
        const match = await tx.match.create({
          data: {
            name: body.name,
            ownerId: viewer.user.id,
            mode: body.mode,
            pace: body.pace,
            visibility,
            // Without a date the match waits for its first player: see `join`.
            startAt: body.startAt ?? now,
            maxDays: body.maxDays,
            maxPlayers: single ? Math.max(2, rules.botsMax + 1) : body.maxPlayers,
            turnHours: body.pace === "RUSH" ? RUSH_TURN_SECONDS / 3600 : body.turnHours,
            // Stored in full, so changing a default never alters this match.
            config: rules,
            areas: { create: areaIds.map((areaId) => ({ areaId })) },
          },
          select: { id: true },
        });
        const territories = units.map((unit) => ({
          id: randomUUID(),
          matchId: match.id,
          name: unit.name,
          // Drawn here, on the server, and never sent to a client before the
          // municipality is acquired.
          resources: drawHiddenResources(rules, this.random),
          geoUnitId: unit.id,
        }));
        const chunk = 2000;
        for (let start = 0; start < territories.length; start += chunk) {
          const slice = territories.slice(start, start + chunk);
          await tx.territory.createMany({
            data: slice.map(({ geoUnitId: _geoUnitId, ...territory }) => territory),
          });
          await tx.territoryUnit.createMany({
            data: slice.map((territory) => ({
              matchId: match.id,
              territoryId: territory.id,
              geoUnitId: territory.geoUnitId,
            })),
          });
        }
        await recordEvent(tx, match.id, 0, { type: "MATCH_OPENED" });
        if (body.startAt) await this.scheduleStart(tx, match.id, body.startAt);
        return match.id;
      },
      // The wait covers a connection that is busy for a moment, not only a free one.
      { timeout: 60_000, maxWait: 30_000 },
    );
    this.onChange(id, "match");
    return this.get(id, viewer);
  }

  /** Before the start the owner may still change a few things: see PLANNED_EDITABLE. */
  async update(id: string, body: z.infer<typeof updateMatchBody>, viewer: AuthContext) {
    const match = await this.owned(id, viewer);
    if (match.status !== "PLANNED") {
      throw conflict("MATCH_LOCKED", "A started match cannot be changed");
    }
    const locked = Object.keys(body).filter(
      (key) => !(PLANNED_EDITABLE as readonly string[]).includes(key),
    );
    if (locked.length > 0) {
      throw conflict("MATCH_LOCKED", `Cannot change ${locked.join(", ")} after the creation`);
    }
    if (body.maxPlayers !== undefined && body.maxPlayers < match._count.empires) {
      throw conflict("TOO_FEW_SEATS", "There are already more players than that");
    }
    if (body.startAt && body.startAt <= this.now()) {
      throw conflict("START_IN_PAST", "The start must be in the future");
    }

    await this.prisma.$transaction(async (tx) => {
      const { areaIds: _areaIds, config: _config, ...fields } = body;
      await tx.match.update({ where: { id }, data: fields });
      // A new date needs its own start job; the old one finds the date moved and does nothing.
      if (body.startAt) await this.scheduleStart(tx, id, body.startAt);
    });
    this.onChange(id, "match");
    return this.get(id, viewer);
  }

  private scheduleStart(tx: Tx, matchId: string, startAt: Date) {
    return enqueueJob(
      tx,
      "match.start",
      { matchId },
      { runAt: startAt, dedupeKey: `match.start:${matchId}:${startAt.toISOString()}` },
    );
  }

  /** A match can be deleted while it is planned and nobody else is in it. */
  async remove(id: string, viewer: AuthContext) {
    const match = await this.owned(id, viewer);
    if (match.status !== "PLANNED") {
      throw conflict("MATCH_LOCKED", "A started match cannot be deleted");
    }
    const others = await this.prisma.empire.count({
      where: { matchId: id, userId: { not: viewer.user.id } },
    });
    if (others > 0) throw conflict("HAS_PLAYERS", "Other players are already in this match");
    await this.prisma.match.delete({ where: { id } });
  }

  // ---------- Invitations ----------

  /** Only the owner of a private match invites, and only while it can still be entered. */
  private async inviting(id: string, viewer: AuthContext) {
    const match = await this.owned(id, viewer);
    if (match.mode !== "MULTIPLAYER" || match.visibility !== "PRIVATE") {
      throw conflict("NOT_PRIVATE", "Only a private match has invitations");
    }
    return match;
  }

  /** Whoever the owner invited, with whether they have come in yet. */
  async invitations(id: string, viewer: AuthContext) {
    await this.inviting(id, viewer);
    const rows = await this.prisma.matchInvitation.findMany({
      where: { matchId: id },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true, userId: true, user: { select: { username: true } } },
    });
    const inside = new Set(
      (await this.prisma.empire.findMany({ where: { matchId: id }, select: { userId: true } })).map(
        (empire) => empire.userId,
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      username: row.user.username,
      createdAt: row.createdAt,
      joined: inside.has(row.userId),
    }));
  }

  /** Invites a player, by username, to a private match. */
  async invite(id: string, username: string, viewer: AuthContext) {
    const match = await this.inviting(id, viewer);
    if (match.status === "FINISHED") throw conflict("MATCH_LOCKED", "The match is over");
    const user = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: "insensitive" }, isBot: false },
      select: { id: true },
    });
    if (!user) throw notFound("User");
    if (user.id === viewer.user.id) throw conflict("OWN_MATCH", "The match is already yours");
    try {
      await this.prisma.matchInvitation.create({ data: { matchId: id, userId: user.id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw conflict("ALREADY_INVITED", "This player is already invited");
      }
      throw error;
    }
    return this.invitations(id, viewer);
  }

  /** Takes an invitation back. Who has already come in stays in. */
  async uninvite(id: string, invitationId: string, viewer: AuthContext) {
    await this.inviting(id, viewer);
    await this.prisma.matchInvitation.deleteMany({ where: { id: invitationId, matchId: id } });
    return this.invitations(id, viewer);
  }

  /** The invitations the viewer has not answered: matches still open that they are not in. */
  async myInvitations(viewer: AuthContext) {
    const rows = await this.prisma.matchInvitation.findMany({
      where: {
        userId: viewer.user.id,
        match: {
          status: { not: "FINISHED" },
          empires: { none: { userId: viewer.user.id } },
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, match: { select: summarySelect } },
    });
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      match: summary(row.match, viewer),
    }));
  }

  /** Turns an invitation down: the match is no longer there for the viewer. */
  async declineInvitation(invitationId: string, viewer: AuthContext) {
    const { count } = await this.prisma.matchInvitation.deleteMany({
      where: { id: invitationId, userId: viewer.user.id },
    });
    if (count === 0) throw notFound("Invitation");
  }

  // ---------- Players ----------

  private async assertIdentityFree(
    tx: Tx,
    matchId: string,
    empire: z.infer<typeof empireBody>,
    exceptEmpireId?: string,
  ) {
    const others = { matchId, NOT: { id: exceptEmpireId } };
    if (
      await tx.empire.findFirst({
        where: { ...others, name: { equals: empire.name, mode: "insensitive" } },
      })
    ) {
      throw conflict("EMPIRE_NAME_TAKEN", "Another empire has this name");
    }
    if (await tx.empire.findFirst({ where: { ...others, color: empire.color } })) {
      throw conflict("EMPIRE_COLOR_TAKEN", "Another empire has this colour");
    }
  }

  /**
   * Takes a player out of a match that has not started yet. Their starting
   * municipality is free again, with a newly drawn hidden endowment: nobody
   * learns what it holds from having been there. The player may join again,
   * which is also the way to choose another starting point.
   */
  async withdraw(id: string, viewer: AuthContext) {
    await this.visible(id, viewer);
    await this.prisma.$transaction(async (tx) => {
      // Like a join: one at a time for a match.
      const rows = await tx.$queryRaw<Match[]>`SELECT * FROM "Match" WHERE id = ${id} FOR UPDATE`;
      const match = rows[0];
      if (!match) throw notFound("Match");
      if (match.status !== "PLANNED") {
        throw conflict("MATCH_STARTED", "You can withdraw only before the match starts");
      }
      const empire = await tx.empire.findFirst({ where: { matchId: id, userId: viewer.user.id } });
      if (!empire) throw new AppError(403, "NOT_A_PLAYER", "You have no empire in this match");

      const territories = await tx.territory.findMany({
        where: { matchId: id, ownerEmpireId: empire.id },
        select: { id: true, name: true },
      });
      const rules = rulesOf(match);
      for (const territory of territories) {
        await tx.territory.update({
          where: { id: territory.id },
          data: {
            ownerEmpireId: null,
            resources: drawHiddenResources(rules, this.random),
            protectedUntilTurn: null,
            weight: 1,
          },
        });
      }
      await tx.allianceInvite.deleteMany({
        where: { matchId: id, OR: [{ fromEmpireId: empire.id }, { toEmpireId: empire.id }] },
      });
      await tx.empire.update({ where: { id: empire.id }, data: { capitalTerritoryId: null } });
      await tx.empire.delete({ where: { id: empire.id } });
      await recordEvent(tx, id, match.currentTurn, {
        type: "EMPIRE_WITHDRAWN",
        territoryId: territories[0]?.id ?? "",
        data: { empireName: empire.name, territoryName: territories[0]?.name ?? "" },
      });
    });
    this.onChange(id, "empires");
    return this.state(id, viewer);
  }

  /**
   * A player leaves for good a match that is being played. What follows is the work
   * of `jobs`, which owns the end of an empire: everything it holds becomes free, the
   * player stays as a spectator, and the match ends if nobody is left to play it.
   * Asked twice, it is done once.
   */
  async abandon(id: string, viewer: AuthContext) {
    await this.visible(id, viewer);
    const match = await this.prisma.match.findUnique({ where: { id }, select: { status: true } });
    if (!match) throw notFound("Match");
    if (match.status !== "ONGOING") {
      throw conflict("MATCH_NOT_ONGOING", "Only a match that is being played can be abandoned");
    }
    const empire = await this.prisma.empire.findFirst({
      where: { matchId: id, userId: viewer.user.id },
      select: { id: true, status: true },
    });
    if (!empire) throw new AppError(403, "NOT_A_PLAYER", "You have no empire in this match");
    if (empire.status !== "ACTIVE") throw conflict("EMPIRE_FALLEN", "Your empire has fallen");
    await enqueueJob(
      this.prisma,
      "empire.abandon",
      { matchId: id, empireId: empire.id },
      { dedupeKey: `empire.abandon:${empire.id}` },
    );
  }

  /**
   * Stops or restarts the clock of a single-player match: only who plays it alone can,
   * since nobody else is kept waiting. While it is paused the turn does not close and
   * nobody acts, bots included; resumed, the turn ends as much later as the pause lasted.
   */
  async setPaused(id: string, paused: boolean, viewer: AuthContext) {
    await this.visible(id, viewer);
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Match[]>`SELECT * FROM "Match" WHERE id = ${id} FOR UPDATE`;
      const match = rows[0];
      if (!match) throw notFound("Match");
      if (match.ownerId !== viewer.user.id) {
        throw new AppError(403, "NOT_THE_OWNER", "Only who created the match can pause it");
      }
      if (match.mode !== "SINGLEPLAYER") {
        throw conflict("NOT_SINGLEPLAYER", "Only a match played alone can be paused");
      }
      if (match.status !== "ONGOING" || !match.turnEndsAt) {
        throw conflict("MATCH_NOT_RUNNING", "The match is not being played");
      }
      // Asked twice, done once.
      const since = match.pausedAt;
      if (paused === (since !== null)) return;
      if (paused || since === null) {
        await tx.match.update({ where: { id }, data: { pausedAt: new Date() } });
        return;
      }
      const turnEndsAt = new Date(
        match.turnEndsAt.getTime() + Math.max(0, Date.now() - since.getTime()),
      );
      await tx.match.update({ where: { id }, data: { pausedAt: null, turnEndsAt } });
      // The closing of the turn moves with its end.
      await moveTurnClose(tx, id, match.currentTurn, turnEndsAt);
    });
    this.onChange(id, paused ? "match.paused" : "match.resumed");
  }

  /**
   * Enrols the viewer: the chosen municipality becomes the capital of a new
   * empire. Whoever arrives first gets it (PROMPT §9 #5).
   */
  async join(
    id: string,
    body: z.infer<typeof joinBody>,
    viewer: AuthContext,
    /** A bot enters a running match whatever the rules for players say, and needs no code. */
    options: { asBot?: boolean } = {},
  ) {
    // A bot is let into the match it was made for, single-player ones included.
    if (!options.asBot) await this.visible(id, viewer);
    await this.prisma.$transaction(async (tx) => {
      // Joins of one match run one at a time: seats, names and colours are checked safely.
      const rows = await tx.$queryRaw<Match[]>`SELECT * FROM "Match" WHERE id = ${id} FOR UPDATE`;
      const match = rows[0];
      if (!match) throw notFound("Match");
      const rules = rulesOf(match);

      const open =
        match.status === "PLANNED" ||
        (match.status === "ONGOING" && (rules.lateJoin || options.asBot === true));
      if (!open) throw conflict("REGISTRATION_CLOSED", "This match does not accept players");
      if (!options.asBot && match.mode === "SINGLEPLAYER" && match.ownerId !== viewer.user.id) {
        throw new AppError(403, "SINGLEPLAYER", "This match is played alone");
      }
      if (await tx.empire.findFirst({ where: { matchId: id, userId: viewer.user.id } })) {
        throw conflict("ALREADY_JOINED", "You already have an empire in this match");
      }
      if ((await tx.empire.count({ where: { matchId: id } })) >= match.maxPlayers) {
        throw conflict("MATCH_FULL", "This match is full");
      }
      await this.assertIdentityFree(tx, id, body.empire);

      const unit = await tx.territoryUnit.findUnique({
        where: { matchId_geoUnitId: { matchId: id, geoUnitId: body.geoUnitId } },
      });
      if (!unit) throw notFound("Municipality");

      const empire = await tx.empire.create({
        data: { matchId: id, userId: viewer.user.id, ...body.empire },
      });
      // Conditional on being free: of two players choosing the same
      // municipality, the second finds it taken and nothing of theirs is saved.
      const turn = Math.max(match.currentTurn, 1);
      const { count } = await tx.territory.updateMany({
        where: { id: unit.territoryId, ownerEmpireId: null },
        data: {
          ownerEmpireId: empire.id,
          // The hidden endowment already on the territory is added to the starting resources.
          resources: { increment: rules.startResources },
          // Just acquired: protected until the end of this turn (the first, before the start).
          protectedUntilTurn: turn,
        },
      });
      if (count === 0) throw conflict("TERRITORY_TAKEN", "Another empire is already there");

      await tx.empire.update({
        where: { id: empire.id },
        data: { capitalTerritoryId: unit.territoryId },
      });
      const territory = await tx.territory.findUniqueOrThrow({ where: { id: unit.territoryId } });
      await recordEvent(tx, id, match.currentTurn, {
        type: "EMPIRE_CREATED",
        empireId: empire.id,
        territoryId: territory.id,
        data: { empireName: empire.name, territoryName: territory.name },
      });

      // A match whose time has come was only waiting for players: created to start
      // at once, or planned for a date that found too few. It starts now, and its
      // turns are counted from now.
      if (match.status === "PLANNED" && match.startAt <= this.now()) {
        const players = await tx.empire.count({ where: { matchId: id, status: "ACTIVE" } });
        if (players >= rules.minPlayersToStart) {
          const startAt = this.now();
          await tx.match.update({ where: { id }, data: { startAt } });
          await this.scheduleStart(tx, id, startAt);
        }
      }
    });
    this.onChange(id, "empires");
    return this.state(id, viewer);
  }

  /** Name, colour, emblem and motto can change only before the match starts (PROMPT §9 #14). */
  async updateEmpire(id: string, body: z.infer<typeof empireBody>, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Match[]>`SELECT * FROM "Match" WHERE id = ${id} FOR UPDATE`;
      const match = rows[0];
      if (!match) throw notFound("Match");
      const empire = await tx.empire.findFirst({ where: { matchId: id, userId: viewer.user.id } });
      if (!empire) throw notFound("Empire");
      if (match.status !== "PLANNED") {
        throw conflict("MATCH_STARTED", "The empire cannot be changed after the start");
      }
      await this.assertIdentityFree(tx, id, body, empire.id);
      await tx.empire.update({ where: { id: empire.id }, data: body });
    });
    this.onChange(id, "empires");
    return this.state(id, viewer);
  }

  /**
   * Sets the image that stands for the viewer's empire in place of its emblem.
   * Unlike name and colour it can change during the match: it identifies
   * nobody by itself and a player may want to fix a bad upload.
   */
  async setLogo(id: string, logo: { mime: string; data: Buffer }, viewer: AuthContext) {
    const match = await this.visible(id, viewer);
    if (match.status === "FINISHED") throw conflict("MATCH_NOT_RUNNING", "The match is over");
    const empire = await this.prisma.empire.findFirst({
      where: { matchId: id, userId: viewer.user.id },
    });
    if (!empire) throw new AppError(403, "NOT_A_PLAYER", "You have no empire in this match");
    const stored = { mime: logo.mime, data: new Uint8Array(logo.data) };
    await this.prisma.empireLogo.upsert({
      where: { empireId: empire.id },
      create: { empireId: empire.id, ...stored },
      update: stored,
    });
    this.onChange(id, "empires");
    return this.state(id, viewer);
  }

  /**
   * Removes a logo: the player their own, the owner of the match and the
   * platform admin anyone's (an image is the one thing a player can show to
   * everybody without a word being read first).
   */
  async removeLogo(id: string, empireId: string, viewer: AuthContext) {
    const match = await this.visible(id, viewer);
    const empire = await this.prisma.empire.findFirst({ where: { id: empireId, matchId: id } });
    if (!empire) throw notFound("Empire");
    const allowed =
      empire.userId === viewer.user.id ||
      match.ownerId === viewer.user.id ||
      viewer.user.role === "ADMIN";
    if (!allowed) throw forbidden();
    await this.prisma.empireLogo.deleteMany({ where: { empireId } });
    this.onChange(id, "empires");
    return this.state(id, viewer);
  }

  /** The image itself: public like the empire it stands for. */
  async logo(id: string, empireId: string, viewer: Viewer) {
    await this.visible(id, viewer);
    const logo = await this.prisma.empireLogo.findFirst({
      where: { empireId, empire: { matchId: id } },
    });
    if (!logo) throw notFound("Logo");
    return logo;
  }

  /**
   * Everything of a match that its state is made of, the same for every
   * viewer: what each one may see of it is decided afterwards, in memory.
   */
  private async load(id: string) {
    const match = await this.prisma.match.findUnique({ where: { id }, select: summarySelect });
    if (!match) return null;
    const [empires, territories] = await Promise.all([
      this.prisma.empire.findMany({
        where: { matchId: id },
        orderBy: { joinedAt: "asc" },
        select: {
          id: true,
          name: true,
          color: true,
          emblem: true,
          motto: true,
          status: true,
          userId: true,
          capitalTerritoryId: true,
          annexedThisTurn: true,
          allocationMode: true,
          lastCapitalMoveTurn: true,
          fallenTurn: true,
          place: true,
          award: true,
          user: { select: { username: true, isBot: true } },
          logo: { select: { updatedAt: true } },
        },
      }),
      this.prisma.territory.findMany({
        where: { matchId: id, ownerEmpireId: { not: null } },
        select: {
          id: true,
          name: true,
          ownerEmpireId: true,
          resources: true,
          protectedUntilTurn: true,
          weight: true,
          alert: true,
          isArea: true,
          battleLock: { select: { battleId: true } },
          units: { select: { geoUnitId: true } },
        },
      }),
    ]);
    const battles = await this.prisma.battle.findMany({
      where: {
        matchId: id,
        OR: [{ status: "OPEN" }, { status: "RESOLVED", turn: { gte: match.currentTurn - 1 } }],
      },
      orderBy: { createdAt: "desc" },
      include: { sources: { select: { territoryId: true, cost: true } } },
    });
    const territoryNames = new Map(
      (
        await this.prisma.territory.findMany({
          where: {
            id: {
              in: battles.flatMap((battle) => [
                battle.targetTerritoryId,
                ...battle.sources.map((source) => source.territoryId),
              ]),
            },
          },
          select: { id: true, name: true },
        })
      ).map((territory) => [territory.id, territory.name]),
    );
    const structures = await this.prisma.structure.findMany({
      where: { matchId: id, active: true },
      orderBy: { builtTurn: "asc" },
      select: {
        id: true,
        type: true,
        territoryId: true,
        empireId: true,
        expiresTurn: true,
        data: true,
      },
    });

    // Alliances are public: everyone sees who is allied with whom.
    const alliances = await this.prisma.alliance.findMany({
      where: { matchId: id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        aEmpireId: true,
        bEmpireId: true,
        endsAtTurn: true,
        endedByEmpireId: true,
      },
    });
    const invites = await this.prisma.allianceInvite.findMany({
      where: { matchId: id, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true, fromEmpireId: true, toEmpireId: true },
    });
    // Municipalities controlled by each empire.
    const unitsByEmpire = new Map<string, number>();
    for (const territory of territories) {
      const owner = territory.ownerEmpireId ?? "";
      unitsByEmpire.set(owner, (unitsByEmpire.get(owner) ?? 0) + territory.units.length);
    }
    return {
      match,
      empires,
      territories,
      battles,
      territoryNames,
      structures,
      alliances,
      invites,
      unitsByEmpire,
    };
  }

  private readonly loaded = new Map<
    string,
    { at: number; data: ReturnType<MatchService["load"]> }
  >();

  /**
   * What `load` read, kept for `stateCacheMs`. When a match changes all its
   * followers read the state at the same moment: they share one reading
   * instead of repeating it a hundred times. `forget` is called on every
   * change this process knows of, so a player never reads a state older than
   * their own action; the time limit covers anything else.
   */
  private loadShared(id: string) {
    if (this.stateCacheMs <= 0) return this.load(id);
    const now = Date.now();
    const kept = this.loaded.get(id);
    if (kept && now - kept.at < this.stateCacheMs) return kept.data;
    if (this.loaded.size > 1000) this.loaded.clear();
    const data = this.load(id);
    this.loaded.set(id, { at: now, data });
    // A failed reading is not kept.
    data.catch(() => {
      if (this.loaded.get(id)?.data === data) this.loaded.delete(id);
    });
    return data;
  }

  /** The match changed: its state is read again from the database. */
  forget(id: string): void {
    this.loaded.delete(id);
  }

  /** Reading shared between viewers for this long; 0 reads the database every time. */
  stateCacheMs = 0;

  async state(id: string, viewer: Viewer) {
    const data = await this.loadShared(id);
    if (!data) throw notFound("Match");
    const { match, empires, territories, territoryNames, structures, alliances } = data;
    const mine = empires.find((empire) => empire.userId === viewer?.user.id) ?? null;
    if (!(await this.admitted(match, viewer, mine !== null))) throw notFound("Match");
    const currentTurn = Math.max(match.currentTurn, 1);
    const rules = rulesOf(match);

    // Open battles are public (a territory under attack is marked on the map for
    // everyone). The battles just resolved are shown to their two sides only.
    const battles = data.battles.filter(
      (battle) =>
        battle.status === "OPEN" ||
        (mine !== null &&
          (battle.attackerEmpireId === mine.id || battle.defenderEmpireId === mine.id)),
    );
    const unitsOf = (empireId: string) => data.unitsByEmpire.get(empireId) ?? 0;

    // The viewer's allies: one for each pact they are in.
    const allies = new Set(
      mine
        ? alliances
            .filter((pact) => pact.aEmpireId === mine.id || pact.bEmpireId === mine.id)
            .map((pact) => (pact.aEmpireId === mine.id ? pact.bEmpireId : pact.aEmpireId))
        : [],
    );
    const invites = mine
      ? data.invites.filter(
          (invite) => invite.toEmpireId === mine.id || invite.fromEmpireId === mine.id,
        )
      : [];

    return {
      match: summary(match, viewer),
      me: mine
        ? {
            empireId: mine.id,
            /** Annexations still available this turn. */
            annexLeft: Math.max(0, rules.annexPerTurn - mine.annexedThisTurn),
            /** Attacks still available this turn. */
            attacksLeft: Math.max(
              0,
              rules.attacksPerTurn -
                data.battles.filter(
                  (battle) =>
                    battle.attackerEmpireId === mine.id && battle.turn === match.currentTurn,
                ).length,
            ),
            /** What the empire earns at the end of this turn. */
            turnValue: turnIncome(rules, unitsOf(mine.id)),
            allocationMode: mine.allocationMode,
            /** FALLEN: the player stays as a spectator and can no longer act. */
            status: mine.status,
            /** Turns to wait before the capital can move again; 0 when it can move now. */
            capitalMoveInTurns:
              mine.lastCapitalMoveTurn === null
                ? 0
                : Math.max(
                    0,
                    mine.lastCapitalMoveTurn + rules.capitalMoveEveryTurns - match.currentTurn,
                  ),
          }
        : null,
      empires: empires.map(
        ({
          userId: _userId,
          user,
          logo,
          annexedThisTurn: _annexed,
          allocationMode: _mode,
          lastCapitalMoveTurn: _moved,
          ...empire
        }) => ({
          ...empire,
          username: user.username,
          /** Played by the server. */
          isBot: user.isBot,
          /** Where the uploaded logo is, if there is one; it changes when the image does. */
          logoUrl: logo
            ? `/api/matches/${id}/empires/${empire.id}/logo?v=${String(logo.updatedAt.getTime())}`
            : null,
          units: unitsOf(empire.id),
          // Total resources stay hidden for the whole match and are revealed when it
          // ends (PROMPT §9 #10).
          ...(match.status === "FINISHED"
            ? {
                resources: territories
                  .filter((territory) => territory.ownerEmpireId === empire.id)
                  .reduce((sum, territory) => sum + territory.resources, 0),
              }
            : {}),
        }),
      ),
      territories: territories.map((territory) => {
        const own = mine !== null && territory.ownerEmpireId === mine.id;
        // Allies see each other's allocations; nobody else does.
        const ally =
          !own && territory.ownerEmpireId !== null && allies.has(territory.ownerEmpireId);
        return {
          id: territory.id,
          name: territory.name,
          ownerEmpireId: territory.ownerEmpireId,
          geoUnitIds: territory.units.map((unit) => unit.geoUnitId),
          isArea: territory.isArea,
          protected: (territory.protectedUntilTurn ?? 0) >= currentTurn,
          // Hidden from everyone but the owner: null, never the number.
          resources: own || ally ? territory.resources : null,
          weight: own ? territory.weight : null,
          /** Accumulation alert: public, and it never says how much is there. */
          alert: territory.alert,
          /** The open battle it is involved in, as target or as a source: public. */
          battleId: territory.battleLock?.battleId ?? null,
        };
      }),
      battles: battles.map((battle) => {
        const role =
          mine?.id === battle.attackerEmpireId
            ? ("attacker" as const)
            : mine?.id === battle.defenderEmpireId
              ? ("defender" as const)
              : null;
        return {
          id: battle.id,
          turn: battle.turn,
          status: battle.status,
          outcome: battle.outcome,
          targetTerritoryId: battle.targetTerritoryId,
          targetName: territoryNames.get(battle.targetTerritoryId) ?? "",
          attackerEmpireId: battle.attackerEmpireId,
          defenderEmpireId: battle.defenderEmpireId,
          role,
          // Where the attack starts from is public, like its target: every territory it
          // involves is marked on the map for everyone.
          fromTerritoryIds: battle.sources.map((source) => source.territoryId),
          fromNames: battle.sources.map((source) => territoryNames.get(source.territoryId) ?? ""),
          // Each side sees its own numbers and never the other's: forces, costs
          // and rolls of the opponent would give away its hidden resources.
          ...(role === "attacker"
            ? {
                attackCost: battle.attackCost,
                attackForce: battle.attackForce,
              }
            : {}),
          ...(role === "defender"
            ? {
                response: battle.response,
                defenseForce: battle.defenseForce,
                defenseCost:
                  battle.defenseCost ?? costOf(battle.defenseForce ?? 0, rules.defensePct),
              }
            : {}),
          // What a battle paid is told to who won it, and to nobody else: with it the
          // loser could work out what the winner had spent.
          ...(battle.spoils !== null &&
          role === (battle.outcome === "DEFENDER_WON" ? "defender" : "attacker")
            ? { spoils: battle.spoils }
            : {}),
        };
      }),
      /** Pacts between two empires: public, with the announced end if there is one. */
      alliances: alliances.map((pact) => ({
        id: pact.id,
        empireIds: [pact.aEmpireId, pact.bEmpireId],
        endsAtTurn: pact.endsAtTurn,
        endedByEmpireId: pact.endedByEmpireId,
      })),
      /** Proposals waiting for an answer, made by the viewer or to them. */
      invites,
      // Structures are public: a block and a second capital are marked on the map for everyone.
      structures: structures.map((structure) => ({
        id: structure.id,
        type: structure.type,
        territoryId: structure.territoryId,
        empireId: structure.empireId,
        effects: (structure.data as { effects?: string[] }).effects ?? [],
        /** Turns it still lasts, counting the current one; null if permanent. */
        turnsLeft:
          structure.expiresTurn === null
            ? null
            : Math.max(0, structure.expiresTurn - match.currentTurn + 1),
        /**
         * For a structure that can change territory: turns to wait before it can move
         * again, 0 when it can move now. Null for one that stays where it was built.
         */
        moveInTurns: moveInTurns(structure.type, structure.data, rules, match.currentTurn),
      })),
      online: {
        connected: this.matchOnline(id),
        total: empires.filter((empire) => empire.status === "ACTIVE").length,
      },
    };
  }
}

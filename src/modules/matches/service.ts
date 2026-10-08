import { randomUUID } from "node:crypto";
import { Prisma, type Match, type PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/sessions.js";
import { recordEvent } from "../../events/events.js";
import { AppError, forbidden, notFound } from "../../http/errors.js";
import { enqueueJob } from "../../queue/jobs.js";
import { matchRulesSchema, resolveMatchRules, type MatchRules } from "../../rules/config.js";
import { drawHiddenResources, secureRandom, type Random } from "../../rules/hidden-resources.js";
import { costOf } from "../../rules/attack.js";
import { turnIncome } from "../../rules/income.js";
import type { z } from "zod";
import {
  OPEN_EDITABLE,
  type createMatchBody,
  type empireBody,
  type joinBody,
  type listMatchesQuery,
  type updateMatchBody,
} from "./schemas.js";

type Tx = Prisma.TransactionClient;
type Viewer = AuthContext | null;

const conflict = (code: string, message: string) => new AppError(409, code, message);

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
  startAt: true,
  maxDays: true,
  maxPlayers: true,
  turnHours: true,
  currentTurn: true,
  turnEndsAt: true,
  finishedAt: true,
  winnerEmpireId: true,
  inviteCode: true,
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
    startAt: row.startAt,
    maxDays: row.maxDays,
    maxPlayers: row.maxPlayers,
    turnHours: row.turnHours,
    currentTurn: row.currentTurn,
    turnEndsAt: row.turnEndsAt,
    finishedAt: row.finishedAt,
    winnerEmpireId: row.winnerEmpireId,
    players: row._count.empires,
    hasInviteCode: row.inviteCode !== null,
    owner: row.owner.username,
    areas: row.areas.map((entry) => entry.area),
    // The rules are public: players need them to decide. The code is the owner's.
    config: row.config,
    isOwner,
    ...(isOwner ? { inviteCode: row.inviteCode } : {}),
  };
}

export class MatchService {
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

  /** A draft exists only for its owner. */
  private async visible(id: string, viewer: Viewer): Promise<SummaryRow> {
    const row = await this.prisma.match.findUnique({ where: { id }, select: summarySelect });
    if (!row || (row.status === "DRAFT" && row.ownerId !== viewer?.user.id)) {
      throw notFound("Match");
    }
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

  /** Matches open for registration or being played, soonest first. */
  async list(query: z.infer<typeof listMatchesQuery>, viewer: Viewer) {
    const players = Prisma.sql`(SELECT count(*) FROM "Empire" e WHERE e."matchId" = m.id)`;
    const size = {
      free: Prisma.sql`${players} < m."maxPlayers"`,
      s: Prisma.sql`${players} <= 20`,
      m: Prisma.sql`${players} BETWEEN 21 AND 50`,
      l: Prisma.sql`${players} > 50`,
    };
    const where = Prisma.sql`m.status IN ('OPEN', 'RUNNING')
      ${query.name ? Prisma.sql`AND m.name ILIKE ${"%" + query.name.replace(/[%_\\]/g, "\\$&") + "%"}` : Prisma.empty}
      ${query.size ? Prisma.sql`AND ${size[query.size]}` : Prisma.empty}`;

    const [ids, totals] = await Promise.all([
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT m.id FROM "Match" m WHERE ${where}
        ORDER BY (m.status = 'OPEN') DESC, m."startAt", m.id
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

  /** The viewer's own matches: the ones they own (drafts included) and the ones they play. */
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

  async create(body: z.infer<typeof createMatchBody>, viewer: AuthContext) {
    await this.assertAreas(body.areaIds);
    const match = await this.prisma.match.create({
      data: {
        name: body.name,
        ownerId: viewer.user.id,
        startAt: body.startAt,
        maxDays: body.maxDays,
        maxPlayers: body.maxPlayers,
        turnHours: body.turnHours,
        inviteCode: body.inviteCode,
        // Stored in full, so changing a default never alters this match.
        config: resolveMatchRules(body.config),
        areas: { create: [...new Set(body.areaIds)].map((areaId) => ({ areaId })) },
      },
      select: { id: true },
    });
    return this.get(match.id, viewer);
  }

  async update(id: string, body: z.infer<typeof updateMatchBody>, viewer: AuthContext) {
    const match = await this.owned(id, viewer);
    if (match.status !== "DRAFT" && match.status !== "OPEN") {
      throw conflict("MATCH_LOCKED", "A started match cannot be changed");
    }
    if (match.status === "OPEN") {
      // Players enrolled under these rules and on this map: only the rest may change.
      const locked = Object.keys(body).filter(
        (key) => !(OPEN_EDITABLE as readonly string[]).includes(key),
      );
      if (locked.length > 0) {
        throw conflict(
          "MATCH_LOCKED",
          `Cannot change ${locked.join(", ")} once registrations are open`,
        );
      }
      if (body.maxPlayers !== undefined && body.maxPlayers < match._count.empires) {
        throw conflict("TOO_FEW_SEATS", "There are already more players than that");
      }
      if (body.startAt && body.startAt <= this.now()) {
        throw conflict("START_IN_PAST", "The start must be in the future");
      }
    }
    if (body.areaIds) await this.assertAreas(body.areaIds);

    await this.prisma.$transaction(async (tx) => {
      const { areaIds, config, ...fields } = body;
      await tx.match.update({
        where: { id },
        data: {
          ...fields,
          ...(config ? { config: resolveMatchRules({ ...rulesOf(match), ...config }) } : {}),
          ...(areaIds
            ? {
                areas: {
                  deleteMany: {},
                  create: [...new Set(areaIds)].map((areaId) => ({ areaId })),
                },
              }
            : {}),
        },
      });
      // A new date needs its own start job; the old one finds the date moved and does nothing.
      if (match.status === "OPEN" && body.startAt) await this.scheduleStart(tx, id, body.startAt);
    });
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

  /**
   * Opens registrations: creates one game territory per municipality of the
   * chosen areas, each with its hidden starting resources, and schedules the start.
   */
  async open(id: string, viewer: AuthContext) {
    const match = await this.owned(id, viewer);
    if (match.status !== "DRAFT") throw conflict("NOT_A_DRAFT", "Registrations are already open");
    if (match.startAt <= this.now()) {
      throw conflict("START_IN_PAST", "The start must be in the future");
    }
    const rules = rulesOf(match);
    const units = await this.prisma.$queryRaw<{ id: number; name: string }[]>(
      unitsOfAreas(match.areas.map((entry) => entry.area.id)),
    );
    if (units.length < 2) throw conflict("NO_UNITS", "The chosen areas have no municipalities");

    const territories = units.map((unit) => ({
      id: randomUUID(),
      matchId: id,
      name: unit.name,
      // Drawn here, on the server, and never sent to a client before the
      // municipality is acquired.
      resources: drawHiddenResources(rules, this.random),
      geoUnitId: unit.id,
    }));

    await this.prisma.$transaction(
      async (tx) => {
        // Only one request can open the match.
        const { count } = await tx.match.updateMany({
          where: { id, status: "DRAFT" },
          data: { status: "OPEN" },
        });
        if (count === 0) throw conflict("NOT_A_DRAFT", "Registrations are already open");

        const chunk = 2000;
        for (let start = 0; start < territories.length; start += chunk) {
          const slice = territories.slice(start, start + chunk);
          await tx.territory.createMany({
            data: slice.map(({ geoUnitId: _geoUnitId, ...territory }) => territory),
          });
          await tx.territoryUnit.createMany({
            data: slice.map((territory) => ({
              matchId: id,
              territoryId: territory.id,
              geoUnitId: territory.geoUnitId,
            })),
          });
        }
        await recordEvent(tx, id, 0, { type: "MATCH_OPENED" });
        await this.scheduleStart(tx, id, match.startAt);
      },
      { timeout: 60_000 },
    );
    this.onChange(id, "match");
    return this.get(id, viewer);
  }

  /** Only a draft can be deleted: nobody else has seen it. */
  async remove(id: string, viewer: AuthContext) {
    const match = await this.owned(id, viewer);
    if (match.status !== "DRAFT") throw conflict("NOT_A_DRAFT", "Only a draft can be deleted");
    await this.prisma.match.delete({ where: { id } });
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
   * Enrols the viewer: the chosen municipality becomes the capital of a new
   * empire. Whoever arrives first gets it (PROMPT §9 #5).
   */
  async join(id: string, body: z.infer<typeof joinBody>, viewer: AuthContext) {
    await this.visible(id, viewer);
    await this.prisma.$transaction(async (tx) => {
      // Joins of one match run one at a time: seats, names and colours are checked safely.
      const rows = await tx.$queryRaw<Match[]>`SELECT * FROM "Match" WHERE id = ${id} FOR UPDATE`;
      const match = rows[0];
      if (!match) throw notFound("Match");
      const rules = rulesOf(match);

      if (match.status !== "OPEN" && !(match.status === "RUNNING" && rules.lateJoin)) {
        throw conflict("REGISTRATION_CLOSED", "This match does not accept players");
      }
      if (match.inviteCode !== null && body.inviteCode !== match.inviteCode) {
        throw new AppError(403, "INVITE_CODE_REQUIRED", "Wrong or missing invite code");
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
    });
    this.onChange(id, "empires");
    return this.state(id, viewer);
  }

  /** Name, colour, emblem and motto can change only before the match starts (PROMPT §9 #14). */
  async updateEmpire(id: string, body: z.infer<typeof empireBody>, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Match[]>`SELECT * FROM "Match" WHERE id = ${id} FOR UPDATE`;
      const match = rows[0];
      if (!match || match.status === "DRAFT") throw notFound("Match");
      const empire = await tx.empire.findFirst({ where: { matchId: id, userId: viewer.user.id } });
      if (!empire) throw notFound("Empire");
      if (match.status !== "OPEN") {
        throw conflict("MATCH_STARTED", "The empire cannot be changed after the start");
      }
      await this.assertIdentityFree(tx, id, body, empire.id);
      await tx.empire.update({ where: { id: empire.id }, data: body });
    });
    this.onChange(id, "empires");
    return this.state(id, viewer);
  }

  /**
   * Everything the viewer may see of a match. Resources appear only on the
   * viewer's own territories: for everyone else the field is null, and free
   * territories are not listed at all, so hidden amounts never leave the server.
   */
  async state(id: string, viewer: Viewer) {
    const match = await this.visible(id, viewer);
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
          user: { select: { username: true } },
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
    const mine = empires.find((empire) => empire.userId === viewer?.user.id) ?? null;
    const currentTurn = Math.max(match.currentTurn, 1);
    const rules = rulesOf(match);

    // Open battles are public (a territory under attack is marked on the map for
    // everyone). The battles just resolved are shown to their two sides only.
    const battles = await this.prisma.battle.findMany({
      where: {
        matchId: id,
        OR: [
          { status: "OPEN" },
          ...(mine
            ? [
                {
                  status: "RESOLVED" as const,
                  turn: { gte: match.currentTurn - 1 },
                  OR: [{ attackerEmpireId: mine.id }, { defenderEmpireId: mine.id }],
                },
              ]
            : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      include: { sources: { select: { territoryId: true, cost: true } } },
    });
    const territoryNames = new Map(
      (
        await this.prisma.territory.findMany({
          where: { id: { in: battles.map((battle) => battle.targetTerritoryId) } },
          select: { id: true, name: true },
        })
      ).map((territory) => [territory.id, territory.name]),
    );
    const unitsOf = (empireId: string) =>
      territories
        .filter((territory) => territory.ownerEmpireId === empireId)
        .reduce((sum, territory) => sum + territory.units.length, 0);

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

    const targets = new Set(
      battles.filter((battle) => battle.status === "OPEN").map((b) => b.targetTerritoryId),
    );

    return {
      match: summary(match, viewer),
      me: mine
        ? {
            empireId: mine.id,
            /** Annexations still available this turn. */
            annexLeft: Math.max(0, rules.annexPerTurn - mine.annexedThisTurn),
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
          annexedThisTurn: _annexed,
          allocationMode: _mode,
          lastCapitalMoveTurn: _moved,
          ...empire
        }) => ({
          ...empire,
          username: user.username,
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
        return {
          id: territory.id,
          name: territory.name,
          ownerEmpireId: territory.ownerEmpireId,
          geoUnitIds: territory.units.map((unit) => unit.geoUnitId),
          isArea: territory.isArea,
          protected: (territory.protectedUntilTurn ?? 0) >= currentTurn,
          // Hidden from everyone but the owner: null, never the number.
          resources: own ? territory.resources : null,
          weight: own ? territory.weight : null,
          /** Accumulation alert: public, and it never says how much is there. */
          alert: territory.alert,
          /**
           * The open battle it is involved in. A target is marked for everyone; which
           * territories an attack starts from is known to the attacker alone.
           */
          battleId:
            territory.battleLock && (own || targets.has(territory.id))
              ? territory.battleLock.battleId
              : null,
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
          // Each side sees its own numbers and never the other's: forces, costs
          // and rolls of the opponent would give away its hidden resources.
          ...(role === "attacker"
            ? {
                fromTerritoryIds: battle.sources.map((source) => source.territoryId),
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
        };
      }),
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
      })),
      online: {
        connected: this.matchOnline(id),
        total: empires.filter((empire) => empire.status === "ACTIVE").length,
      },
    };
  }
}

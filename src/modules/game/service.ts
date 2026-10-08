import { Prisma, type Empire, type Match, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AuthContext } from "../../auth/sessions.js";
import { recordEvent } from "../../events/events.js";
import { AppError, notFound } from "../../http/errors.js";
import type { MatchRules } from "../../rules/config.js";
import { rulesOf, type MatchService } from "../matches/service.js";

type Tx = Prisma.TransactionClient;
type Viewer = AuthContext | null;

const conflict = (code: string, message: string) => new AppError(409, code, message);

/** Every action names the turn it was decided in: a turn that closed meanwhile refuses it. */
const turn = z.number().int().min(1);

export const annexBody = z.strictObject({
  /** The free municipality to annex. */
  geoUnitId: z.number().int().positive(),
  /** The own territory, adjacent to the target, that pays the cost. */
  payFromTerritoryId: z.string().min(1),
  turn,
});

export const allocateBody = z.strictObject({
  /** New amount for each listed territory; their total must not change. */
  amounts: z.record(z.string().min(1), z.number().int().min(0)),
  turn,
});

export const allocationRuleBody = z.strictObject({
  mode: z.enum(["EQUAL", "WEIGHTED"]),
  /** Weight of each territory in the split of the income, for the weighted mode. */
  weights: z.record(z.string().min(1), z.number().int().min(0).max(1_000_000)).optional(),
});

interface Neighbour {
  geoUnitId: number;
  name: string;
  territoryId: string;
  ownerEmpireId: string | null;
}

/**
 * The immediate actions of the game. Each one runs in a transaction that
 * holds the match row shared (a closing turn takes it exclusively, so an
 * action never straddles two turns) and the player's empire exclusively
 * (so two actions of the same player never overlap).
 */
export class GameService {
  /** Called after a change that the followers of a match should see. */
  onChange: (matchId: string, kind: string) => void = () => undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly matches: MatchService,
  ) {}

  /**
   * Municipalities adjacent to a territory, with the territory each belongs
   * to. Adjacency of a match is derived from the adjacency of municipalities:
   * a territory borders whatever any of its municipalities borders.
   */
  private neighbours(db: Tx | PrismaClient, matchId: string, territoryId: string) {
    return db.$queryRaw<Neighbour[]>`
      WITH own AS (
        SELECT "geoUnitId" FROM "TerritoryUnit" WHERE "territoryId" = ${territoryId}
      ), adjacent AS (
        SELECT "bId" AS id FROM "GeoAdjacency" WHERE "aId" IN (SELECT "geoUnitId" FROM own)
        UNION
        SELECT "aId" FROM "GeoAdjacency" WHERE "bId" IN (SELECT "geoUnitId" FROM own)
      )
      SELECT u.id AS "geoUnitId", u.name, t.id AS "territoryId", t."ownerEmpireId"
      FROM adjacent
      JOIN "TerritoryUnit" tu ON tu."matchId" = ${matchId} AND tu."geoUnitId" = adjacent.id
      JOIN "Territory" t ON t.id = tu."territoryId"
      JOIN "GeoUnit" u ON u.id = adjacent.id
      WHERE t.id <> ${territoryId}
      ORDER BY u.name`;
  }

  /**
   * The card of a municipality: who owns it, its neighbours and, for a
   * player looking at a free neighbour, how it can be annexed.
   */
  async unit(matchId: string, geoUnitId: number, viewer: Viewer) {
    const match = await this.matches.get(matchId, viewer);
    const unit = await this.prisma.territoryUnit.findUnique({
      where: { matchId_geoUnitId: { matchId, geoUnitId } },
      select: {
        geoUnit: { select: { name: true } },
        territory: {
          select: {
            id: true,
            name: true,
            ownerEmpireId: true,
            resources: true,
            protectedUntilTurn: true,
            battleLock: { select: { battleId: true } },
          },
        },
      },
    });
    if (!unit) throw notFound("Municipality");
    const { territory } = unit;

    const [neighbours, mine] = await Promise.all([
      this.neighbours(this.prisma, matchId, territory.id),
      viewer
        ? this.prisma.empire.findFirst({
            where: { matchId, userId: viewer.user.id, status: "ACTIVE" },
          })
        : null,
    ]);
    const own = mine !== null && territory.ownerEmpireId === mine.id;
    const rules = match.config as MatchRules;

    let annex = null;
    if (mine && match.status === "RUNNING" && territory.ownerEmpireId === null) {
      // The player's territories that touch this one and could pay for it.
      const ids = [
        ...new Set(neighbours.filter((n) => n.ownerEmpireId === mine.id).map((n) => n.territoryId)),
      ];
      const payers = await this.prisma.territory.findMany({
        where: { id: { in: ids } },
        orderBy: { resources: "desc" },
        select: {
          id: true,
          name: true,
          resources: true,
          battleLock: { select: { battleId: true } },
        },
      });
      annex = {
        cost: rules.annexCost,
        left: Math.max(0, rules.annexPerTurn - mine.annexedThisTurn),
        payFrom: payers.map((payer) => ({
          territoryId: payer.id,
          name: payer.name,
          resources: payer.resources,
          usable: payer.battleLock === null && payer.resources >= rules.annexCost,
        })),
      };
    }

    return {
      geoUnitId,
      name: unit.geoUnit.name,
      territory: {
        id: territory.id,
        name: territory.name,
        ownerEmpireId: territory.ownerEmpireId,
        protected: (territory.protectedUntilTurn ?? 0) >= Math.max(match.currentTurn, 1),
        inBattle: territory.battleLock !== null,
        // Only the owner sees the amount; for anyone else it is hidden, free territories included.
        resources: own ? territory.resources : null,
      },
      neighbours,
      annex,
    };
  }

  /** Locks what an action needs and checks that the viewer can act now. */
  private async acting(tx: Tx, matchId: string, viewer: AuthContext, decidedInTurn: number) {
    const matches = await tx.$queryRaw<Match[]>`
      SELECT * FROM "Match" WHERE id = ${matchId} FOR SHARE`;
    const match = matches[0];
    if (!match || match.status === "DRAFT") throw notFound("Match");
    if (match.status !== "RUNNING") {
      throw conflict("MATCH_NOT_RUNNING", "The match is not being played");
    }
    if (match.currentTurn !== decidedInTurn) {
      throw conflict("TURN_CHANGED", "The turn has changed: look at the map again");
    }
    const empires = await tx.$queryRaw<Empire[]>`
      SELECT * FROM "Empire" WHERE "matchId" = ${matchId} AND "userId" = ${viewer.user.id} FOR UPDATE`;
    const empire = empires[0];
    if (!empire) throw new AppError(403, "NOT_A_PLAYER", "You have no empire in this match");
    if (empire.status !== "ACTIVE") throw conflict("EMPIRE_FALLEN", "Your empire has fallen");
    return { match, empire, rules: rulesOf(match) };
  }

  /**
   * Annexes a free municipality adjacent to the empire (PROMPT §2.3, §2.4).
   * The effect is immediate; the fixed cost is paid by an own territory
   * adjacent to the target.
   */
  async annex(matchId: string, body: z.infer<typeof annexBody>, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire, rules } = await this.acting(tx, matchId, viewer, body.turn);
      if (empire.annexedThisTurn >= rules.annexPerTurn) {
        throw conflict("ANNEX_LIMIT", "No annexations left this turn");
      }

      const target = await tx.territoryUnit.findUnique({
        where: { matchId_geoUnitId: { matchId, geoUnitId: body.geoUnitId } },
        select: { territory: { select: { id: true, name: true, ownerEmpireId: true } } },
      });
      if (!target) throw notFound("Municipality");
      if (target.territory.ownerEmpireId !== null) {
        throw conflict("TERRITORY_TAKEN", "This municipality belongs to an empire");
      }

      const payer = await tx.territory.findFirst({
        where: { id: body.payFromTerritoryId, matchId, ownerEmpireId: empire.id },
        select: { id: true, battleLock: { select: { battleId: true } } },
      });
      if (!payer)
        throw conflict("NOT_YOUR_TERRITORY", "You can pay only from your own territories");
      const adjacent = await this.neighbours(tx, matchId, payer.id);
      if (!adjacent.some((n) => n.territoryId === target.territory.id)) {
        throw conflict("NOT_ADJACENT", "The paying territory does not border the target");
      }
      if (payer.battleLock) {
        throw conflict("TERRITORY_IN_BATTLE", "A territory in a battle cannot spend resources");
      }

      // Both updates are conditional, so concurrent requests cannot overdraw a
      // territory or give one municipality to two empires. The loser's whole
      // transaction rolls back: it pays nothing (PROMPT §9 #3).
      const paid = await tx.territory.updateMany({
        where: { id: payer.id, resources: { gte: rules.annexCost } },
        data: { resources: { decrement: rules.annexCost } },
      });
      if (paid.count === 0) {
        throw conflict("NOT_ENOUGH_RESOURCES", "The paying territory cannot afford the annexation");
      }
      const taken = await tx.territory.updateMany({
        where: { id: target.territory.id, ownerEmpireId: null },
        data: {
          ownerEmpireId: empire.id,
          // Just acquired: it cannot be attacked until this turn ends. The resources
          // it already holds (its hidden endowment) stay on it and are now the empire's.
          protectedUntilTurn: match.currentTurn,
        },
      });
      if (taken.count === 0) {
        throw conflict("TERRITORY_TAKEN", "Another empire annexed it first");
      }
      await tx.empire.update({
        where: { id: empire.id },
        data: { annexedThisTurn: { increment: 1 } },
      });
      await recordEvent(tx, matchId, match.currentTurn, {
        type: "ANNEXED",
        empireId: empire.id,
        territoryId: target.territory.id,
        data: { empireName: empire.name, territoryName: target.territory.name },
      });
    });
    this.onChange(matchId, "territories");
    return this.matches.state(matchId, viewer);
  }

  /**
   * Moves resources between the player's own territories: the body gives the
   * new amount of some of them, and their total must stay the same, because
   * an empire has no treasury outside its territories (PROMPT §2.4).
   */
  async allocate(matchId: string, body: z.infer<typeof allocateBody>, viewer: AuthContext) {
    const ids = Object.keys(body.amounts);
    if (ids.length === 0) return this.matches.state(matchId, viewer);

    await this.prisma.$transaction(async (tx) => {
      const { empire } = await this.acting(tx, matchId, viewer, body.turn);
      const territories = await tx.$queryRaw<{ id: string; resources: number; locked: boolean }[]>`
        SELECT t.id, t.resources,
          EXISTS (SELECT 1 FROM "BattleLock" l WHERE l."territoryId" = t.id) AS locked
        FROM "Territory" t
        WHERE t.id IN (${Prisma.join(ids)}) AND t."ownerEmpireId" = ${empire.id}
        ORDER BY t.id FOR UPDATE OF t`;
      if (territories.length !== ids.length) {
        throw conflict(
          "NOT_YOUR_TERRITORY",
          "You can move resources only between your own territories",
        );
      }
      if (territories.some((territory) => territory.locked)) {
        throw conflict(
          "TERRITORY_IN_BATTLE",
          "Resources of a territory in a battle cannot be moved",
        );
      }
      const before = territories.reduce((sum, territory) => sum + territory.resources, 0);
      const after = ids.reduce((sum, id) => sum + (body.amounts[id] ?? 0), 0);
      if (before !== after) {
        throw conflict("ALLOCATION_SUM", `The total must stay ${before}, not ${after}`);
      }
      for (const territory of territories) {
        const amount = body.amounts[territory.id] ?? 0;
        if (amount !== territory.resources) {
          await tx.territory.update({ where: { id: territory.id }, data: { resources: amount } });
        }
      }
    });
    this.onChange(matchId, "resources");
    return this.matches.state(matchId, viewer);
  }

  /**
   * Sets how each turn's income is split among the empire's territories:
   * in equal parts, or in proportion to a weight per territory.
   */
  async setAllocationRule(
    matchId: string,
    body: z.infer<typeof allocationRuleBody>,
    viewer: AuthContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const empire = await tx.empire.findFirst({
        where: { matchId, userId: viewer.user.id, status: "ACTIVE" },
      });
      if (!empire) throw new AppError(403, "NOT_A_PLAYER", "You have no empire in this match");
      const weights = Object.entries(body.weights ?? {});
      const owned = await tx.territory.count({
        where: { id: { in: weights.map(([id]) => id) }, ownerEmpireId: empire.id },
      });
      if (owned !== weights.length) {
        throw conflict("NOT_YOUR_TERRITORY", "You can weigh only your own territories");
      }
      await tx.empire.update({ where: { id: empire.id }, data: { allocationMode: body.mode } });
      for (const [id, weight] of weights) {
        await tx.territory.update({ where: { id }, data: { weight } });
      }
    });
    this.onChange(matchId, "resources");
    return this.matches.state(matchId, viewer);
  }
}

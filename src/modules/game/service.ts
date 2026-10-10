import { phaseOf } from "../../rules/phases.js";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AuthContext } from "../../auth/sessions.js";
import { recordEvent } from "../../events/events.js";
import { AppError, notFound } from "../../http/errors.js";
import type { MatchRules } from "../../rules/config.js";
import type { MatchService } from "../matches/service.js";
import { areAllies } from "./alliances.js";
import {
  acting,
  annexFunding,
  capitalsOf,
  conflict,
  lockTerritories,
  neighboursOf,
  placesOf,
} from "./shared.js";

type Viewer = AuthContext | null;

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

export const capitalBody = z.strictObject({
  /** The own territory that becomes the capital. */
  territoryId: z.string().min(1),
  turn,
});

export const allocationRuleBody = z.strictObject({
  mode: z.enum(["EQUAL", "WEIGHTED"]),
  /** Weight of each territory in the split of the income, for the weighted mode. */
  weights: z.record(z.string().min(1), z.number().int().min(0).max(1_000_000)).optional(),
});

/** How far from a territory its neighbour's border still counts as shared: some sixty metres. */
const FRONT_REACH_DEGREES = 0.0006;

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
   * The fronts of the open battles: for each, the stretch of border between the
   * territory under attack and the territories the attack starts from, as lines
   * for the map to draw. Battles are public, and so are their fronts.
   */
  async fronts(matchId: string, viewer: Viewer) {
    await this.matches.get(matchId, viewer);
    // The border of the target that lies along a source: the two outlines rarely share
    // their points exactly, so a narrow strip around the source says what "along" is.
    const rows = await this.prisma.$queryRaw<{ battleId: string; line: string | null }[]>`
      SELECT b.id AS "battleId",
        ST_AsGeoJSON(ST_LineMerge(ST_Union(ST_CollectionExtract(
          ST_Intersection(ST_Boundary(target.geom), ST_Buffer(source.geom, ${FRONT_REACH_DEGREES})), 2
        ))), 5) AS line
      FROM "Battle" b
      JOIN "BattleSource" s ON s."battleId" = b.id
      JOIN "TerritoryUnit" tt ON tt."territoryId" = b."targetTerritoryId"
      JOIN "TerritoryUnit" ts ON ts."territoryId" = s."territoryId"
      JOIN "GeoAdjacency" a
        ON (a."aId" = tt."geoUnitId" AND a."bId" = ts."geoUnitId")
        OR (a."bId" = tt."geoUnitId" AND a."aId" = ts."geoUnitId")
      JOIN "GeoUnit" target ON target.id = tt."geoUnitId"
      JOIN "GeoUnit" source ON source.id = ts."geoUnitId"
      WHERE b."matchId" = ${matchId} AND b.status = 'OPEN'
      GROUP BY b.id`;
    return {
      type: "FeatureCollection" as const,
      features: rows.flatMap((row) =>
        row.line
          ? [
              {
                type: "Feature" as const,
                id: row.battleId,
                geometry: JSON.parse(row.line) as unknown,
                properties: { battleId: row.battleId },
              },
            ]
          : [],
      ),
    };
  }

  /**
   * The territories the viewer could attack right now: those of other empires
   * that touch one of theirs, are not allied, protected, blocked or already in
   * a battle, and that at least one of their own territories can strike from.
   * It is what the unit card says one territory at a time, for the whole border
   * at once: the map marks them. With them, the free municipalities that can be annexed
   * now: they touch an own territory that can pay, and the turn still allows it.
   * Empty for who is not playing.
   */
  async targets(
    matchId: string,
    viewer: Viewer,
  ): Promise<{ territoryIds: string[]; annexUnitIds: number[] }> {
    const match = await this.matches.get(matchId, viewer);
    const mine = viewer
      ? await this.prisma.empire.findFirst({
          where: { matchId, userId: viewer.user.id, status: "ACTIVE" },
        })
      : null;
    // Nothing is attacked while the turn is in its preliminary part.
    if (!mine || match.status !== "ONGOING" || phaseOf(match) !== "ACTION") {
      return { territoryIds: [], annexUnitIds: [] };
    }
    const rules = match.config as MatchRules;

    const [alliances, structures] = await Promise.all([
      this.prisma.alliance.findMany({
        where: { matchId, OR: [{ aEmpireId: mine.id }, { bEmpireId: mine.id }] },
        select: { aEmpireId: true, bEmpireId: true },
      }),
      this.prisma.structure.findMany({
        where: { matchId, active: true },
        select: { territoryId: true, data: true },
      }),
    ]);
    const spared = [
      mine.id,
      ...alliances.map((pact) => (pact.aEmpireId === mine.id ? pact.bEmpireId : pact.aEmpireId)),
    ];
    const withEffect = (effect: string) => [
      // Never an empty list: it is compared against in the query.
      "",
      ...structures
        .filter((structure) =>
          ((structure.data as { effects?: string[] }).effects ?? []).includes(effect),
        )
        .map((structure) => structure.territoryId),
    ];
    const declared = await this.prisma.battle.count({
      where: { matchId, attackerEmpireId: mine.id, turn: match.currentTurn },
    });
    const rows =
      declared >= rules.attacksPerTurn
        ? []
        : await this.prisma.$queryRaw<{ id: string }[]>`
      WITH edges AS (
        SELECT "aId" AS x, "bId" AS y FROM "GeoAdjacency"
        UNION ALL SELECT "bId", "aId" FROM "GeoAdjacency"
      ), sources AS (
        SELECT tu."geoUnitId" AS unit
        FROM "Territory" t JOIN "TerritoryUnit" tu ON tu."territoryId" = t.id
        WHERE t."matchId" = ${matchId} AND t."ownerEmpireId" = ${mine.id} AND t.resources >= 1
          AND t.id <> ALL(${withEffect("NO_ATTACK_FROM")})
          AND NOT EXISTS (SELECT 1 FROM "BattleLock" l WHERE l."territoryId" = t.id)
      )
      SELECT DISTINCT t.id
      FROM sources s
      JOIN edges e ON e.x = s.unit
      JOIN "TerritoryUnit" tu ON tu."matchId" = ${matchId} AND tu."geoUnitId" = e.y
      JOIN "Territory" t ON t.id = tu."territoryId"
      WHERE t."ownerEmpireId" IS NOT NULL AND t."ownerEmpireId" <> ALL(${spared})
        AND COALESCE(t."protectedUntilTurn", 0) < ${Math.max(match.currentTurn, 1)}
        AND t.id <> ALL(${withEffect("NO_ATTACK_ON")})
        AND NOT EXISTS (SELECT 1 FROM "BattleLock" l WHERE l."territoryId" = t.id)`;
    // Who can pay for an annexation: alone, or with the capital nearest to it.
    const payerIds: string[] = [];
    if (mine.annexedThisTurn < rules.annexPerTurn) {
      const [own, capitals] = await Promise.all([
        this.prisma.territory.findMany({
          where: { matchId, ownerEmpireId: mine.id },
          select: { id: true, resources: true, battleLock: { select: { battleId: true } } },
        }),
        capitalsOf(this.prisma, matchId, mine.id),
      ]);
      const places = await placesOf(
        this.prisma,
        own.map((territory) => territory.id),
      );
      for (const territory of own) {
        const payer = {
          id: territory.id,
          resources: territory.resources,
          inBattle: territory.battleLock !== null,
          ...(places.get(territory.id) ?? { lon: 0, lat: 0 }),
        };
        if (annexFunding(payer, capitals, rules.annexCost)) payerIds.push(territory.id);
      }
    }
    const free =
      payerIds.length === 0
        ? []
        : await this.prisma.$queryRaw<{ id: number }[]>`
      WITH edges AS (
        SELECT "aId" AS x, "bId" AS y FROM "GeoAdjacency"
        UNION ALL SELECT "bId", "aId" FROM "GeoAdjacency"
      ), payers AS (
        SELECT tu."geoUnitId" AS unit
        FROM "Territory" t JOIN "TerritoryUnit" tu ON tu."territoryId" = t.id
        WHERE t.id = ANY(${payerIds})
      )
      SELECT DISTINCT tu."geoUnitId" AS id
      FROM payers p
      JOIN edges e ON e.x = p.unit
      JOIN "TerritoryUnit" tu ON tu."matchId" = ${matchId} AND tu."geoUnitId" = e.y
      JOIN "Territory" t ON t.id = tu."territoryId"
      WHERE t."ownerEmpireId" IS NULL`;
    return {
      territoryIds: rows.map((row) => row.id),
      // By municipality, not by territory: the free ones are not in the state of the match.
      annexUnitIds: free.map((row) => row.id),
    };
  }

  /**
   * The outline of each territory of the viewer's empire, with a point inside it: the
   * small map their resources are balanced on. Nothing that is not already on the map.
   */
  async shapes(matchId: string, viewer: Viewer) {
    await this.matches.get(matchId, viewer);
    const mine = viewer
      ? await this.prisma.empire.findFirst({
          where: { matchId, userId: viewer.user.id, status: "ACTIVE" },
        })
      : null;
    if (!mine) return { territories: [] };
    const rows = await this.prisma.$queryRaw<
      { id: string; shape: string; lon: number; lat: number; frontier: boolean }[]
    >`
      SELECT t.id,
        EXISTS (
          SELECT 1 FROM "TerritoryUnit" own
          JOIN "GeoAdjacency" a ON own."geoUnitId" IN (a."aId", a."bId")
          JOIN "TerritoryUnit" beside ON beside."matchId" = ${matchId}
            AND beside."geoUnitId" = CASE WHEN a."aId" = own."geoUnitId" THEN a."bId" ELSE a."aId" END
          JOIN "Territory" n ON n.id = beside."territoryId"
          WHERE own."territoryId" = t.id AND n."ownerEmpireId" IS DISTINCT FROM ${mine.id}
        ) AS frontier,
        ST_AsGeoJSON(ST_Union(u."geomSimple"), 4) AS shape,
        ST_X(ST_PointOnSurface(ST_Union(u."geomSimple"))) AS lon,
        ST_Y(ST_PointOnSurface(ST_Union(u."geomSimple"))) AS lat
      FROM "Territory" t
      JOIN "TerritoryUnit" tu ON tu."territoryId" = t.id
      JOIN "GeoUnit" u ON u.id = tu."geoUnitId"
      WHERE t."matchId" = ${matchId} AND t."ownerEmpireId" = ${mine.id}
      GROUP BY t.id`;
    return {
      territories: rows.map((row) => ({
        id: row.id,
        geometry: JSON.parse(row.shape) as unknown,
        lon: row.lon,
        lat: row.lat,
        /** It touches something that is not the empire's: where an attack can come from. */
        frontier: row.frontier,
      })),
    };
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
      neighboursOf(this.prisma, matchId, territory.id),
      viewer
        ? this.prisma.empire.findFirst({
            where: { matchId, userId: viewer.user.id, status: "ACTIVE" },
          })
        : null,
    ]);
    const own = mine !== null && territory.ownerEmpireId === mine.id;
    const ally =
      mine !== null &&
      territory.ownerEmpireId !== null &&
      !own &&
      (await areAllies(this.prisma, mine.id, territory.ownerEmpireId));
    const rules = match.config as MatchRules;

    let annex = null;
    if (mine && match.status === "ONGOING" && territory.ownerEmpireId === null) {
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
      const [capitals, places] = await Promise.all([
        capitalsOf(this.prisma, matchId, mine.id),
        placesOf(this.prisma, ids),
      ]);
      const fundingOf = (payer: (typeof payers)[number]) =>
        annexFunding(
          {
            id: payer.id,
            resources: payer.resources,
            inBattle: payer.battleLock !== null,
            ...(places.get(payer.id) ?? { lon: 0, lat: 0 }),
          },
          capitals,
          rules.annexCost,
        );
      annex = {
        cost: rules.annexCost,
        left: Math.max(0, rules.annexPerTurn - mine.annexedThisTurn),
        payFrom: payers.map((payer) => ({
          territoryId: payer.id,
          name: payer.name,
          resources: payer.resources,
          usable: fundingOf(payer) !== null,
          /** What the nearest capital adds, when the territory alone cannot pay. */
          fromCapital: fundingOf(payer)?.fromCapital ?? 0,
        })),
      };
    }

    // A player looking at an enemy territory: can it be attacked, and from where.
    let attack = null;
    if (mine && match.status === "ONGOING" && territory.ownerEmpireId && !own && !ally) {
      const ids = [
        ...new Set(neighbours.filter((n) => n.ownerEmpireId === mine.id).map((n) => n.territoryId)),
      ];
      const sources = await this.prisma.territory.findMany({
        where: { id: { in: ids } },
        orderBy: { resources: "desc" },
        select: {
          id: true,
          name: true,
          resources: true,
          battleLock: { select: { battleId: true } },
        },
      });
      const isProtected = (territory.protectedUntilTurn ?? 0) >= Math.max(match.currentTurn, 1);
      const blocking = await this.prisma.structure.findMany({
        where: { matchId, active: true, territoryId: { in: [territory.id, ...ids] } },
        select: { territoryId: true, data: true },
      });
      const has = (territoryId: string, effect: string) =>
        blocking.some(
          (structure) =>
            structure.territoryId === territoryId &&
            ((structure.data as { effects?: string[] }).effects ?? []).includes(effect),
        );
      attack = {
        /** Attacks the empire can still declare this turn. */
        left: Math.max(
          0,
          rules.attacksPerTurn -
            (await this.prisma.battle.count({
              where: { matchId, attackerEmpireId: mine.id, turn: match.currentTurn },
            })),
        ),
        /** Why the territory cannot be attacked now, if so. */
        blocked: isProtected
          ? ("PROTECTED" as const)
          : has(territory.id, "NO_ATTACK_ON")
            ? ("BLOCKED" as const)
            : territory.battleLock
              ? ("IN_BATTLE" as const)
              : sources.length === 0
                ? ("NOT_ADJACENT" as const)
                : null,
        from: sources.map((source) => ({
          territoryId: source.id,
          name: source.name,
          resources: source.resources,
          usable:
            source.battleLock === null &&
            source.resources >= 1 &&
            !has(source.id, "NO_ATTACK_FROM"),
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
        // Only the owner and its allies see the amount; for anyone else it is hidden,
        // free territories included.
        resources: own || ally ? territory.resources : null,
      },
      neighbours,
      annex,
      attack,
    };
  }

  /**
   * Annexes a free municipality adjacent to the empire (PROMPT §2.3, §2.4).
   * The effect is immediate; the fixed cost is paid by an own territory
   * adjacent to the target.
   */
  async annex(matchId: string, body: z.infer<typeof annexBody>, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire, rules } = await acting(tx, matchId, viewer, body.turn, "ACTION");
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

      // Locked before they are read, the capitals that may help with it: an attack on
      // one of them that commits meanwhile is seen here.
      const capitals = await capitalsOf(tx, matchId, empire.id);
      const locked = await lockTerritories(tx, matchId, [
        body.payFromTerritoryId,
        ...capitals.map((capital) => capital.id),
      ]);
      const payer = locked.find((territory) => territory.id === body.payFromTerritoryId);
      if (payer?.ownerEmpireId !== empire.id) {
        throw conflict("NOT_YOUR_TERRITORY", "You can pay only from your own territories");
      }
      const adjacent = await neighboursOf(tx, matchId, payer.id);
      if (!adjacent.some((n) => n.territoryId === target.territory.id)) {
        throw conflict("NOT_ADJACENT", "The paying territory does not border the target");
      }
      if (payer.inBattle) {
        throw conflict("TERRITORY_IN_BATTLE", "A territory in a battle cannot spend resources");
      }

      // Both updates are conditional, so concurrent requests cannot overdraw a
      // territory or give one municipality to two empires. The loser's whole
      // transaction rolls back: it pays nothing (PROMPT §9 #3).
      // What the territory lacks comes from the capital nearest to it.
      const place = (await placesOf(tx, [payer.id])).get(payer.id) ?? { lon: 0, lat: 0 };
      const funding = annexFunding(
        { ...payer, ...place },
        capitals.map((capital) => {
          const now = locked.find((territory) => territory.id === capital.id);
          return now ? { ...capital, resources: now.resources, inBattle: now.inBattle } : capital;
        }),
        rules.annexCost,
      );
      if (!funding) {
        throw conflict(
          "NOT_ENOUGH_RESOURCES",
          "Neither the paying territory nor the nearest capital can afford the annexation",
        );
      }
      for (const [id, amount] of [
        [payer.id, funding.fromPayer],
        [funding.capitalId, funding.fromCapital],
      ] as const) {
        if (!id || amount === 0) continue;
        const paid = await tx.territory.updateMany({
          where: { id, resources: { gte: amount } },
          data: { resources: { decrement: amount } },
        });
        if (paid.count === 0) {
          throw conflict("NOT_ENOUGH_RESOURCES", "The annexation cannot be paid for any more");
        }
      }
      // In the proportional split of the income the newcomer weighs like the average of
      // the territories the empire already has, so that it gets a share like theirs.
      const weights = await tx.territory.aggregate({
        where: { ownerEmpireId: empire.id },
        _avg: { weight: true },
      });
      const taken = await tx.territory.updateMany({
        where: { id: target.territory.id, ownerEmpireId: null },
        data: {
          ownerEmpireId: empire.id,
          weight: Math.max(1, Math.round(weights._avg.weight ?? 1)),
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
      const { empire } = await acting(tx, matchId, viewer, body.turn, "PRELIMINARY");
      const territories = (await lockTerritories(tx, matchId, ids)).filter(
        (territory) => territory.ownerEmpireId === empire.id,
      );
      if (territories.length !== ids.length) {
        throw conflict(
          "NOT_YOUR_TERRITORY",
          "You can move resources only between your own territories",
        );
      }
      if (territories.some((territory) => territory.inBattle)) {
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

  /**
   * Moves the capital to another territory of the empire (PROMPT §2.9): at
   * most once every `capitalMoveEveryTurns` turns, and not while the old or
   * the new capital is in a battle.
   */
  async moveCapital(matchId: string, body: z.infer<typeof capitalBody>, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire, rules } = await acting(tx, matchId, viewer, body.turn, "PRELIMINARY");
      if (empire.capitalTerritoryId === body.territoryId) {
        throw conflict("ALREADY_CAPITAL", "This territory is already the capital");
      }
      if (
        empire.lastCapitalMoveTurn !== null &&
        match.currentTurn - empire.lastCapitalMoveTurn < rules.capitalMoveEveryTurns
      ) {
        throw conflict("CAPITAL_MOVED_RECENTLY", "The capital cannot move again yet");
      }
      const ids = [
        body.territoryId,
        ...(empire.capitalTerritoryId ? [empire.capitalTerritoryId] : []),
      ];
      const locked = await lockTerritories(tx, matchId, ids);
      const destination = locked.find((territory) => territory.id === body.territoryId);
      if (destination?.ownerEmpireId !== empire.id) {
        throw conflict("NOT_YOUR_TERRITORY", "The capital can move only to your own territory");
      }
      if (locked.some((territory) => territory.inBattle)) {
        throw conflict("TERRITORY_IN_BATTLE", "The capital cannot move during a battle on it");
      }
      await tx.empire.update({
        where: { id: empire.id },
        data: { capitalTerritoryId: destination.id, lastCapitalMoveTurn: match.currentTurn },
      });
      await recordEvent(tx, matchId, match.currentTurn, {
        type: "CAPITAL_MOVED",
        empireId: empire.id,
        territoryId: destination.id,
        data: { empireName: empire.name, territoryName: destination.name },
      });
    });
    this.onChange(matchId, "empires");
    return this.matches.state(matchId, viewer);
  }
}

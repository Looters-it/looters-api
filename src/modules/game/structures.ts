import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AuthContext } from "../../auth/sessions.js";
import { recordEvent } from "../../events/events.js";
import { AppError, notFound } from "../../http/errors.js";
import { turnIncome } from "../../rules/income.js";
import {
  structureBlock,
  structureCatalogue,
  structureDefinition,
  turnsToResources,
  type StructureDefinition,
} from "../../rules/structures.js";
import type { MatchService } from "../matches/service.js";
import { rulesOf } from "../matches/service.js";
import { acting, conflict, lockTerritories, neighboursOf, type Tx } from "./shared.js";

const turn = z.number().int().min(1);

export const buildBody = z.strictObject({
  /** A key of the structure catalogue. */
  type: z.string().min(1).max(40),
  territoryId: z.string().min(1),
  turn,
});
export const moveStructureBody = z.strictObject({ territoryId: z.string().min(1), turn });

const mergeShape = {
  /** Own territories to merge into one area: contiguous, two or more. */
  territoryIds: z.array(z.string().min(1)).min(2).max(50),
  name: z.string().trim().min(2).max(40),
};
export const mergeBody = z.strictObject({ ...mergeShape, turn });
export const mergePreviewBody = z.strictObject({
  territoryIds: z.array(z.string().min(1)).max(50),
});
export const renameBody = z.strictObject({ name: mergeShape.name });

/** Municipalities an empire controls: what its income is counted on. */
async function unitsOfEmpire(tx: Tx | PrismaClient, empireId: string): Promise<number> {
  return tx.territoryUnit.count({ where: { territory: { ownerEmpireId: empireId } } });
}

/**
 * Structures and merged areas (PROMPT §2.10). Structures come from the
 * catalogue in `rules/structures.ts`; this service only applies what the
 * catalogue declares.
 */
export class StructureService {
  onChange: (matchId: string, kind: string) => void = () => undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly matches: MatchService,
  ) {}

  /**
   * The catalogue as a player sees it: for each structure what it costs now
   * and, for each of their territories, whether it can be built there and why not.
   */
  async catalogue(matchId: string, viewer: AuthContext) {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match) throw notFound("Match");
    const empire = await this.prisma.empire.findFirst({
      where: { matchId, userId: viewer.user.id, status: "ACTIVE" },
    });
    if (!empire) throw new AppError(403, "NOT_A_PLAYER", "You have no empire in this match");
    const rules = rulesOf(match);
    const turnValue = turnIncome(rules, await unitsOfEmpire(this.prisma, empire.id));

    const [territories, structures] = await Promise.all([
      this.prisma.territory.findMany({
        where: { ownerEmpireId: empire.id },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          resources: true,
          battleLock: { select: { battleId: true } },
        },
      }),
      this.prisma.structure.findMany({ where: { matchId, empireId: empire.id } }),
    ]);

    return structureCatalogue().map((definition) => {
      const cost = definition.cost(rules, turnValue);
      const mine = structures.filter((s) => s.type === definition.type);
      return {
        type: definition.type,
        cost,
        durationTurns: definition.durationTurns(rules),
        cooldownTurns: definition.cooldownTurns?.(rules) ?? 0,
        effects: definition.effects,
        sites: territories.map((territory) => ({
          territoryId: territory.id,
          name: territory.name,
          resources: territory.resources,
          blocked: structureBlock(
            definition,
            {
              isCapital: territory.id === empire.capitalTerritoryId,
              inBattle: territory.battleLock !== null,
              resources: territory.resources,
              ownedByEmpire: mine.filter((s) => s.active).length,
              activeHere: mine.some((s) => s.active && s.territoryId === territory.id),
              cooldownUntilTurn: Math.max(
                -1,
                ...mine
                  .filter((s) => s.territoryId === territory.id && s.cooldownUntilTurn !== null)
                  .map((s) => s.cooldownUntilTurn ?? -1),
              ),
              currentTurn: match.currentTurn,
            },
            cost,
          ),
        })),
      };
    });
  }

  /** Builds a structure of the catalogue on an own territory, which pays for it. */
  async build(matchId: string, body: z.infer<typeof buildBody>, viewer: AuthContext) {
    const definition = structureDefinition(body.type);
    if (!definition) throw new AppError(400, "UNKNOWN_STRUCTURE", "No such structure");

    await this.prisma.$transaction(async (tx) => {
      const { match, empire, rules } = await acting(tx, matchId, viewer, body.turn, "PRELIMINARY");
      const territory = (await lockTerritories(tx, matchId, [body.territoryId]))[0];
      if (territory?.ownerEmpireId !== empire.id) {
        throw conflict("NOT_YOUR_TERRITORY", "You can build only on your own territories");
      }
      const existing = await tx.structure.findMany({
        where: { matchId, empireId: empire.id, type: definition.type },
      });
      const cost = definition.cost(rules, turnIncome(rules, await unitsOfEmpire(tx, empire.id)));
      const blocked = structureBlock(
        definition,
        {
          isCapital: territory.id === empire.capitalTerritoryId,
          inBattle: territory.inBattle,
          resources: territory.resources,
          ownedByEmpire: existing.filter((s) => s.active).length,
          activeHere: existing.some((s) => s.active && s.territoryId === territory.id),
          cooldownUntilTurn: Math.max(
            -1,
            ...existing
              .filter((s) => s.territoryId === territory.id && s.cooldownUntilTurn !== null)
              .map((s) => s.cooldownUntilTurn ?? -1),
          ),
          currentTurn: match.currentTurn,
        },
        cost,
      );
      if (blocked) throw conflict(`STRUCTURE_${blocked}`, `Cannot build here: ${blocked}`);

      const duration = definition.durationTurns(rules);
      // Built in turn T for N turns: active through turn T + N - 1.
      const expiresTurn = duration === null ? null : match.currentTurn + duration - 1;
      await tx.territory.update({
        where: { id: territory.id },
        data: { resources: { decrement: cost } },
      });
      await tx.structure.create({
        data: {
          matchId,
          territoryId: territory.id,
          empireId: empire.id,
          type: definition.type,
          builtTurn: match.currentTurn,
          expiresTurn,
          cooldownUntilTurn:
            expiresTurn === null ? null : expiresTurn + (definition.cooldownTurns?.(rules) ?? 0),
          // What `jobs` and the battle rules read: effects, never the type.
          data: { effects: definition.effects },
        },
      });
      if (definition.effects.includes("BACKUP_CAPITAL")) {
        await recordEvent(tx, matchId, match.currentTurn, {
          type: "CAPITAL_BUILT",
          empireId: empire.id,
          territoryId: territory.id,
          data: { empireName: empire.name, territoryName: territory.name },
        });
      }
    });
    this.onChange(matchId, "structures");
    return this.matches.state(matchId, viewer);
  }

  /** Moves a movable structure (the second capital) to another own territory, at its own pace. */
  async move(
    matchId: string,
    structureId: string,
    body: z.infer<typeof moveStructureBody>,
    viewer: AuthContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire, rules } = await acting(tx, matchId, viewer, body.turn, "PRELIMINARY");
      const structure = await tx.structure.findFirst({
        where: { id: structureId, matchId, empireId: empire.id, active: true },
      });
      if (!structure) throw notFound("Structure");
      const definition = structureDefinition(structure.type);
      const every = definition?.moveEveryTurns?.(rules);
      if (!definition || every === undefined) {
        throw conflict("STRUCTURE_NOT_MOVABLE", "This structure cannot be moved");
      }
      const lastMove = (structure.data as { lastMoveTurn?: number }).lastMoveTurn;
      if (lastMove !== undefined && match.currentTurn - lastMove < every) {
        throw conflict("STRUCTURE_MOVED_RECENTLY", "This structure cannot move again yet");
      }
      const locked = await lockTerritories(tx, matchId, [body.territoryId, structure.territoryId]);
      const destination = locked.find((territory) => territory.id === body.territoryId);
      if (destination?.ownerEmpireId !== empire.id || destination.id === structure.territoryId) {
        throw conflict("NOT_YOUR_TERRITORY", "Choose another territory of yours");
      }
      if (locked.some((territory) => territory.inBattle)) {
        throw conflict("TERRITORY_IN_BATTLE", "It cannot move during a battle on it");
      }
      if (definition.notOnCapital && destination.id === empire.capitalTerritoryId) {
        throw conflict("STRUCTURE_ON_CAPITAL", "It cannot be on the capital");
      }
      await tx.structure.update({
        where: { id: structure.id },
        data: {
          territoryId: destination.id,
          data: { ...(structure.data as object), lastMoveTurn: match.currentTurn },
        },
      });
    });
    this.onChange(matchId, "structures");
    return this.matches.state(matchId, viewer);
  }

  // ---------- Merged areas ----------

  /**
   * Checks a merge with the territories locked. Returns either the first
   * reason it is not possible or what it costs.
   */
  private async planMerge(
    tx: Tx,
    matchId: string,
    empire: { id: string; capitalTerritoryId: string | null },
    rules: ReturnType<typeof rulesOf>,
    territoryIds: string[],
  ) {
    const ids = [...new Set(territoryIds)];
    const territories = await lockTerritories(tx, matchId, ids);
    const perTerritory = turnsToResources(
      rules.mergeCostTurns,
      turnIncome(rules, await unitsOfEmpire(tx, empire.id)),
    );
    const base = { perTerritory, cost: perTerritory * ids.length, territories };
    const fail = (problem: string) => ({ ...base, problem, available: 0 });

    if (ids.length < 2) return fail("TOO_FEW");
    if (
      territories.length !== ids.length ||
      territories.some((t) => t.ownerEmpireId !== empire.id)
    ) {
      return fail("NOT_YOURS");
    }
    if (territories.some((territory) => territory.inBattle)) return fail("IN_BATTLE");
    const units = await tx.territoryUnit.count({ where: { territoryId: { in: ids } } });
    if (units > rules.mergeMaxUnits) return fail("TOO_MANY");

    // Contiguous: starting from one, every other is reached through shared borders.
    const reached = new Set([ids[0] ?? ""]);
    const frontier = [ids[0] ?? ""];
    while (frontier.length > 0) {
      const current = frontier.pop() ?? "";
      for (const neighbour of await neighboursOf(tx, matchId, current)) {
        if (ids.includes(neighbour.territoryId) && !reached.has(neighbour.territoryId)) {
          reached.add(neighbour.territoryId);
          frontier.push(neighbour.territoryId);
        }
      }
    }
    if (reached.size !== ids.length) return fail("NOT_CONTIGUOUS");

    const available = territories.reduce((sum, territory) => sum + territory.resources, 0);
    if (available < base.cost) return { ...base, problem: "NOT_ENOUGH_RESOURCES", available };
    return { ...base, problem: null, available };
  }

  /**
   * The blocks standing on the territories of a merge. A block protects one
   * municipality: it does not stretch over an area, so merging cancels it.
   */
  private async blocksOn(tx: Tx, territoryIds: string[]) {
    const structures = await tx.structure.findMany({
      where: { territoryId: { in: territoryIds }, active: true },
      select: { id: true, data: true },
    });
    return structures
      .filter((structure) =>
        ((structure.data as { effects?: string[] }).effects ?? []).includes("NO_ATTACK_ON"),
      )
      .map((structure) => structure.id);
  }

  /** What a merge would cost and whether it is possible, without doing it. */
  async previewMerge(matchId: string, body: z.infer<typeof mergePreviewBody>, viewer: AuthContext) {
    return this.prisma.$transaction(async (tx) => {
      const { empire, rules } = await acting(tx, matchId, viewer);
      const plan = await this.planMerge(tx, matchId, empire, rules, body.territoryIds);
      return {
        perTerritory: plan.perTerritory,
        cost: plan.cost,
        available: plan.available,
        maxUnits: rules.mergeMaxUnits,
        problem: plan.problem,
        /** Blocks the merge would cancel: the player is warned before confirming. */
        blocksLost: (await this.blocksOn(tx, [...new Set(body.territoryIds)])).length,
      };
    });
  }

  /**
   * Merges contiguous own territories into one area with a name: its
   * resources are the sum (minus the cost), it borders whatever any of them
   * bordered, and from now on it attacks and is attacked as a single territory.
   */
  async merge(matchId: string, body: z.infer<typeof mergeBody>, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire, rules } = await acting(tx, matchId, viewer, body.turn, "PRELIMINARY");
      const plan = await this.planMerge(tx, matchId, empire, rules, body.territoryIds);
      if (plan.problem) throw conflict(`MERGE_${plan.problem}`, `Cannot merge: ${plan.problem}`);

      // The capital's row survives, so the capital stays where it is; otherwise the first.
      const keep =
        plan.territories.find((territory) => territory.id === empire.capitalTerritoryId) ??
        plan.territories[0];
      if (!keep) throw notFound("Territory");
      const absorbed = plan.territories.filter((t) => t.id !== keep.id).map((t) => t.id);

      await tx.territoryUnit.updateMany({
        where: { territoryId: { in: absorbed } },
        data: { territoryId: keep.id },
      });
      // Past announcements about the absorbed territories now lead to the area.
      await tx.gameEvent.updateMany({
        where: { matchId, territoryId: { in: absorbed } },
        data: { territoryId: keep.id },
      });
      // A block does not survive the merge; every other structure follows its territory.
      await tx.structure.updateMany({
        where: { id: { in: await this.blocksOn(tx, [keep.id, ...absorbed]) } },
        data: { active: false },
      });
      await tx.structure.updateMany({
        where: { territoryId: { in: absorbed } },
        data: { territoryId: keep.id },
      });
      const merged = await tx.territory.aggregate({
        where: { id: { in: [keep.id, ...absorbed] } },
        _sum: { weight: true },
        _max: { protectedUntilTurn: true },
      });
      await tx.territory.deleteMany({ where: { id: { in: absorbed } } });
      await tx.territory.update({
        where: { id: keep.id },
        data: {
          name: body.name,
          isArea: true,
          resources: plan.available - plan.cost,
          weight: merged._sum.weight ?? 1,
          protectedUntilTurn: merged._max.protectedUntilTurn,
          // The alert is judged again on the new, larger territory.
          alert: false,
          aboveAlertAtLastClose: false,
        },
      });
      await recordEvent(tx, matchId, match.currentTurn, {
        type: "AREA_CREATED",
        empireId: empire.id,
        territoryId: keep.id,
        data: { empireName: empire.name, territoryName: body.name },
      });
    });
    this.onChange(matchId, "territories");
    return this.matches.state(matchId, viewer);
  }

  /** Gives a new name to an own area. */
  async rename(
    matchId: string,
    territoryId: string,
    body: z.infer<typeof renameBody>,
    viewer: AuthContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire } = await acting(tx, matchId, viewer);
      const { count } = await tx.territory.updateMany({
        where: { id: territoryId, matchId, ownerEmpireId: empire.id, isArea: true },
        data: { name: body.name },
      });
      if (count === 0) throw notFound("Area");
      await recordEvent(tx, matchId, match.currentTurn, {
        type: "AREA_RENAMED",
        empireId: empire.id,
        territoryId,
        data: { empireName: empire.name, territoryName: body.name },
      });
    });
    this.onChange(matchId, "territories");
    return this.matches.state(matchId, viewer);
  }

  /**
   * The outline of every merged area of a match, as GeoJSON, for the map to
   * draw each one as a single polygon with its name. PostGIS does the union.
   */
  async areas(matchId: string, viewer: AuthContext | null) {
    await this.matches.get(matchId, viewer);
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        name: string;
        ownerEmpireId: string | null;
        shape: string;
        lon: number;
        lat: number;
      }[]
    >(Prisma.sql`
      SELECT t.id, t.name, t."ownerEmpireId",
        ST_AsGeoJSON(ST_Union(u."geomSimple"), 5) AS shape,
        ST_X(ST_PointOnSurface(ST_Union(u."geomSimple"))) AS lon,
        ST_Y(ST_PointOnSurface(ST_Union(u."geomSimple"))) AS lat
      FROM "Territory" t
      JOIN "TerritoryUnit" tu ON tu."territoryId" = t.id
      JOIN "GeoUnit" u ON u.id = tu."geoUnitId"
      WHERE t."matchId" = ${matchId} AND t."isArea"
      GROUP BY t.id, t.name, t."ownerEmpireId"`);
    return {
      type: "FeatureCollection" as const,
      features: rows.map((row) => ({
        type: "Feature" as const,
        id: row.id,
        geometry: JSON.parse(row.shape) as unknown,
        properties: {
          name: row.name,
          ownerEmpireId: row.ownerEmpireId,
          lon: row.lon,
          lat: row.lat,
        },
      })),
    };
  }
}

export type { StructureDefinition };

import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AuthContext } from "../../auth/sessions.js";
import { AppError, notFound } from "../../http/errors.js";
import { costOf, planAttack } from "../../rules/attack.js";
import type { MatchRules } from "../../rules/config.js";
import type { MatchService } from "../matches/service.js";
import { areAllies } from "./alliances.js";
import { acting, conflict, lockTerritories, neighboursOf } from "./shared.js";

export const attackBody = z.strictObject({
  /** A municipality of the enemy territory to attack. */
  targetGeoUnitId: z.number().int().positive(),
  /** Own territories adjacent to the target that join the attack: one or more. */
  fromTerritoryIds: z.array(z.string().min(1)).min(1).max(50),
  turn: z.number().int().min(1),
});

export const attackPreviewBody = attackBody.omit({ turn: true });

export const respondBody = z.strictObject({
  action: z.enum(["DEFEND", "SURRENDER"]),
});

/** Asks `jobs` to resolve a battle: battles are resolved only there. */
export interface ResolutionQueue {
  requestResolution(message: { battleId: string; matchId: string }): Promise<void>;
}

/**
 * Battles between empires (PROMPT §2.5). The api validates and records the
 * declaration and the defender's response; the outcome is always computed
 * by `jobs`, at once when the defender answers, at turn close otherwise.
 */
export class BattleService {
  /** Called after a change that the followers of a match should see. */
  onChange: (matchId: string, kind: string) => void = () => undefined;
  /** Called when an empire is attacked, to alert its player at once. */
  onIncoming: (matchId: string, defenderUserId: string, battleId: string) => void = () => undefined;
  onQueueError: (error: unknown, battleId: string) => void = () => undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly matches: MatchService,
    private readonly queue: ResolutionQueue,
  ) {}

  /**
   * Checks an attack and works out what it costs, with every territory
   * involved locked. Shared by the preview (which then rolls back) and by
   * the declaration.
   */
  private async plan(
    tx: Prisma.TransactionClient,
    matchId: string,
    attackerEmpireId: string,
    currentTurn: number,
    rules: MatchRules,
    body: z.infer<typeof attackPreviewBody>,
  ) {
    const targetUnit = await tx.territoryUnit.findUnique({
      where: { matchId_geoUnitId: { matchId, geoUnitId: body.targetGeoUnitId } },
      select: { territoryId: true },
    });
    if (!targetUnit) throw notFound("Municipality");
    const sourceIds = [...new Set(body.fromTerritoryIds)];
    if (sourceIds.includes(targetUnit.territoryId)) {
      throw conflict("NOT_YOUR_TERRITORY", "You cannot attack from the target itself");
    }

    const locked = await lockTerritories(tx, matchId, [targetUnit.territoryId, ...sourceIds]);
    const target = locked.find((territory) => territory.id === targetUnit.territoryId);
    const sources = sourceIds.map((id) => locked.find((territory) => territory.id === id));
    if (!target) throw notFound("Municipality");

    if (target.ownerEmpireId === null) {
      throw conflict("TARGET_IS_FREE", "A free municipality is annexed, not attacked");
    }
    if (target.ownerEmpireId === attackerEmpireId) {
      throw conflict("TARGET_IS_YOURS", "You cannot attack your own territory");
    }
    const defender = await tx.empire.findUniqueOrThrow({ where: { id: target.ownerEmpireId } });
    // Allies cannot attack each other, an announced exit included until it takes effect.
    if (await areAllies(tx, attackerEmpireId, defender.id)) {
      throw conflict("TARGET_IS_ALLY", "You cannot attack an ally");
    }
    if ((target.protectedUntilTurn ?? 0) >= currentTurn) {
      throw conflict(
        "TARGET_PROTECTED",
        "A territory just acquired is protected until the turn ends",
      );
    }
    // Active structures decide through their effects, never through their type.
    const structures = await tx.structure.findMany({
      where: { matchId, active: true, territoryId: { in: [target.id, ...sourceIds] } },
      select: { territoryId: true, data: true },
    });
    const has = (territoryId: string, effect: string) =>
      structures.some(
        (structure) =>
          structure.territoryId === territoryId &&
          ((structure.data as { effects?: string[] }).effects ?? []).includes(effect),
      );
    if (has(target.id, "NO_ATTACK_ON")) {
      throw conflict("TARGET_BLOCKED", "A military block protects this territory");
    }
    // One battle at a time per territory (also guaranteed by the BattleLock primary key).
    if (target.inBattle) throw conflict("TERRITORY_IN_BATTLE", "The target is already in a battle");

    const adjacent = new Set(
      (await neighboursOf(tx, matchId, target.id)).map((neighbour) => neighbour.territoryId),
    );
    const usable = sources.map((source) => {
      if (source?.ownerEmpireId !== attackerEmpireId) {
        throw conflict("NOT_YOUR_TERRITORY", "You can attack only from your own territories");
      }
      if (!adjacent.has(source.id)) {
        throw conflict("NOT_ADJACENT", `${source.name} does not border the target`);
      }
      if (has(source.id, "NO_ATTACK_FROM")) {
        throw conflict(
          "SOURCE_BLOCKED",
          `${source.name} is under a military block and cannot attack`,
        );
      }
      if (source.inBattle) {
        throw conflict("TERRITORY_IN_BATTLE", `${source.name} is already in a battle`);
      }
      if (source.resources < 1) {
        throw conflict("NOT_ENOUGH_RESOURCES", `${source.name} has no resources to attack with`);
      }
      return source;
    });

    const plan = planAttack(
      rules,
      usable.map((source) => source.resources),
    );
    return { target, defender, sources: usable, plan };
  }

  /** What an attack would cost, without declaring it. Nothing about the defender is revealed. */
  async preview(matchId: string, body: z.infer<typeof attackPreviewBody>, viewer: AuthContext) {
    return this.prisma.$transaction(async (tx) => {
      const { match, empire, rules } = await acting(tx, matchId, viewer);
      const { sources, plan } = await this.plan(
        tx,
        matchId,
        empire.id,
        match.currentTurn,
        rules,
        body,
      );
      return {
        pct: plan.pct,
        totalCost: plan.totalCost,
        force: plan.force,
        from: sources.map((source, index) => ({
          territoryId: source.id,
          name: source.name,
          resources: source.resources,
          cost: plan.costs[index] ?? 0,
        })),
      };
    });
  }

  /**
   * Declares an attack. The whole cost is reserved now, from every territory
   * used; the strengths of both sides are fixed now, on the resources present
   * before any cost is paid; target and sources are locked until the outcome.
   */
  async declare(matchId: string, body: z.infer<typeof attackBody>, viewer: AuthContext) {
    let incoming: { defenderUserId: string; battleId: string };
    try {
      incoming = await this.prisma.$transaction(async (tx) => {
        const { match, empire, rules } = await acting(tx, matchId, viewer, body.turn, "ACTION");
        const { target, defender, sources, plan } = await this.plan(
          tx,
          matchId,
          empire.id,
          match.currentTurn,
          rules,
          body,
        );

        const battle = await tx.battle.create({
          data: {
            matchId,
            turn: match.currentTurn,
            attackerEmpireId: empire.id,
            defenderEmpireId: defender.id,
            targetTerritoryId: target.id,
            attackPct: plan.pct,
            attackCost: plan.totalCost,
            attackForce: plan.force,
            // The defender fights with what is on the attacked territory now.
            defenseForce: target.resources,
            sources: {
              create: sources.map((source, index) => ({
                territoryId: source.id,
                cost: plan.costs[index] ?? 0,
                resourcesAtDeclaration: source.resources,
              })),
            },
          },
        });
        // In id order, like every lock on territories: no deadlock between crossing attacks.
        await tx.battleLock.createMany({
          data: [target, ...sources]
            .map((territory) => ({ territoryId: territory.id, battleId: battle.id }))
            .sort((a, b) => a.territoryId.localeCompare(b.territoryId)),
        });
        for (const [index, source] of sources.entries()) {
          await tx.territory.update({
            where: { id: source.id },
            data: { resources: { decrement: plan.costs[index] ?? 0 } },
          });
        }
        return { defenderUserId: defender.userId, battleId: battle.id };
      });
    } catch (error) {
      // The primary key of BattleLock is the last line of defence.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw conflict("TERRITORY_IN_BATTLE", "A territory involved is already in a battle");
      }
      throw error;
    }
    this.onIncoming(matchId, incoming.defenderUserId, incoming.battleId);
    this.onChange(matchId, "battles");
    return this.matches.state(matchId, viewer);
  }

  /**
   * The defender's answer: defend or surrender. It is recorded here and the
   * battle is handed to `jobs`, which resolves it at once. If the hand-off
   * is lost the battle is still resolved, with this answer, when the turn closes.
   */
  async respond(
    matchId: string,
    battleId: string,
    body: z.infer<typeof respondBody>,
    viewer: AuthContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { empire } = await acting(tx, matchId, viewer);
      const { count } = await tx.battle.updateMany({
        where: {
          id: battleId,
          matchId,
          defenderEmpireId: empire.id,
          status: "OPEN",
          response: null,
        },
        data: { response: body.action, respondedAt: new Date() },
      });
      if (count === 1) return;
      const battle = await tx.battle.findFirst({ where: { id: battleId, matchId } });
      if (!battle) throw notFound("Battle");
      if (battle.defenderEmpireId !== empire.id) {
        throw new AppError(403, "NOT_THE_DEFENDER", "Only the attacked empire can answer");
      }
      throw conflict("BATTLE_ANSWERED", "This battle has already been answered");
    });

    try {
      await this.queue.requestResolution({ battleId, matchId });
    } catch (error) {
      this.onQueueError(error, battleId);
    }
    this.onChange(matchId, "battles");
    return this.matches.state(matchId, viewer);
  }
}

/** What the defender would pay to defend a territory holding these resources. */
export const defenseCost = (rules: Pick<MatchRules, "defensePct">, resources: number) =>
  costOf(resources, rules.defensePct);

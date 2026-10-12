import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AuthContext } from "../../auth/sessions.js";
import { AppError, notFound } from "../../http/errors.js";
import { costOf, planAttack } from "../../rules/attack.js";
import type { MatchRules } from "../../rules/config.js";
import type { MatchService } from "../matches/service.js";
import { areAllies } from "./alliances.js";
import { acting, conflict, lockTerritories, reachersOf } from "./shared.js";
import { moveTurnClose } from "../../queue/jobs.js";
import { recordEvent } from "../../events/events.js";

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

export const supportBody = z.strictObject({
  /** An own territory, not in a battle. */
  fromTerritoryId: z.string().min(1),
  /** The besieged territory, to help who defends it; one the siege starts from, to help who attacks. */
  toTerritoryId: z.string().min(1),
  amount: z.number().int().min(1),
  turn: z.number().int().min(1),
});

/** Asks `jobs` to resolve a battle: battles are resolved only there. */
export interface ResolutionQueue {
  requestResolution(message: { battleId: string; matchId: string }): Promise<void>;
}

/** An attack declared this close to the end of a turn makes the turn this much longer. */
export const LATE_ATTACK_WINDOW_SECONDS = 5;
export const LATE_ATTACK_EXTENDS_SECONDS = 10;

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
      // By land, or by sea from a territory with a port.
      (await reachersOf(tx, matchId, target.id)).map((reacher) => reacher.territoryId),
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
        // The empire is locked: its attacks of this turn are counted one at a time.
        const declared = await tx.battle.count({
          where: { matchId, attackerEmpireId: empire.id, turn: match.currentTurn },
        });
        if (declared >= rules.attacksPerTurn) {
          throw conflict("ATTACK_LIMIT", "No attacks left this turn");
        }
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
    await this.extendTurn(matchId, body.turn);
    this.onIncoming(matchId, incoming.defenderUserId, incoming.battleId);
    this.onChange(matchId, "battles");
    return this.matches.state(matchId, viewer);
  }

  /**
   * An attack declared in the last seconds of a turn makes the turn longer: whoever is
   * attacked must have the time to answer. Done after the attack is recorded, in one
   * statement: of two attacks at the same instant only the first finds the turn about
   * to end, and a turn that closed in the meantime is left alone.
   */
  private async extendTurn(matchId: string, turn: number) {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ turnEndsAt: Date }[]>`
        UPDATE "Match"
        SET "turnEndsAt" = "turnEndsAt" + make_interval(secs => ${LATE_ATTACK_EXTENDS_SECONDS})
        WHERE id = ${matchId} AND status = 'ONGOING' AND "pausedAt" IS NULL
          AND "currentTurn" = ${turn}
          AND "turnEndsAt" - (now() AT TIME ZONE 'UTC')
            <= make_interval(secs => ${LATE_ATTACK_WINDOW_SECONDS})
        RETURNING "turnEndsAt"`;
      const end = rows[0]?.turnEndsAt;
      if (end) await moveTurnClose(tx, matchId, turn, end);
    });
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
      const { match, empire } = await acting(tx, matchId, viewer);
      const { count } = await tx.battle.updateMany({
        where: {
          id: battleId,
          matchId,
          defenderEmpireId: empire.id,
          status: "OPEN",
          response: null,
          // A siege is fought one round a turn: until the next one it can only be given up.
          ...(body.action === "DEFEND"
            ? { OR: [{ foughtTurn: null }, { foughtTurn: { lt: match.currentTurn } }] }
            : {}),
        },
        data: { response: body.action, respondedAt: new Date() },
      });
      if (count === 1) return;
      const battle = await tx.battle.findFirst({ where: { id: battleId, matchId } });
      if (!battle) throw notFound("Battle");
      if (battle.defenderEmpireId !== empire.id) {
        throw new AppError(403, "NOT_THE_DEFENDER", "Only the attacked empire can answer");
      }
      if (battle.status === "OPEN" && battle.response === null) {
        throw conflict("ROUND_FOUGHT", "This turn's round has been fought: the next is next turn");
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

  /**
   * The attacker gives up a siege: a battle that went past its first round. Recorded
   * here and applied by `jobs`, like the answer of the defender; if the hand-off is
   * lost it is applied when the turn closes.
   */
  async withdraw(matchId: string, battleId: string, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { empire } = await acting(tx, matchId, viewer);
      const { count } = await tx.battle.updateMany({
        where: {
          id: battleId,
          matchId,
          attackerEmpireId: empire.id,
          status: "OPEN",
          round: { gt: 1 },
          withdrawn: false,
        },
        data: { withdrawn: true },
      });
      if (count === 1) return;
      const battle = await tx.battle.findFirst({ where: { id: battleId, matchId } });
      if (!battle) throw notFound("Battle");
      if (battle.attackerEmpireId !== empire.id) {
        throw new AppError(403, "NOT_THE_ATTACKER", "Only the attacking empire can withdraw");
      }
      if (battle.status === "OPEN" && battle.round === 1) {
        throw conflict("NOT_A_SIEGE", "An attack can be withdrawn only once it became a siege");
      }
      throw conflict("BATTLE_ANSWERED", "This battle is already over");
    });

    try {
      await this.queue.requestResolution({ battleId, matchId });
    } catch (error) {
      this.onQueueError(error, battleId);
    }
    this.onChange(matchId, "battles");
    return this.matches.state(matchId, viewer);
  }

  /**
   * An empire that is on neither side sends resources to a siege, allied or not: onto
   * the besieged territory for who defends it, onto a territory the siege starts from
   * for who attacks. What arrives belongs to who holds that territory, and counts in
   * the round awaited like anything else on it. Who helped whom is public; how much is not.
   */
  async support(
    matchId: string,
    battleId: string,
    body: z.infer<typeof supportBody>,
    viewer: AuthContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire } = await acting(tx, matchId, viewer, body.turn);
      const locked = await lockTerritories(tx, matchId, [body.fromTerritoryId, body.toTerritoryId]);
      const from = locked.find((territory) => territory.id === body.fromTerritoryId);
      const to = locked.find((territory) => territory.id === body.toTerritoryId);
      // Read with the territories locked: a round being fought has them locked too.
      const battle = await tx.battle.findFirst({ where: { id: battleId, matchId } });
      if (!battle) throw notFound("Battle");
      if (battle.status !== "OPEN" || battle.round === 1) {
        throw conflict("NOT_A_SIEGE", "Only a siege can be supported");
      }
      if (empire.id === battle.attackerEmpireId || empire.id === battle.defenderEmpireId) {
        throw conflict("NOT_A_THIRD_PARTY", "The two sides of a siege cannot support it");
      }
      if (from?.ownerEmpireId !== empire.id) {
        throw conflict("NOT_YOUR_TERRITORY", "You can send resources only from your own territory");
      }
      if (from.inBattle) {
        throw conflict("TERRITORY_IN_BATTLE", "A territory in a battle cannot give");
      }
      const lock = to ? await tx.battleLock.findUnique({ where: { territoryId: to.id } }) : null;
      if (!to || lock?.battleId !== battle.id) {
        throw conflict("NOT_IN_THE_SIEGE", "Choose a territory of this siege");
      }
      if (from.resources < body.amount) {
        throw conflict("NOT_ENOUGH_RESOURCES", "The territory does not hold that much");
      }
      await tx.territory.update({
        where: { id: from.id },
        data: { resources: { decrement: body.amount } },
      });
      await tx.territory.update({
        where: { id: to.id },
        data: { resources: { increment: body.amount } },
      });
      const defending = to.id === battle.targetTerritoryId;
      const [target, helped] = await Promise.all([
        tx.territory.findUniqueOrThrow({ where: { id: battle.targetTerritoryId } }),
        tx.empire.findUniqueOrThrow({
          where: { id: defending ? battle.defenderEmpireId : battle.attackerEmpireId },
        }),
      ]);
      await recordEvent(tx, matchId, match.currentTurn, {
        type: "SIEGE_SUPPORTED",
        empireId: empire.id,
        territoryId: target.id,
        data: {
          empireName: empire.name,
          otherName: helped.name,
          territoryName: target.name,
          side: defending ? "DEFENDER" : "ATTACKER",
        },
      });
    });
    this.onChange(matchId, "battles");
    return this.matches.state(matchId, viewer);
  }
}

/** What the defender would pay to defend a territory holding these resources. */
export const defenseCost = (rules: Pick<MatchRules, "defensePct">, resources: number) =>
  costOf(resources, rules.defensePct);

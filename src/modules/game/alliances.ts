import type { Alliance, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AuthContext } from "../../auth/sessions.js";
import { recordEvent } from "../../events/events.js";
import { AppError, notFound } from "../../http/errors.js";
import type { MatchService } from "../matches/service.js";
import { acting, conflict, lockTerritories, type Tx } from "./shared.js";

export const inviteBody = z.strictObject({ toEmpireId: z.string().min(1) });
export const transferBody = z.strictObject({
  /** An own territory. */
  fromTerritoryId: z.string().min(1),
  /** A territory of an ally. */
  toTerritoryId: z.string().min(1),
  amount: z.number().int().min(1),
  turn: z.number().int().min(1),
});
export const chatBody = z.strictObject({ text: z.string().trim().min(1).max(5000) });

/** The two empires of a pact in the order they are stored in. */
const pair = (x: string, y: string) =>
  x < y ? { aEmpireId: x, bEmpireId: y } : { aEmpireId: y, bEmpireId: x };

/** The pact between two empires, if there is one. */
export async function allianceBetween(db: Tx | PrismaClient, x: string, y: string) {
  return db.alliance.findUnique({ where: { aEmpireId_bEmpireId: pair(x, y) } });
}

/** Whether two empires are allies right now (an announced end counts until it takes effect). */
export async function areAllies(db: Tx | PrismaClient, x: string, y: string): Promise<boolean> {
  return (await allianceBetween(db, x, y)) !== null;
}

const otherOf = (alliance: Alliance, empireId: string) =>
  alliance.aEmpireId === empireId ? alliance.bEmpireId : alliance.aEmpireId;

/**
 * Alliances (PROMPT §2.6): allies cannot attack each other, see each other's
 * resources and can send resources to each other. An alliance is a pact
 * between two empires and nothing more: being allied with the same empire
 * does not make two others allies. Ending one takes effect at the end of the
 * following turn, so there is no instant betrayal, and until then whoever
 * announced it can take it back.
 */
export class AllianceService {
  onChange: (matchId: string, kind: string) => void = () => undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly matches: MatchService,
  ) {}

  private async empireOfViewer(tx: Tx | PrismaClient, matchId: string, viewer: AuthContext) {
    const empire = await tx.empire.findFirst({
      where: { matchId, userId: viewer.user.id, status: "ACTIVE" },
    });
    if (!empire) throw new AppError(403, "NOT_A_PLAYER", "You have no empire in this match");
    return empire;
  }

  private alliesOf(tx: Tx | PrismaClient, empireId: string) {
    return tx.alliance.count({ where: { OR: [{ aEmpireId: empireId }, { bEmpireId: empireId }] } });
  }

  /** The viewer's pact with that id. */
  private async mine(tx: Tx | PrismaClient, matchId: string, allianceId: string, empireId: string) {
    const alliance = await tx.alliance.findFirst({
      where: { id: allianceId, matchId, OR: [{ aEmpireId: empireId }, { bEmpireId: empireId }] },
    });
    if (!alliance) throw notFound("Alliance");
    return alliance;
  }

  /** Proposes an alliance to another empire. */
  async invite(matchId: string, body: z.infer<typeof inviteBody>, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { empire, rules } = await acting(tx, matchId, viewer);
      const target = await tx.empire.findFirst({
        where: { id: body.toEmpireId, matchId, status: "ACTIVE" },
      });
      if (!target || target.id === empire.id) throw notFound("Empire");
      if (await areAllies(tx, empire.id, target.id)) {
        throw conflict("ALREADY_ALLIES", "You are already allies");
      }
      if ((await this.alliesOf(tx, empire.id)) >= rules.allianceMaxAllies) {
        throw conflict("TOO_MANY_ALLIES", "You have as many allies as the match allows");
      }
      const pending = await tx.allianceInvite.findFirst({
        where: { matchId, fromEmpireId: empire.id, toEmpireId: target.id, status: "PENDING" },
      });
      if (pending) throw conflict("ALREADY_INVITED", "You have already proposed it");
      await tx.allianceInvite.create({
        data: { matchId, fromEmpireId: empire.id, toEmpireId: target.id },
      });
    });
    this.onChange(matchId, "alliances");
    return this.matches.state(matchId, viewer);
  }

  /** The invited empire accepts or declines; the proposer can withdraw. */
  async answer(
    matchId: string,
    inviteId: string,
    action: "accept" | "decline" | "withdraw",
    viewer: AuthContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire, rules } = await acting(tx, matchId, viewer);
      const invite = await tx.allianceInvite.findFirst({
        where: { id: inviteId, matchId, status: "PENDING" },
      });
      const mineToAnswer = action === "withdraw" ? invite?.fromEmpireId : invite?.toEmpireId;
      if (!invite || mineToAnswer !== empire.id) throw notFound("Proposal");
      if (action !== "accept") {
        await tx.allianceInvite.update({
          where: { id: invite.id },
          data: { status: "DECLINED", respondedAt: new Date() },
        });
        return;
      }

      // The proposer's row is locked too, so that two acceptances cannot both fit under
      // its limit. (The viewer's is already held by `acting`.)
      const proposers = await tx.$queryRaw<{ id: string; name: string; status: string }[]>`
        SELECT id, name, status::text FROM "Empire" WHERE id = ${invite.fromEmpireId} FOR UPDATE`;
      const proposer = proposers[0];
      if (proposer?.status !== "ACTIVE") {
        throw conflict("PROPOSAL_EXPIRED", "That empire has fallen");
      }
      if (await areAllies(tx, empire.id, proposer.id)) {
        throw conflict("ALREADY_ALLIES", "You are already allies");
      }
      if ((await this.alliesOf(tx, empire.id)) >= rules.allianceMaxAllies) {
        throw conflict("TOO_MANY_ALLIES", "You have as many allies as the match allows");
      }
      if ((await this.alliesOf(tx, proposer.id)) >= rules.allianceMaxAllies) {
        throw conflict("PROPOSAL_EXPIRED", "That empire has no room for another ally");
      }
      // Allies cannot be at war with each other.
      const atWar = await tx.battle.count({
        where: {
          matchId,
          status: "OPEN",
          OR: [
            { attackerEmpireId: empire.id, defenderEmpireId: proposer.id },
            { defenderEmpireId: empire.id, attackerEmpireId: proposer.id },
          ],
        },
      });
      if (atWar > 0) throw conflict("ALLIANCE_AT_WAR", "You are fighting that empire");

      await tx.alliance.create({
        data: { matchId, createdTurn: match.currentTurn, ...pair(empire.id, proposer.id) },
      });
      await tx.allianceInvite.update({
        where: { id: invite.id },
        data: { status: "ACCEPTED", respondedAt: new Date() },
      });
      // A proposal the other way round between the same two is answered by this one.
      await tx.allianceInvite.updateMany({
        where: {
          matchId,
          status: "PENDING",
          fromEmpireId: empire.id,
          toEmpireId: proposer.id,
        },
        data: { status: "ACCEPTED", respondedAt: new Date() },
      });
      await recordEvent(tx, matchId, match.currentTurn, {
        type: "ALLIANCE_FORMED",
        empireId: proposer.id,
        data: { empireName: proposer.name, otherName: empire.name },
      });
    });
    this.onChange(matchId, "alliances");
    return this.matches.state(matchId, viewer);
  }

  /**
   * Announces the end of an alliance. It takes effect when the following turn
   * ends: until then the two are still allies in every respect.
   */
  async end(matchId: string, allianceId: string, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire, rules } = await acting(tx, matchId, viewer);
      const alliance = await this.mine(tx, matchId, allianceId, empire.id);
      if (alliance.endsAtTurn !== null) {
        throw conflict("ALLIANCE_ENDING", "The end of this alliance is already announced");
      }
      await tx.alliance.update({
        where: { id: alliance.id },
        data: {
          endsAtTurn: match.currentTurn + rules.allianceLeaveNoticeTurns,
          endedByEmpireId: empire.id,
        },
      });
      const other = await tx.empire.findUniqueOrThrow({
        where: { id: otherOf(alliance, empire.id) },
      });
      await recordEvent(tx, matchId, match.currentTurn, {
        type: "ALLIANCE_ENDING",
        empireId: empire.id,
        data: { empireName: empire.name, otherName: other.name },
      });
    });
    this.onChange(matchId, "alliances");
    return this.matches.state(matchId, viewer);
  }

  /** Takes back the announced end: only who announced it can, while it has not happened yet. */
  async keep(matchId: string, allianceId: string, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire } = await acting(tx, matchId, viewer);
      const alliance = await this.mine(tx, matchId, allianceId, empire.id);
      if (alliance.endsAtTurn === null) {
        throw conflict("ALLIANCE_NOT_ENDING", "No end was announced for this alliance");
      }
      if (alliance.endedByEmpireId !== empire.id) {
        throw conflict("NOT_YOUR_ANNOUNCEMENT", "Only who announced the end can take it back");
      }
      await tx.alliance.update({
        where: { id: alliance.id },
        data: { endsAtTurn: null, endedByEmpireId: null },
      });
      const other = await tx.empire.findUniqueOrThrow({
        where: { id: otherOf(alliance, empire.id) },
      });
      await recordEvent(tx, matchId, match.currentTurn, {
        type: "ALLIANCE_KEPT",
        empireId: empire.id,
        data: { empireName: empire.name, otherName: other.name },
      });
    });
    this.onChange(matchId, "alliances");
    return this.matches.state(matchId, viewer);
  }

  /**
   * Sends resources from an own territory to a territory of an ally. Like a
   * move inside an empire, it is not possible from or to a territory in a
   * battle: help between allies is preventive only.
   */
  async transfer(matchId: string, body: z.infer<typeof transferBody>, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { empire } = await acting(tx, matchId, viewer, body.turn);
      const locked = await lockTerritories(tx, matchId, [body.fromTerritoryId, body.toTerritoryId]);
      const from = locked.find((territory) => territory.id === body.fromTerritoryId);
      const to = locked.find((territory) => territory.id === body.toTerritoryId);
      if (from?.ownerEmpireId !== empire.id) {
        throw conflict("NOT_YOUR_TERRITORY", "You can send resources only from your own territory");
      }
      if (!to?.ownerEmpireId || to.ownerEmpireId === empire.id) {
        throw conflict("NOT_AN_ALLY", "Choose a territory of an ally");
      }
      if (!(await areAllies(tx, empire.id, to.ownerEmpireId))) {
        throw conflict("NOT_AN_ALLY", "That empire is not your ally");
      }
      if (from.inBattle || to.inBattle) {
        throw conflict("TERRITORY_IN_BATTLE", "A territory in a battle cannot give or receive");
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
    });
    this.onChange(matchId, "resources");
    return this.matches.state(matchId, viewer);
  }

  /** The private conversation of an alliance, between its two empires, newest first. */
  async chat(matchId: string, allianceId: string, viewer: AuthContext) {
    const empire = await this.empireOfViewer(this.prisma, matchId, viewer);
    const alliance = await this.mine(this.prisma, matchId, allianceId, empire.id);
    return this.prisma.allianceMessage.findMany({
      where: { allianceId: alliance.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, empireId: true, text: true, createdAt: true },
    });
  }

  async say(
    matchId: string,
    allianceId: string,
    body: z.infer<typeof chatBody>,
    viewer: AuthContext,
  ) {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match) throw notFound("Match");
    const max = (match.config as Prisma.JsonObject).boardMaxChars;
    if (typeof max === "number" && body.text.length > max) {
      throw new AppError(400, "MESSAGE_TOO_LONG", `At most ${String(max)} characters`);
    }
    const empire = await this.empireOfViewer(this.prisma, matchId, viewer);
    const alliance = await this.mine(this.prisma, matchId, allianceId, empire.id);
    await this.prisma.allianceMessage.create({
      data: { allianceId: alliance.id, empireId: empire.id, text: body.text },
    });
    this.onChange(matchId, "alliance-chat");
    return this.chat(matchId, allianceId, viewer);
  }
}

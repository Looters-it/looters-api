import type { Prisma, PrismaClient } from "@prisma/client";
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

/** The alliance an empire belongs to, if any. */
export async function allianceOf(db: Tx | PrismaClient, empireId: string) {
  return db.allianceMember.findUnique({ where: { empireId } });
}

/** Whether two empires are allies right now (an announced exit counts until it takes effect). */
export async function areAllies(db: Tx | PrismaClient, a: string, b: string): Promise<boolean> {
  const members = await db.allianceMember.findMany({ where: { empireId: { in: [a, b] } } });
  return members.length === 2 && members[0]?.allianceId === members[1]?.allianceId;
}

/**
 * Alliances (PROMPT §2.6): allies cannot attack each other, see each other's
 * resources and can send resources to each other. An empire is in at most
 * one alliance (the primary key of AllianceMember); leaving takes effect at
 * the end of the following turn, so there is no instant betrayal.
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

  /** Proposes an alliance to another empire, or invites it into the proposer's alliance. */
  async invite(matchId: string, body: z.infer<typeof inviteBody>, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { empire, rules } = await acting(tx, matchId, viewer);
      const target = await tx.empire.findFirst({
        where: { id: body.toEmpireId, matchId, status: "ACTIVE" },
      });
      if (!target || target.id === empire.id) throw notFound("Empire");
      if (await allianceOf(tx, target.id)) {
        throw conflict("TARGET_IN_ALLIANCE", "That empire is already in an alliance");
      }
      const mine = await allianceOf(tx, empire.id);
      if (mine?.leavesAtTurn != null) {
        throw conflict("LEAVING_ALLIANCE", "You are leaving your alliance: you cannot invite");
      }
      if (mine) {
        const members = await tx.allianceMember.count({ where: { allianceId: mine.allianceId } });
        if (members >= rules.allianceMaxMembers) {
          throw conflict("ALLIANCE_FULL", "Your alliance has no room");
        }
      }
      const pending = await tx.allianceInvite.findFirst({
        where: { matchId, fromEmpireId: empire.id, toEmpireId: target.id, status: "PENDING" },
      });
      if (pending) throw conflict("ALREADY_INVITED", "You have already proposed it");
      await tx.allianceInvite.create({
        data: {
          matchId,
          allianceId: mine?.allianceId ?? null,
          fromEmpireId: empire.id,
          toEmpireId: target.id,
        },
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

      if (await allianceOf(tx, empire.id)) {
        throw conflict("ALREADY_IN_ALLIANCE", "You are already in an alliance");
      }
      const proposer = await tx.empire.findUnique({ where: { id: invite.fromEmpireId } });
      if (proposer?.status !== "ACTIVE")
        throw conflict("PROPOSAL_EXPIRED", "That empire has fallen");
      const proposerMember = await allianceOf(tx, proposer.id);
      // The proposal stands only if the proposer is where they were when they made it.
      if (
        (proposerMember?.allianceId ?? null) !== invite.allianceId ||
        proposerMember?.leavesAtTurn != null
      ) {
        throw conflict("PROPOSAL_EXPIRED", "The proposal is no longer valid");
      }

      const currentMembers = invite.allianceId
        ? (await tx.allianceMember.findMany({ where: { allianceId: invite.allianceId } })).map(
            (member) => member.empireId,
          )
        : [proposer.id];
      if (currentMembers.length >= rules.allianceMaxMembers) {
        throw conflict("ALLIANCE_FULL", "The alliance has no room");
      }
      // Allies cannot be at war: no open battle between the newcomer and any member.
      const atWar = await tx.battle.count({
        where: {
          matchId,
          status: "OPEN",
          OR: [
            { attackerEmpireId: empire.id, defenderEmpireId: { in: currentMembers } },
            { defenderEmpireId: empire.id, attackerEmpireId: { in: currentMembers } },
          ],
        },
      });
      if (atWar > 0)
        throw conflict("ALLIANCE_AT_WAR", "You are fighting a member of that alliance");

      let allianceId = invite.allianceId;
      if (!allianceId) {
        const alliance = await tx.alliance.create({
          data: { matchId, createdTurn: match.currentTurn },
        });
        allianceId = alliance.id;
        await tx.allianceMember.create({
          data: { allianceId, empireId: proposer.id, joinedTurn: match.currentTurn },
        });
      }
      await tx.allianceMember.create({
        data: { allianceId, empireId: empire.id, joinedTurn: match.currentTurn },
      });
      await tx.allianceInvite.update({
        where: { id: invite.id },
        data: { status: "ACCEPTED", respondedAt: new Date(), allianceId },
      });
      // Whatever else was pending for the two of them no longer makes sense.
      await tx.allianceInvite.updateMany({
        where: {
          matchId,
          status: "PENDING",
          OR: [{ toEmpireId: empire.id }, { toEmpireId: proposer.id }, { fromEmpireId: empire.id }],
        },
        data: { status: "DECLINED", respondedAt: new Date() },
      });
      await recordEvent(tx, matchId, match.currentTurn, {
        type: invite.allianceId ? "ALLIANCE_JOINED" : "ALLIANCE_FORMED",
        empireId: invite.allianceId ? empire.id : proposer.id,
        data: invite.allianceId
          ? { empireName: empire.name, otherName: proposer.name }
          : { empireName: proposer.name, otherName: empire.name },
      });
    });
    this.onChange(matchId, "alliances");
    return this.matches.state(matchId, viewer);
  }

  /**
   * Announces the exit from the alliance. It takes effect when the following
   * turn ends: until then the empire is still an ally in every respect.
   */
  async leave(matchId: string, viewer: AuthContext) {
    await this.prisma.$transaction(async (tx) => {
      const { match, empire, rules } = await acting(tx, matchId, viewer);
      const member = await allianceOf(tx, empire.id);
      if (!member) throw conflict("NOT_IN_ALLIANCE", "You are not in an alliance");
      if (member.leavesAtTurn !== null)
        throw conflict("LEAVING_ALLIANCE", "You are already leaving");
      await tx.allianceMember.update({
        where: { empireId: empire.id },
        data: { leavesAtTurn: match.currentTurn + rules.allianceLeaveNoticeTurns },
      });
      await recordEvent(tx, matchId, match.currentTurn, {
        type: "ALLIANCE_LEFT",
        empireId: empire.id,
        data: { empireName: empire.name },
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

  /** The private conversation of the viewer's alliance, newest first. */
  async chat(matchId: string, viewer: AuthContext) {
    const empire = await this.empireOfViewer(this.prisma, matchId, viewer);
    const member = await allianceOf(this.prisma, empire.id);
    if (!member) throw conflict("NOT_IN_ALLIANCE", "You are not in an alliance");
    return this.prisma.allianceMessage.findMany({
      where: { allianceId: member.allianceId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, empireId: true, text: true, createdAt: true },
    });
  }

  async say(matchId: string, body: z.infer<typeof chatBody>, viewer: AuthContext) {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match) throw notFound("Match");
    const max = (match.config as Prisma.JsonObject).boardMaxChars;
    if (typeof max === "number" && body.text.length > max) {
      throw new AppError(400, "MESSAGE_TOO_LONG", `At most ${max} characters`);
    }
    const empire = await this.empireOfViewer(this.prisma, matchId, viewer);
    const member = await allianceOf(this.prisma, empire.id);
    if (!member) throw conflict("NOT_IN_ALLIANCE", "You are not in an alliance");
    await this.prisma.allianceMessage.create({
      data: { allianceId: member.allianceId, empireId: empire.id, text: body.text },
    });
    this.onChange(matchId, "alliance-chat");
    return this.chat(matchId, viewer);
  }
}

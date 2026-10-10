import type { PrismaClient } from "@prisma/client";
import { phaseOf, type TurnPhase } from "../src/rules/phases.js";

/** The part of the turn a request belongs to, or null for what is done throughout. */
export function phaseOfRoute(method: string | undefined, route: string): TurnPhase | null {
  if (method !== "POST") return null;
  if (/\/(allocate|capital|structures|structures\/[^/]+\/move|merge)$/.test(route)) {
    return "PRELIMINARY";
  }
  return /\/(annex|attacks)$/.test(route) ? "ACTION" : null;
}

/**
 * Puts the turn of a running match in one of its two parts, by moving its end. The
 * tests of the game say what each action does; this keeps the clock out of their way.
 */
export async function setPhase(prisma: PrismaClient, matchId: string, phase: TurnPhase) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (match?.status !== "ONGOING" || phaseOf(match) === phase) return;
  const length = match.turnHours * 3_600_000;
  await prisma.match.update({
    where: { id: matchId },
    data: {
      // Just begun, or with a tenth of it left.
      turnEndsAt: new Date(Date.now() + (phase === "PRELIMINARY" ? length - 1000 : length / 10)),
    },
  });
}

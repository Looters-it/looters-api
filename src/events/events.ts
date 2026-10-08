import type { Prisma } from "@prisma/client";

/**
 * Typed domain events: the single log that will feed the board, the turn
 * history and the map replay. `data` carries ids and names only, never
 * amounts of resources (PROMPT §2.8, §2.11).
 */
export type GameEventInput =
  | {
      type: "EMPIRE_CREATED";
      empireId: string;
      territoryId: string;
      data: { empireName: string; territoryName: string };
    }
  | {
      type: "ANNEXED";
      empireId: string;
      territoryId: string;
      data: { empireName: string; territoryName: string };
    }
  | {
      type: "CAPITAL_MOVED";
      empireId: string;
      territoryId: string;
      data: { empireName: string; territoryName: string };
    }
  | {
      type: "CAPITAL_BUILT" | "AREA_CREATED" | "AREA_RENAMED";
      empireId: string;
      territoryId: string;
      data: { empireName: string; territoryName: string };
    }
  | {
      type: "ALLIANCE_FORMED" | "ALLIANCE_JOINED";
      empireId: string;
      data: { empireName: string; otherName: string };
    }
  | { type: "ALLIANCE_LEFT"; empireId: string; data: { empireName: string } }
  | { type: "MESSAGE"; empireId: string; data: { empireName: string; text: string } }
  | { type: "MATCH_OPENED" };

export async function recordEvent(
  tx: Prisma.TransactionClient,
  matchId: string,
  turn: number,
  event: GameEventInput,
): Promise<void> {
  await tx.gameEvent.create({
    data: {
      matchId,
      turn,
      type: event.type,
      empireId: "empireId" in event ? event.empireId : null,
      territoryId: "territoryId" in event ? event.territoryId : null,
      data: "data" in event ? event.data : {},
    },
  });
}

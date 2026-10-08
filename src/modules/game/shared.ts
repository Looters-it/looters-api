import type { Empire, Match, Prisma, PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/sessions.js";
import { AppError, notFound } from "../../http/errors.js";
import { rulesOf } from "../matches/service.js";

export type Tx = Prisma.TransactionClient;

export const conflict = (code: string, message: string) => new AppError(409, code, message);

export interface Neighbour {
  geoUnitId: number;
  name: string;
  territoryId: string;
  ownerEmpireId: string | null;
}

/**
 * Municipalities adjacent to a territory, with the territory each belongs
 * to. Adjacency of a match is derived from the adjacency of municipalities:
 * a territory borders whatever any of its municipalities borders.
 */
export function neighboursOf(db: Tx | PrismaClient, matchId: string, territoryId: string) {
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
 * Locks what an action needs and checks that the viewer can act now.
 *
 * The match row is held shared: a closing turn takes it exclusively, so an
 * action never straddles two turns. The player's empire is held
 * exclusively, so two actions of the same player never overlap.
 * `decidedInTurn` is the turn the player was looking at: omitted for
 * actions that are valid in whatever turn they arrive.
 */
export async function acting(tx: Tx, matchId: string, viewer: AuthContext, decidedInTurn?: number) {
  const matches = await tx.$queryRaw<Match[]>`
    SELECT * FROM "Match" WHERE id = ${matchId} FOR SHARE`;
  const match = matches[0];
  if (!match || match.status === "DRAFT") throw notFound("Match");
  if (match.status !== "RUNNING") {
    throw conflict("MATCH_NOT_RUNNING", "The match is not being played");
  }
  if (decidedInTurn !== undefined && match.currentTurn !== decidedInTurn) {
    throw conflict("TURN_CHANGED", "The turn has changed: look at the map again");
  }
  const empires = await tx.$queryRaw<Empire[]>`
    SELECT * FROM "Empire" WHERE "matchId" = ${matchId} AND "userId" = ${viewer.user.id} FOR UPDATE`;
  const empire = empires[0];
  if (!empire) throw new AppError(403, "NOT_A_PLAYER", "You have no empire in this match");
  if (empire.status !== "ACTIVE") throw conflict("EMPIRE_FALLEN", "Your empire has fallen");
  return { match, empire, rules: rulesOf(match) };
}

/** A territory as an action sees it, with the row locked. */
export interface LockedTerritory {
  id: string;
  name: string;
  ownerEmpireId: string | null;
  resources: number;
  protectedUntilTurn: number | null;
  /** Whether it is the target or a source of an open battle. */
  inBattle: boolean;
}

/**
 * Locks territories, always in id order so that two actions touching the
 * same ones cannot deadlock. Whatever reads or changes the resources of a
 * territory, or puts it in a battle, goes through this lock: the amount an
 * action sees is the amount it acts on.
 */
export function lockTerritories(tx: Tx, matchId: string, ids: string[]) {
  return tx.$queryRaw<LockedTerritory[]>`
    SELECT t.id, t.name, t."ownerEmpireId", t.resources, t."protectedUntilTurn",
      EXISTS (SELECT 1 FROM "BattleLock" l WHERE l."territoryId" = t.id) AS "inBattle"
    FROM "Territory" t
    WHERE t.id = ANY(${ids}) AND t."matchId" = ${matchId}
    ORDER BY t.id FOR UPDATE OF t`;
}

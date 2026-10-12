import { Prisma, type Empire, type Match, type PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/sessions.js";
import { AppError, notFound } from "../../http/errors.js";
import { rulesOf } from "../matches/service.js";
import { DEFAULT_MATCH_RULES } from "../../rules/config.js";
import { phaseOf, type TurnPhase } from "../../rules/phases.js";

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
 * Every way from a municipality to another, as rows of `x` (from) and `y` (to): the
 * borders, both ways, and the sea, from the municipalities of a territory with a port
 * to every municipality of the match that is on the sea and within the range of the
 * port (`portRangeKm` of the match, between the centres of the two municipalities;
 * zero is no limit). Where a query asks what an empire can reach, this is what it joins.
 */
export const reachEdges = (matchId: string) => Prisma.sql`
  SELECT "aId" AS x, "bId" AS y FROM "GeoAdjacency"
  UNION ALL SELECT "bId", "aId" FROM "GeoAdjacency"
  UNION ALL
  SELECT harbour."geoUnitId", shore."geoUnitId"
  FROM "Structure" port
  JOIN "TerritoryUnit" harbour ON harbour."territoryId" = port."territoryId"
  JOIN "TerritoryUnit" shore ON shore."matchId" = port."matchId"
    AND shore."territoryId" <> port."territoryId"
  JOIN "GeoUnit" sea ON sea.id = shore."geoUnitId" AND sea.coastal
  JOIN "GeoUnit" quay ON quay.id = harbour."geoUnitId"
  JOIN "Match" played ON played.id = port."matchId"
  CROSS JOIN LATERAL (
    SELECT coalesce((played.config->>'portRangeKm')::float8, ${DEFAULT_MATCH_RULES.portRangeKm}) AS km
  ) reach
  WHERE port."matchId" = ${matchId} AND port.active
    AND jsonb_exists(port.data->'effects', 'SEA_REACH')
    AND (reach.km = 0 OR ST_DistanceSphere(
      ST_MakePoint(quay."centroidLon", quay."centroidLat"),
      ST_MakePoint(sea."centroidLon", sea."centroidLat")) <= reach.km * 1000)`;

/** A territory that another can be reached from, or that it reaches. */
export interface Reached {
  territoryId: string;
  ownerEmpireId: string | null;
}

/**
 * The territories that can reach this one: those that border it and, when it is on
 * the sea, those with a port, wherever they are. It is from these that it can be
 * attacked, and paid for when it is annexed.
 */
export function reachersOf(db: Tx | PrismaClient, matchId: string, territoryId: string) {
  return db.$queryRaw<Reached[]>`
    WITH edges AS (${reachEdges(matchId)})
    SELECT DISTINCT t.id AS "territoryId", t."ownerEmpireId"
    FROM "TerritoryUnit" here
    JOIN edges ON edges.y = here."geoUnitId"
    JOIN "TerritoryUnit" there ON there."matchId" = ${matchId} AND there."geoUnitId" = edges.x
    JOIN "Territory" t ON t.id = there."territoryId"
    WHERE here."territoryId" = ${territoryId} AND t.id <> ${territoryId}`;
}

/** Whether any municipality of a territory is on the sea. */
export async function onSea(db: Tx | PrismaClient, territoryId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ coastal: boolean }[]>`
    SELECT bool_or(u.coastal) AS coastal
    FROM "TerritoryUnit" tu JOIN "GeoUnit" u ON u.id = tu."geoUnitId"
    WHERE tu."territoryId" = ${territoryId}`;
  return rows[0]?.coastal === true;
}

/** Whether a territory is an island: any of its municipalities is one. */
export async function isIsland(db: Tx | PrismaClient, territoryId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ island: boolean | null }[]>`
    SELECT bool_or(u.isolation = 'ISLAND') AS island
    FROM "TerritoryUnit" tu JOIN "GeoUnit" u ON u.id = tu."geoUnitId"
    WHERE tu."territoryId" = ${territoryId}`;
  return rows[0]?.island === true;
}

/**
 * Puts a port on a territory for nothing: the one an island has when an empire starts
 * from it, or the one found there when it is annexed. Nothing when it has one already.
 */
export async function grantPort(
  tx: Tx,
  matchId: string,
  empireId: string,
  territoryId: string,
  turn: number,
): Promise<boolean> {
  const there = await tx.structure.findFirst({
    where: { territoryId, type: "PORT", active: true },
  });
  if (there) return false;
  await tx.structure.create({
    data: {
      matchId,
      territoryId,
      empireId,
      type: "PORT",
      builtTurn: turn,
      data: { effects: ["SEA_REACH"], found: true },
    },
  });
  return true;
}

/**
 * Locks what an action needs and checks that the viewer can act now.
 *
 * The match row is held shared: a closing turn takes it exclusively, so an
 * action never straddles two turns. The player's empire is held
 * exclusively, so two actions of the same player never overlap.
 * `decidedInTurn` is the turn the player was looking at: omitted for
 * actions that are valid in whatever turn they arrive. `phase` is the part of
 * the turn the action belongs to: omitted for what can be done throughout.
 */
export async function acting(
  tx: Tx,
  matchId: string,
  viewer: AuthContext,
  decidedInTurn?: number,
  phase?: TurnPhase,
) {
  const matches = await tx.$queryRaw<Match[]>`
    SELECT * FROM "Match" WHERE id = ${matchId} FOR SHARE`;
  const match = matches[0];
  if (!match) throw notFound("Match");
  if (match.status !== "ONGOING") {
    throw conflict("MATCH_NOT_RUNNING", "The match is not being played");
  }
  // A paused match stands still at the moment it was stopped. Who plays it may still put
  // their own empire in order, if it was stopped in the preliminary part of the turn:
  // nothing else moves, and nothing that touches the others is done.
  if (match.pausedAt && phase !== "PRELIMINARY") {
    throw conflict("MATCH_PAUSED", "The match is paused");
  }
  if (decidedInTurn !== undefined && match.currentTurn !== decidedInTurn) {
    throw conflict("TURN_CHANGED", "The turn has changed: look at the map again");
  }
  if (phase !== undefined && phaseOf(match, match.pausedAt ?? new Date()) !== phase) {
    throw conflict(
      "WRONG_PHASE",
      phase === "PRELIMINARY"
        ? "This is done in the preliminary part of the turn"
        : "This is done after the preliminary part of the turn",
    );
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

/** A territory that stands for the capital of an empire: the capital itself, or a second one. */
export interface Capital {
  id: string;
  resources: number;
  inBattle: boolean;
  lon: number;
  lat: number;
}

/** Where each of the given territories lies: the middle of its municipalities. */
export async function placesOf(db: Tx | PrismaClient, territoryIds: string[]) {
  const rows = await db.$queryRaw<{ id: string; lon: number; lat: number }[]>`
    SELECT tu."territoryId" AS id, avg(u."centroidLon")::float8 AS lon,
      avg(u."centroidLat")::float8 AS lat
    FROM "TerritoryUnit" tu JOIN "GeoUnit" u ON u.id = tu."geoUnitId"
    WHERE tu."territoryId" = ANY(${territoryIds})
    GROUP BY tu."territoryId"`;
  return new Map(rows.map((row) => [row.id, { lon: row.lon, lat: row.lat }]));
}

/** The capitals of an empire: its capital and every second capital it has built. */
export function capitalsOf(db: Tx | PrismaClient, matchId: string, empireId: string) {
  return db.$queryRaw<Capital[]>`
    SELECT t.id, t.resources,
      EXISTS (SELECT 1 FROM "BattleLock" l WHERE l."territoryId" = t.id) AS "inBattle",
      avg(u."centroidLon")::float8 AS lon, avg(u."centroidLat")::float8 AS lat
    FROM "Territory" t
    JOIN "TerritoryUnit" tu ON tu."territoryId" = t.id
    JOIN "GeoUnit" u ON u.id = tu."geoUnitId"
    WHERE t."matchId" = ${matchId} AND t."ownerEmpireId" = ${empireId}
      AND (t.id = (SELECT "capitalTerritoryId" FROM "Empire" WHERE id = ${empireId})
        OR EXISTS (SELECT 1 FROM "Structure" s WHERE s."territoryId" = t.id AND s.active
          AND jsonb_exists(s.data->'effects', 'BACKUP_CAPITAL')))
    GROUP BY t.id`;
}

/**
 * Who pays for an annexation: the own territory beside the municipality, and for what
 * it lacks the capital nearest to it. Null when the two together cannot afford it, or
 * the territory is in a battle; a capital in a battle cannot help.
 */
export function annexFunding(
  payer: { id: string; resources: number; inBattle: boolean; lon: number; lat: number },
  capitals: readonly Capital[],
  cost: number,
): { fromPayer: number; fromCapital: number; capitalId: string | null } | null {
  if (payer.inBattle) return null;
  if (payer.resources >= cost) return { fromPayer: cost, fromCapital: 0, capitalId: null };
  // Near enough at the size of a match: degrees, narrowed by the latitude.
  const narrow = Math.cos((payer.lat * Math.PI) / 180);
  const apart = (capital: Capital) =>
    Math.hypot((capital.lon - payer.lon) * narrow, capital.lat - payer.lat);
  const nearest = capitals
    .filter((capital) => capital.id !== payer.id && !capital.inBattle)
    .sort((a, b) => apart(a) - apart(b) || a.id.localeCompare(b.id))[0];
  const missing = cost - payer.resources;
  if (!nearest || nearest.resources < missing) return null;
  return { fromPayer: payer.resources, fromCapital: missing, capitalId: nearest.id };
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

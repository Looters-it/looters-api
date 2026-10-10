import { z } from "zod";
import { EMPIRE_COLORS, EMPIRE_EMBLEMS, MAX_PLAYERS_LIMIT } from "../../rules/catalogue.js";
import { matchRulesOverrides } from "../../rules/config.js";

export const matchParams = z.object({ id: z.string().min(1) });

const name = z.string().trim().min(3).max(60);
const startAt = z.coerce.date();
const maxDays = z.number().int().min(1).max(3650).nullable();
const maxPlayers = z.number().int().min(2).max(MAX_PLAYERS_LIMIT);
/** How long a turn of a rush match lasts: thirty seconds to prepare, thirty to act. */
export const RUSH_TURN_SECONDS = 60;
/** The shortest turn a normal match may have: faster than a rush one. */
export const MIN_TURN_SECONDS = 30;
const turnHours = z
  .number()
  .min(MIN_TURN_SECONDS / 3600)
  .max(24 * 30);
const mode = z.enum(["SINGLEPLAYER", "MULTIPLAYER"]);
const pace = z.enum(["RUSH", "NORMAL"]);
const visibility = z.enum(["PUBLIC", "PRIVATE"]);
const areaIds = z.array(z.string().min(1)).min(1).max(50);

export const createMatchBody = z.strictObject({
  name,
  areaIds,
  /** Alone against bots, or with people online. */
  mode: mode.default("MULTIPLAYER"),
  /** Rush fixes the turn at sixty seconds; normal takes `turnHours`. */
  pace: pace.default("NORMAL"),
  /** A single-player match is always private. */
  visibility: visibility.default("PUBLIC"),
  /** When the match starts. Without it, as soon as its first player has chosen a capital. */
  startAt: startAt.nullable().default(null),
  maxDays: maxDays.default(null),
  maxPlayers: maxPlayers.default(100),
  turnHours: turnHours.default(24),
  /** Rule values that differ from the defaults. */
  config: matchRulesOverrides.default({}),
});

export const updateMatchBody = z.strictObject({
  name: name.optional(),
  areaIds: areaIds.optional(),
  startAt: startAt.optional(),
  maxDays: maxDays.optional(),
  maxPlayers: maxPlayers.optional(),
  turnHours: turnHours.optional(),
  config: matchRulesOverrides.optional(),
});

/**
 * What the owner may still change before the start. Players may already be in,
 * under these rules and on this map: the rest is fixed when the match is created.
 */
export const PLANNED_EDITABLE = ["name", "startAt", "maxDays", "maxPlayers"] as const;

export const listMatchesQuery = z.object({
  // Planned and ongoing matches, or the finished ones.
  status: z.enum(["active", "finished"]).default("active"),
  name: z.string().trim().max(60).optional(),
  // Players enrolled: with free seats, up to 20, 21 to 50, more than 50.
  size: z.enum(["free", "s", "m", "l"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(6),
});

export const invitationParams = z.object({
  id: z.string().min(1),
  invitationId: z.string().min(1),
});
export const invitationBody = z.strictObject({ username: z.string().trim().min(1).max(100) });

export const empireBody = z.strictObject({
  name: z.string().trim().min(3).max(40),
  color: z.enum(EMPIRE_COLORS as [string, ...string[]]),
  emblem: z.enum(EMPIRE_EMBLEMS),
  motto: z.string().trim().max(80).nullable().default(null),
});

export const joinBody = z.strictObject({
  /** The municipality chosen as starting point: it becomes the capital. */
  geoUnitId: z.number().int().positive(),
  empire: empireBody,
});

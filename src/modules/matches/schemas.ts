import { z } from "zod";
import { EMPIRE_COLORS, EMPIRE_EMBLEMS, MAX_PLAYERS_LIMIT } from "../../rules/catalogue.js";
import { matchRulesOverrides } from "../../rules/config.js";

export const matchParams = z.object({ id: z.string().min(1) });

const name = z.string().trim().min(3).max(60);
const startAt = z.coerce.date();
const maxDays = z.number().int().min(1).max(3650).nullable();
const maxPlayers = z.number().int().min(2).max(MAX_PLAYERS_LIMIT);
// A fraction of an hour is allowed, to play fast test matches.
const turnHours = z
  .number()
  .min(0.01)
  .max(24 * 30);
const inviteCode = z.string().trim().min(4).max(32).nullable();
const areaIds = z.array(z.string().min(1)).min(1).max(50);

export const createMatchBody = z.strictObject({
  name,
  areaIds,
  startAt,
  maxDays: maxDays.default(null),
  maxPlayers: maxPlayers.default(100),
  turnHours: turnHours.default(24),
  inviteCode: inviteCode.default(null),
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
  inviteCode: inviteCode.optional(),
  config: matchRulesOverrides.optional(),
});

/** What the owner may still change once registrations are open. */
export const OPEN_EDITABLE = ["name", "startAt", "maxDays", "maxPlayers", "inviteCode"] as const;

export const listMatchesQuery = z.object({
  name: z.string().trim().max(60).optional(),
  // Players enrolled: with free seats, up to 20, 21 to 50, more than 50.
  size: z.enum(["free", "s", "m", "l"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(6),
});

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
  inviteCode: z.string().trim().max(32).optional(),
});

import { z } from "zod";

const pct = z.number().min(0).max(100);
const count = z.number().int().min(0);

/**
 * Every numeric rule of a match. Nothing here may be hardcoded elsewhere:
 * `api` and `jobs` read these values from `Match.config`, which stores the
 * full object so that changing a default never alters an existing match.
 * Key names are shared with `jobs` (internal/rules/config.go).
 */
const matchRulesBase = z.strictObject({
  // Match start (provisional, see docs/SPEC.md)
  // One is enough: the other empires can be bots, or the player can be alone.
  minPlayersToStart: z.number().int().min(1).default(1),
  lateJoin: z.boolean().default(true),

  // Bots: empires played by the server, founded on free municipalities as turns go by.
  botsEnabled: z.boolean().default(false),
  // How many bots a match may have in all, counting those that fell.
  botsMax: z.number().int().min(0).max(100).default(5),
  // How many bots are there when the match starts: the opponents of a single player.
  botsAtStart: z.number().int().min(0).max(100).default(0),
  // Chance that a new bot appears when a turn begins.
  botSpawnChancePct: pct.default(30),

  // Resources (PROMPT §2.3, §2.4)
  startResources: count.default(200),
  hiddenMin: count.default(10),
  hiddenMax: count.default(100),
  hiddenMean: z.number().default(55),
  hiddenSd: z.number().positive().default(17),
  incomeBase: count.default(50),
  incomePerUnit: count.default(10),

  // Annexation (§2.3)
  annexCost: count.default(50),
  annexPerTurn: count.default(3),

  // Battles (§2.5, §9 #1 #4)
  /** How many territories an empire may attack in one turn. */
  attacksPerTurn: count.default(5),
  attackPct: pct.default(50),
  attackStepPct: pct.default(10),
  attackMaxPct: pct.default(100),
  defensePct: pct.default(50),
  surrenderRefundPct: pct.default(50),
  // Share of what is on a territory given up that its owner takes away with them: to a
  // territory of theirs bordering it, or else to their capital.
  retreatPct: pct.default(100),
  // What every municipality of a territory adds to its defence, free: a territory left
  // with nothing on it still has a chance.
  garrisonPerUnit: count.default(10),
  // Share of what the two sides spent on a battle that goes to whoever wins it.
  battleSpoilsPct: pct.default(70),
  // By how much one side must beat the other for a round to end the battle. Below it
  // nobody wins: the battle stays open as a siege and is fought again the next turn.
  // At zero every battle ends in its first round.
  siegeMarginPct: count.default(30),
  siegeCapitalMarginPct: count.default(60),

  // Capital (§2.9) and accumulation alert (§2.8)
  capitalMoveEveryTurns: count.default(3),
  accumAlertPct: pct.default(50),
  accumAlertMinTerritories: count.default(3),

  // Structures (§2.10, §9 #16)
  mergeCostTurns: z.number().min(0).default(0.5),
  mergeMaxUnits: z.number().int().min(2).default(5),
  secondCapitalCostTurns: z.number().min(0).default(20),
  blockCost: count.default(150),
  blockTurns: count.default(5),
  blockCooldownTurns: count.default(5),
  // The port: what it costs to build, and how likely one is found already there when a
  // free municipality on the sea is annexed, on an island and along a coast.
  portCost: count.default(100),
  portFoundIslandPct: pct.default(50),
  portFoundCoastPct: pct.default(20),
  // How far a port reaches, in kilometres between the centres of two municipalities,
  // as built and after each of its two upgrades. Zero: as far as the sea goes.
  portRangeKm: count.default(200),
  portRange2Km: count.default(500),
  portRange3Km: count.default(700),
  /** What each upgrade of a port costs. */
  portUpgradeCost: count.default(100),
  // The airport: built anywhere, it reaches by air whatever is in its range, sea or not.
  airportCost: count.default(300),
  airportRangeKm: count.default(1000),
  airportRange2Km: count.default(1500),
  airportRange3Km: count.default(2000),
  airportUpgradeCost: count.default(300),

  // Alliances (§2.6, §9 #9)
  // Alliances are pacts between two empires: this is how many an empire may hold at once.
  allianceMaxAllies: z.number().int().min(1).default(2),
  allianceLeaveNoticeTurns: count.default(1),

  // Board (§2.11)
  boardMaxChars: z.number().int().min(1).default(500),
  // Seconds an empire must wait between two messages (provisional value, see docs/SPEC.md).
  boardMessageIntervalSec: count.default(20),
});

/** Some of the rules: what an owner sends to depart from the defaults. */
export const matchRulesOverrides = matchRulesBase.partial();

export const matchRulesSchema = matchRulesBase
  .refine((rules) => rules.hiddenMin <= rules.hiddenMax, {
    path: ["hiddenMin"],
    message: "hiddenMin must not exceed hiddenMax",
  })
  .refine((rules) => rules.attackPct <= rules.attackMaxPct, {
    path: ["attackPct"],
    message: "attackPct must not exceed attackMaxPct",
  });

export type MatchRules = z.infer<typeof matchRulesSchema>;
export type MatchRulesInput = z.input<typeof matchRulesSchema>;

/** Completes a partial configuration with the defaults and validates the result. */
export function resolveMatchRules(overrides: MatchRulesInput = {}): MatchRules {
  return matchRulesSchema.parse(overrides);
}

export const DEFAULT_MATCH_RULES: Readonly<MatchRules> = Object.freeze(resolveMatchRules());

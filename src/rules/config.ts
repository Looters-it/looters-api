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
  minPlayersToStart: z.number().int().min(1).default(2),
  lateJoin: z.boolean().default(true),

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
  annexPerTurn: count.default(1),

  // Battles (§2.5, §9 #1 #4)
  attackPct: pct.default(50),
  attackStepPct: pct.default(10),
  attackMaxPct: pct.default(100),
  defensePct: pct.default(50),
  surrenderRefundPct: pct.default(50),

  // Capital (§2.9) and accumulation alert (§2.8)
  capitalMoveEveryTurns: count.default(3),
  accumAlertPct: pct.default(50),
  accumAlertMinTerritories: count.default(3),

  // Structures (§2.10, §9 #16)
  mergeCostTurns: z.number().min(0).default(0.5),
  mergeMaxUnits: z.number().int().min(2).default(5),
  secondCapitalCostTurns: z.number().min(0).default(20),
  blockCost: count.default(300),
  blockTurns: count.default(5),
  blockCooldownTurns: count.default(5),

  // Alliances (§2.6, §9 #9)
  allianceMaxMembers: z.number().int().min(2).default(3),
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

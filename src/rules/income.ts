import type { MatchRules } from "./config.js";

/**
 * What an empire earns each turn: a fixed base plus a share for every
 * municipality it controls (PROMPT §2.3). It is also the "value of one
 * turn" used to price structures (§2.10). `jobs` computes the same amount
 * when it closes a turn (internal/turnclose).
 */
export function turnIncome(
  rules: Pick<MatchRules, "incomeBase" | "incomePerUnit">,
  units: number,
): number {
  return rules.incomeBase + rules.incomePerUnit * units;
}

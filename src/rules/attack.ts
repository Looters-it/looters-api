import type { MatchRules } from "./config.js";

type AttackRules = Pick<MatchRules, "attackPct" | "attackStepPct" | "attackMaxPct">;

/**
 * Share of its resources that each territory used in an attack pays: it
 * grows with the number of territories, up to a ceiling (PROMPT §2.5, §9 #4).
 */
export function attackCostPct(rules: AttackRules, territories: number): number {
  const pct = rules.attackPct + rules.attackStepPct * Math.max(0, territories - 1);
  return Math.min(rules.attackMaxPct, pct);
}

/** A percentage of an amount, rounded up: a cost is never rounded in the payer's favour. */
export function costOf(resources: number, pct: number): number {
  return Math.ceil((resources * pct) / 100);
}

export interface AttackPlan {
  pct: number;
  /** What each territory pays, in the order given. */
  costs: number[];
  totalCost: number;
  /**
   * Strength in the field: the resources on the territories when the attack
   * is declared, before the cost is paid (PROMPT §9 #2).
   */
  force: number;
}

export function planAttack(rules: AttackRules, resources: number[]): AttackPlan {
  const pct = attackCostPct(rules, resources.length);
  const costs = resources.map((amount) => costOf(amount, pct));
  return {
    pct,
    costs,
    totalCost: costs.reduce((sum, cost) => sum + cost, 0),
    force: resources.reduce((sum, amount) => sum + amount, 0),
  };
}

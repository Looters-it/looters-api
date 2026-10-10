import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_RULES, resolveMatchRules } from "../src/rules/config.js";

describe("match rules configuration", () => {
  it("uses the defaults accepted in PROMPT §2 and §9", () => {
    expect(DEFAULT_MATCH_RULES).toMatchObject({
      startResources: 200,
      hiddenMin: 10,
      hiddenMax: 100,
      incomeBase: 50,
      incomePerUnit: 10,
      annexCost: 50,
      annexPerTurn: 1,
      attackPct: 50,
      attackStepPct: 10,
      attackMaxPct: 100,
      defensePct: 50,
      surrenderRefundPct: 50,
      battleSpoilsPct: 70,
      capitalMoveEveryTurns: 3,
      accumAlertPct: 50,
      accumAlertMinTerritories: 3,
      mergeCostTurns: 0.5,
      mergeMaxUnits: 5,
      secondCapitalCostTurns: 20,
      blockCost: 300,
      blockTurns: 5,
      blockCooldownTurns: 5,
      allianceMaxAllies: 2,
      boardMaxChars: 500,
    });
  });

  it("merges overrides and keeps every other default", () => {
    const rules = resolveMatchRules({ annexCost: 80 });
    expect(rules.annexCost).toBe(80);
    expect(rules.incomeBase).toBe(DEFAULT_MATCH_RULES.incomeBase);
  });

  it("rejects unknown keys and inconsistent values", () => {
    expect(() => resolveMatchRules({ anexCost: 80 } as never)).toThrow();
    expect(() => resolveMatchRules({ attackPct: 120 })).toThrow();
    expect(() => resolveMatchRules({ hiddenMin: 90, hiddenMax: 20 })).toThrow();
  });
});

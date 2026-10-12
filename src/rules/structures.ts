import type { MatchRules } from "./config.js";

/**
 * What a structure does, as flags that the rest of the game reads. They are
 * copied into `Structure.data.effects` when the structure is built, so that
 * `jobs` and the battle rules act on effects and never on structure types:
 * a new structure that reuses these effects needs no change anywhere else.
 */
export type StructureEffect =
  /** The territory cannot be the target of an attack. */
  | "NO_ATTACK_ON"
  /** The territory cannot start or join an attack. */
  | "NO_ATTACK_FROM"
  /** If the main capital is conquered this territory becomes the capital and the empire survives. */
  | "BACKUP_CAPITAL"
  /**
   * From this territory the empire reaches every territory on the sea, bordering or
   * not: to attack it or to annex it. It stays with the territory when it is conquered.
   */
  | "SEA_REACH"
  /**
   * From this territory the empire reaches every territory in its range, on the sea or
   * not. Like a port, it stays with the territory when it is conquered.
   */
  | "AIR_REACH";

/** Why a structure cannot be built on a territory. Codes are translated by the web interface. */
export type StructureBlock =
  | "IN_BATTLE"
  | "ON_CAPITAL"
  | "ALREADY_HERE"
  | "ONE_PER_EMPIRE"
  | "COOLDOWN"
  | "NOT_ON_COAST"
  | "NOT_ENOUGH_RESOURCES";

export interface StructureSite {
  isCapital: boolean;
  inBattle: boolean;
  resources: number;
  /** Structures of this type the empire already has, active. */
  ownedByEmpire: number;
  /** Whether one of this type is active on the territory. */
  activeHere: boolean;
  /** Last turn of the cooldown after a previous one of this type here, if any. */
  cooldownUntilTurn: number | null;
  currentTurn: number;
  /** Whether the territory has access to the sea. */
  coastal: boolean;
}

/**
 * One entry of the catalogue (PROMPT §2.10). Everything about a structure
 * is declared here: adding one means adding an entry (and its rule values
 * to the match configuration), with no change to the database schema or to
 * the turn logic.
 */
export interface StructureDefinition {
  type: string;
  /** Cost in resources, paid from the territory it is built on. `turnValue` is the empire's income per turn now. */
  cost(rules: MatchRules, turnValue: number): number;
  /** How many turns it lasts, counting the one it is built in; null if permanent. */
  durationTurns(rules: MatchRules): number | null;
  /** Turns that must pass after it expires before another can be built on the same territory. */
  cooldownTurns?(rules: MatchRules): number;
  /** At most this many active per empire. */
  maxPerEmpire?: number;
  /** Cannot be built on the capital. */
  notOnCapital?: boolean;
  /** Only on a territory with access to the sea. */
  onCoastOnly?: boolean;
  /** Turns between two moves to another own territory, if it can be moved at all. */
  moveEveryTurns?(rules: MatchRules): number;
  /**
   * For a structure that reaches far: its range in kilometres at each level, the first
   * being the one it is built with. Each further one is an upgrade. Zero is no limit.
   */
  rangesKm?(rules: MatchRules): number[];
  /** What it costs to take it from this level to the next. */
  upgradeCost?(rules: MatchRules, level: number): number;
  effects: StructureEffect[];
}

/** What a structure stores about its reach when it is built or upgraded to a level. */
export function reachOf(definition: StructureDefinition, rules: MatchRules, level: number) {
  const ranges = definition.rangesKm?.(rules);
  if (!ranges) return {};
  return { level, rangeKm: ranges[Math.min(level, ranges.length) - 1] ?? 0 };
}

/** The level a stored structure is at: the first, unless it was upgraded. */
export const levelOf = (data: unknown): number => (data as { level?: number }).level ?? 1;

/** The value of N turns of income, rounded up (PROMPT §2.10, §9 #18). */
export const turnsToResources = (turns: number, turnValue: number) => Math.ceil(turns * turnValue);

const catalogue = new Map<string, StructureDefinition>();

export function registerStructure(definition: StructureDefinition): void {
  catalogue.set(definition.type, definition);
}
export function unregisterStructure(type: string): void {
  catalogue.delete(type);
}
export const structureCatalogue = (): StructureDefinition[] => [...catalogue.values()];
export const structureDefinition = (type: string): StructureDefinition | undefined =>
  catalogue.get(type);

/** The first reason a structure cannot be built on a site, or null when it can. */
export function structureBlock(
  definition: StructureDefinition,
  site: StructureSite,
  cost: number,
): StructureBlock | null {
  if (site.inBattle) return "IN_BATTLE";
  if (definition.notOnCapital && site.isCapital) return "ON_CAPITAL";
  if (definition.onCoastOnly && !site.coastal) return "NOT_ON_COAST";
  if (site.activeHere) return "ALREADY_HERE";
  if (definition.maxPerEmpire !== undefined && site.ownedByEmpire >= definition.maxPerEmpire) {
    return "ONE_PER_EMPIRE";
  }
  if (site.cooldownUntilTurn !== null && site.currentTurn <= site.cooldownUntilTurn) {
    return "COOLDOWN";
  }
  if (site.resources < cost) return "NOT_ENOUGH_RESOURCES";
  return null;
}

// ---------- The structures of the game ----------

/** Military block: for a few turns the territory cannot be attacked, and cannot attack either. */
registerStructure({
  type: "BLOCK",
  cost: (rules) => rules.blockCost,
  durationTurns: (rules) => rules.blockTurns,
  cooldownTurns: (rules) => rules.blockCooldownTurns,
  effects: ["NO_ATTACK_ON", "NO_ATTACK_FROM"],
});

/** Second capital: if the main one is conquered, the empire does not fall. */
registerStructure({
  type: "SECOND_CAPITAL",
  cost: (rules, turnValue) => turnsToResources(rules.secondCapitalCostTurns, turnValue),
  durationTurns: () => null,
  maxPerEmpire: 1,
  notOnCapital: true,
  moveEveryTurns: (rules) => rules.capitalMoveEveryTurns,
  effects: ["BACKUP_CAPITAL"],
});

/**
 * Port: from the territory it stands on, every territory on the sea can be reached,
 * islands and coasts that share no border with the empire. Built where there is sea;
 * an island that an empire starts from has one, and one may be found on annexing.
 */
registerStructure({
  type: "PORT",
  cost: (rules) => rules.portCost,
  durationTurns: () => null,
  onCoastOnly: true,
  rangesKm: (rules) => [rules.portRangeKm, rules.portRange2Km, rules.portRange3Km],
  upgradeCost: (rules) => rules.portUpgradeCost,
  effects: ["SEA_REACH"],
});

/**
 * Airport: built on any territory, by the sea or not, it reaches every territory in its
 * range, which two upgrades make wider.
 */
registerStructure({
  type: "AIRPORT",
  cost: (rules) => rules.airportCost,
  durationTurns: () => null,
  rangesKm: (rules) => [rules.airportRangeKm, rules.airportRange2Km, rules.airportRange3Km],
  upgradeCost: (rules) => rules.airportUpgradeCost,
  effects: ["AIR_REACH"],
});

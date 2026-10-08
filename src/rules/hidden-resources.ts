import { randomInt } from "node:crypto";
import type { MatchRules } from "./config.js";

/** A source of uniform numbers in [0, 1). */
export type Random = () => number;

/** Uniform numbers from the operating system's secure generator. */
export const secureRandom: Random = () => randomInt(0, 2 ** 47) / 2 ** 47;

type HiddenRules = Pick<MatchRules, "hiddenMin" | "hiddenMax" | "hiddenMean" | "hiddenSd">;

/**
 * The hidden starting resources of one municipality (PROMPT §2.4): a normal
 * distribution cut to [hiddenMin, hiddenMax], so that middle values are the
 * most frequent and high ones are rare. With the defaults about 8% of the
 * municipalities get 80 or more.
 */
export function drawHiddenResources(rules: HiddenRules, random: Random = secureRandom): number {
  const { hiddenMin, hiddenMax, hiddenMean, hiddenSd } = rules;
  // Draws outside the range are thrown away, not clamped: clamping would
  // pile them up on the two limits.
  for (let attempt = 0; attempt < 1000; attempt++) {
    // Box-Muller transform of two uniform numbers into a normal one.
    const u = 1 - random();
    const v = random();
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const value = Math.round(hiddenMean + hiddenSd * normal);
    if (value >= hiddenMin && value <= hiddenMax) return value;
  }
  // A mean far outside the range: fall back to a uniform draw inside it.
  return hiddenMin + Math.floor(random() * (hiddenMax - hiddenMin + 1));
}

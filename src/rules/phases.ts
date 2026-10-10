/**
 * A turn has two parts. In the first, the preliminary one, an empire is put in order:
 * resources moved between its territories, structures built or moved, territories
 * merged, the capital moved. In the second it acts on the others: annexations and
 * attacks. Nothing is stored for it: the part a turn is in follows from when it ends
 * and how long it lasts.
 */
export type TurnPhase = "PRELIMINARY" | "ACTION";

/** The share of a turn that is preliminary: ten seconds of a rush turn of thirty. */
export const PRELIMINARY_SHARE = 1 / 3;

interface Clock {
  turnEndsAt: Date | null;
  turnHours: number;
}

/** When the preliminary part of the turn being played ends, or null when no turn is. */
export function preliminaryEndsAt(match: Clock): Date | null {
  if (!match.turnEndsAt) return null;
  const length = match.turnHours * 3_600_000;
  return new Date(match.turnEndsAt.getTime() - Math.round(length * (1 - PRELIMINARY_SHARE)));
}

export function phaseOf(match: Clock, now: Date = new Date()): TurnPhase {
  const end = preliminaryEndsAt(match);
  return end !== null && now < end ? "PRELIMINARY" : "ACTION";
}

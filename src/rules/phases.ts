/**
 * A turn has two parts. In the first, the preliminary one, an empire is put in order:
 * resources moved between its territories, structures built or moved, territories
 * merged, the capital moved. In the second it acts on the others: annexations and
 * attacks. Nothing is stored for it: the part a turn is in follows from when it ends
 * and how long it lasts.
 */
export type TurnPhase = "PRELIMINARY" | "ACTION";

/**
 * The preliminary part is a third of the turn, but no less than thirty seconds, so that
 * there is time to do something in it, and no more than half the turn, so that the
 * action is never the shorter part: thirty seconds of a rush turn of sixty.
 */
export const PRELIMINARY_SHARE = 1 / 3;
export const PRELIMINARY_MIN_MS = 30_000;
export const PRELIMINARY_MAX_SHARE = 1 / 2;

/** How long the preliminary part of a turn of this length lasts. */
export function preliminaryMs(turnHours: number): number {
  const length = turnHours * 3_600_000;
  return Math.round(
    Math.min(
      length * PRELIMINARY_MAX_SHARE,
      Math.max(length * PRELIMINARY_SHARE, PRELIMINARY_MIN_MS),
    ),
  );
}

interface Clock {
  turnEndsAt: Date | null;
  turnHours: number;
}

/** When the preliminary part of the turn being played ends, or null when no turn is. */
export function preliminaryEndsAt(match: Clock): Date | null {
  if (!match.turnEndsAt) return null;
  const length = Math.round(match.turnHours * 3_600_000);
  return new Date(match.turnEndsAt.getTime() - length + preliminaryMs(match.turnHours));
}

export function phaseOf(match: Clock, now: Date = new Date()): TurnPhase {
  const end = preliminaryEndsAt(match);
  return end !== null && now < end ? "PRELIMINARY" : "ACTION";
}

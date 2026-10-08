/**
 * What a player can pick for an empire (PROMPT §2.7). Both lists are fixed
 * sets: nothing is uploaded, so nothing needs moderation.
 */

/** Emblem keys; the web interface draws each one inside a shield. */
export const EMPIRE_EMBLEMS = [
  "torre",
  "stella",
  "croce",
  "corona",
  "scudo",
  "rombo",
  "bande",
  "scacchi",
  "monte",
  "luna",
] as const;

export type EmpireEmblem = (typeof EMPIRE_EMBLEMS)[number];

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/**
 * Colours an empire can take. A colour is unique inside a match, so this
 * list is also the upper limit of players per match.
 *
 * Provisional: 24 hues in 5 tones, generated. They are distinct as values
 * but many are hard to tell apart on the map; the dedicated palette is
 * still to be designed (PROMPT §11, BACKLOG M0-11).
 */
export const EMPIRE_COLORS: readonly string[] = [
  [70, 36],
  [55, 52],
  [85, 44],
  [40, 66],
  [35, 28],
].flatMap(([saturation, lightness]) =>
  Array.from({ length: 24 }, (_, i) => hslToHex(i * 15, saturation ?? 0, lightness ?? 0)),
);

export const MAX_PLAYERS_LIMIT = EMPIRE_COLORS.length;

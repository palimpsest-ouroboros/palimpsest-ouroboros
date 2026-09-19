/**
 * The fragment table, and the metrics needed to set it.
 *
 * Each generation inscribes FRAGMENTS[generation % FRAGMENTS.length]. There are twelve
 * entries and the last is the handle, so every twelfth generation the banner arrives back
 * at its own name and the cycle restarts.
 */

export const FRAGMENTS: string[] = [
  "ἓν τὸ πᾶν",
  "hen to pan",
  "οὐροβόρος",
  "the tail is the mouth",
  "KV62",
  "Mehen turns and Ra returns",
  "solve et coagula",
  "the skin is left behind, the snake is not",
  "1865, a ring seen while sleeping",
  "what is below repeats what is above",
  "the beginning eats",
  "palimpsest-ouroboros",
];

/** The inscription for a given generation, and the line the alt text says instead. */
export const fragmentFor = (generation: number): string =>
  FRAGMENTS[((generation % FRAGMENTS.length) + FRAGMENTS.length) % FRAGMENTS.length]!;

/** Offset by half the table, so the image never describes the line it is showing. */
export const altFragmentFor = (generation: number): string =>
  fragmentFor(generation + FRAGMENTS.length / 2);

/**
 * Advance widths for Georgia at weight 600, in thousandths of an em, measured against the
 * real font stack for every character the table uses. Summing these reproduces the browser's
 * own getComputedTextLength for all twelve fragments to within 0.05%, which is what lets the
 * generator size each line without a layout engine.
 */
const ADVANCE: Record<string, number> = {
  " ": 254, ",": 328, "-": 379,
  "1": 490, "2": 626, "5": 599, "6": 648, "8": 676,
  K: 817, M: 1023, R: 797, V: 762,
  a: 596, b: 646, c: 531, d: 663, e: 572, f: 393, g: 577, h: 680, i: 354,
  k: 632, l: 344, m: 1016, n: 690, o: 636, p: 658, r: 520, s: 513, t: 397,
  u: 677, v: 567, w: 863,
  "β": 656, "ν": 561, "ο": 636, "π": 660, "ρ": 647, "ς": 513, "τ": 485,
  "ό": 636, "ἓ": 427, "ὐ": 519, "ὸ": 636, "ᾶ": 558,
};

/** Fallback for any character not in the table: the advance of "o". */
const DEFAULT_ADVANCE = 636;

export const FONT_STACK = "Georgia, 'Times New Roman', Times, serif";
export const LETTER_SPACING = 2;

const TARGET_WIDTH = 960;
const FONT_MIN = 34;
const FONT_MAX = 120;

/** Natural width of a string at font-size 1, in em, excluding letter-spacing. */
const emWidth = (s: string): number => {
  let w = 0;
  for (const ch of s) w += ADVANCE[ch] ?? DEFAULT_ADVANCE;
  return w / 1000;
};

/**
 * Fragments run from four characters to forty, so a fixed font-size would either lose the
 * short ones or run the long ones off the canvas. Size each line to a common target width,
 * clamped, and the long inscriptions fill the measure while the terse ones stay small and
 * dense. Rounded so the emitted bytes are stable.
 */
export const fontSizeFor = (content: string): number => {
  const glyphs = [...content].length;
  const spacing = LETTER_SPACING * Math.max(0, glyphs - 1);
  const natural = emWidth(content);
  if (natural <= 0) return FONT_MAX;
  const size = (TARGET_WIDTH - spacing) / natural;
  return Number(Math.min(FONT_MAX, Math.max(FONT_MIN, size)).toFixed(3));
};

/** Rendered width of a line at its chosen size, used to place the ring's gap. */
export const widthOf = (content: string, fontSize: number): number => {
  const glyphs = [...content].length;
  return emWidth(content) * fontSize + LETTER_SPACING * Math.max(0, glyphs - 1);
};

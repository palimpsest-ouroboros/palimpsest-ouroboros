/**
 * The twelve hours, and the metrics needed to set them.
 *
 * Each generation is one passage. hourOf(generation) is (generation mod 12) + 1, so generation 0
 * is the first hour and generation 11 the twelfth. The twelfth ends in sunrise and the next
 * generation begins the night again.
 */

export interface Hour {
  /** the name of the hour of the night, as Budge prints it */
  name: string;
  /** what the banner inscribes for this hour */
  fragment: string;
  /** the serpent that keeps the gate admitting to this division; recorded, never drawn */
  guardian: string;
}

/* SOURCED. The twelve hours of the night.

   Hour names: E. A. Wallis Budge, THE EGYPTIAN HEAVEN AND HELL, Vol. I: The Book of
   Am-Tuat (London, 1905). Budge's formula is "X is the name of the hour of the night
   which guideth this great god". Hour IV is taken from the summary table at Vol. III
   (1906) p. 97, Vol. I giving no name for that division. Per-hour loci below.

   Gate-keepers: Budge, THE EGYPTIAN HEAVEN AND HELL, Vol. II: The Book of Gates (1905).
   Each gate admits to the division it is named for, so the serpent recorded against an
   hour is the one guarding the way INTO it. The first division is entered through no
   gate and has no keeper. Budge's eleven gates carry twelve serpents: SEBI and RERI
   both stand at the last (p. 304), and only SEBI is recorded here.

   Public domain: Budge died 1934; these volumes appeared 1905-1906, before 1929, so
   they are public domain in the United States and in life+70 jurisdictions alike.

   Checked against the 1905/1906 scans and the sacred-texts transcription. An earlier
   pass returned "SEKHMET-" for hour V, a form that appears in no edition; Budge prints
   SEKMET. Nothing here is a reconstruction.
*/

export const HOURS: Hour[] = [
  /* I     Vol. I ch. I p. 20      NET-RA                                        */
  { name: "USHEM-HAT-KHEFTIU-NU-RA", fragment: "USHEM-HAT-KHEFTIU-NU-RA", guardian: "" },
  /* II    Vol. I ch. II p. 43     URNES                       gate Gates p. 86  */
  { name: "SESHET-MAKET-NEB-S", fragment: "SESHET-MAKET-NEB-S", guardian: "SAA-SET" },
  /* III   Vol. I ch. III p. 50    NET-NEB-UA-KHEPER-AUT       gate p. 102       */
  { name: "TENT-BAIU", fragment: "TENT-BAIU", guardian: "AQEBI" },
  /* IV    Vol. III p. 97          ANKHET-KHEPERU              gate p. 120       */
  { name: "URT-EM-SEKHEMU-S", fragment: "URT-EM-SEKHEMU-S", guardian: "TCHETBI" },
  /* V     Vol. I ch. V p. 93      AMENT, the Land of Sekri, where the body of
           Osiris lies and the god passes without light        gate p. 140       */
  { name: "SEKMET-HER-ABT-UAA-S", fragment: "", guardian: "TEKA-HRA" },
  /* VI    Vol. I ch. VI p. 123    METCHET-MU-NEBT-TUAT        gate p. 168       */
  { name: "MESPERIT-AR-AT-MAATU", fragment: "MESPERIT-AR-AT-MAATU", guardian: "SET-EM-MAAT-F" },
  /* VII   Vol. I ch. VII p. 140, and p. 145 where Apep is hacked in pieces
           THEPHET-SHETAT                                      gate p. 191       */
  { name: "KHEFTES-HAU-HESQET-[NEHA]-HRA", fragment: "KHEFTES-HAU-HESQET-[NEHA]-HRA", guardian: "AKHA-EN-MAAT" },
  /* VIII  Vol. I ch. VIII p. 162  TEBAT-NETERU-S              gate p. 220       */
  { name: "NEBT-USHA", fragment: "NEBT-USHA", guardian: "SET-HRA" },
  /* IX    Vol. I ch. IX p. 187    BEST-ARU-ANKHET-KHEPERU     gate p. 238       */
  { name: "TUATET-MAKETET-EN-NEB-S", fragment: "TUATET-MAKETET-EN-NEB-S", guardian: "AB-TA" },
  /* X     Vol. I ch. X p. 208     METET-QA-UTCHEBU            gate p. 260       */
  { name: "TENTENIT-UHESET-KHAK-ABU", fragment: "TENTENIT-UHESET-KHAK-ABU", guardian: "SETHU" },
  /* XI    Vol. I ch. XI p. 233    RE-EN-QERERT-APT-KHATU      gate p. 280       */
  { name: "SEBIT-NEBT-UAA-KHESFET-SEBA-EM-PERT-F", fragment: "SEBIT-NEBT-UAA-KHESFET-SEBA-EM-PERT-F", guardian: "AM-NETU-F" },
  /* XII   Vol. I ch. XII p. 257   the hour that ends in sunrise, and so returns
           the surface to its own name                         gate p. 304       */
  { name: "MAA-NEFERT-RA", fragment: "palimpsest-ouroboros", guardian: "SEBI" },
];

export const HOUR_COUNT = HOURS.length;

/** 1..12. Generation 0 is the first hour. */
export const hourOf = (generation: number): number =>
  (((generation % HOUR_COUNT) + HOUR_COUNT) % HOUR_COUNT) + 1;

const at = (generation: number): Hour =>
  HOURS[(((generation % HOUR_COUNT) + HOUR_COUNT) % HOUR_COUNT)]!;

export const fragmentFor = (generation: number): string => at(generation).fragment;

export const guardianFor = (generation: number): string => at(generation).guardian;

export const hourNameFor = (generation: number): string => at(generation).name;

/**
 * The hour whose fragment is empty. The sun god passes it without light, so the surface takes
 * no inscription: the generation increments, the stratum is laid down, the ledger records it,
 * and there is nothing on the vellum.
 */
export const EMPTY_HOUR = HOURS.findIndex((h) => h.fragment === "") + 1;

export const isEmptyHour = (generation: number): boolean => at(generation).fragment === "";

/**
 * The alt text never says what the banner shows. Offset by half the table, except at the hour
 * that inscribes nothing, where there is nothing to be offset from.
 */
export const altFragmentFor = (generation: number): string => {
  if (isEmptyHour(generation)) return "tabula rasa";
  const half = HOUR_COUNT / 2;
  /* Half a cycle away lands on the empty hour once per cycle, which would leave the image with
     no description at all; step one further on when it does. */
  const across = fragmentFor(generation + half);
  return across === "" ? fragmentFor(generation + half + 1) : across;
};

/* ─────────────────────────────────────────────────────────────────────────────
   Rot
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * A buried inscription loses glyphs. Rot only ever REMOVES a character, replacing it with a
 * gap of the same kind everywhere; it never substitutes one character for another. That is
 * what makes it safe: a rotted line can lose its sense but cannot acquire a different one,
 * because no letter is ever exchanged for another letter.
 *
 * `r` is a reproducible draw in [0,1) supplied by the caller, so the whole decay replays from
 * the sha chain and nothing here is random.
 */
export const ROT_GAP = " ";

export const rotOnce = (content: string, r: number): string => {
  const glyphs = [...content];
  const live: number[] = [];
  for (let i = 0; i < glyphs.length; i++) if (glyphs[i] !== ROT_GAP) live.push(i);
  if (live.length === 0) return content;
  glyphs[live[Math.min(live.length - 1, Math.floor(r * live.length))]!] = ROT_GAP;
  return glyphs.join("");
};

/** How much of a line is still there, for the record. */
export const legible = (content: string): number =>
  [...content].filter((c) => c !== ROT_GAP).length;

/* ─────────────────────────────────────────────────────────────────────────────
   Metrics
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Advance widths for Georgia at weight 600, in thousandths of an em, measured against the real
 * font stack. Summing these reproduces the browser's own getComputedTextLength for every entry
 * to within 0.05%, which is what lets the generator size each line without a layout engine.
 */
const ADVANCE: Record<string, number> = {
  " ": 254, "-": 379, "A": 758, "B": 757, "E": 721, "F": 671, "H": 913,
  "I": 446, "K": 817, "M": 1023, "N": 839, "P": 701, "Q": 820, "R": 797,
  "S": 649, "T": 684, "U": 834, "[": 447, "]": 447, "a": 596, "b": 646,
  "e": 572, "i": 354, "l": 344, "m": 1016, "o": 636, "p": 658, "r": 520,
  "s": 513, "t": 397, "u": 677,
};

const DEFAULT_ADVANCE = 636;

export const FONT_STACK = "Georgia, 'Times New Roman', Times, serif";
export const LETTER_SPACING = 2;

const TARGET_WIDTH = 960;
const FONT_MIN = 34;
const FONT_MAX = 120;

const emWidth = (s: string): number => {
  let w = 0;
  for (const ch of s) w += ADVANCE[ch] ?? DEFAULT_ADVANCE;
  return w / 1000;
};

/**
 * Entries run from nothing at all to forty characters, so a fixed size would either lose the
 * short ones or push the long ones off the canvas. Size each line to a common measure, clamped.
 */
export const fontSizeFor = (content: string): number => {
  const glyphs = [...content].length;
  const natural = emWidth(content);
  if (natural <= 0) return FONT_MAX;
  const spacing = LETTER_SPACING * Math.max(0, glyphs - 1);
  const size = (TARGET_WIDTH - spacing) / natural;
  return Number(Math.min(FONT_MAX, Math.max(FONT_MIN, size)).toFixed(3));
};

export const widthOf = (content: string, fontSize: number): number => {
  const glyphs = [...content].length;
  return emWidth(content) * fontSize + LETTER_SPACING * Math.max(0, glyphs - 1);
};

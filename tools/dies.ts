/**
 * dies.ts — whether today is a day on which nothing may be begun.
 *
 * Exit 0 always. Reports religiosus=true|false on stdout, and to $GITHUB_OUTPUT when set.
 *
 * SOURCED. Every rule below is attested. The public-domain editions used are
 *
 *   W. Warde Fowler, THE ROMAN FESTIVALS OF THE PERIOD OF THE REPUBLIC (London, 1899)
 *   Aulus Gellius, ATTIC NIGHTS, tr. W. Beloe (1795) / the Latin of IV.ix and V.xvii
 *   Livy, tr. Canon Roberts (Everyman, 1905)
 *   Ovid, FASTI, tr. H. T. Riley (1851)
 *   Macrobius, SATURNALIA I.xvi (for the mundus, quoting Varro and Cato)
 *
 * Gellius V.xvii preserves the definition: days are called religiosi "which are of
 * ill-fame and are hampered by an evil omen", and Verrius Flaccus is cited there for the
 * rule that the days after the Kalends, Nones and Ides are counted among them. Fowler
 * 1899 walks the calendar day by day and marks them.
 *
 * NOT implemented, deliberately: Gellius adds that "many also avoid the fourth day
 * before the Kalends, Nones and Ides". He reports it as a practice of many rather than
 * as the rule, so it is left out.
 */

const MONTHS_WITH_LATE_NONES = [3, 5, 7, 10];

/** Kalends are the 1st; Nones the 5th, or the 7th in March, May, July and October. */
const nones = (month: number): number => (MONTHS_WITH_LATE_NONES.includes(month) ? 7 : 5);

/** The Ides fall eight days after the Nones. */
const ides = (month: number): number => nones(month) + 8;

interface Rule {
  hit: (month: number, day: number) => boolean;
  why: string;
}

const RULES: Rule[] = [
  {
    /* Gellius V.xvii, citing Verrius Flaccus; Livy VI.i on the day after the Ides;
       Fowler 1899 passim. The day after each of the three fixed points. */
    hit: (m, d) => d === 2 || d === nones(m) + 1 || d === ides(m) + 1,
    why: "postriduanus",
  },
  {
    /* The mundus stood open on three days and the gate of the gods below with it.
       Varro in Macrobius, Saturnalia I.xvi; Fowler 1899 on 24 Aug, 5 Oct, 8 Nov. */
    hit: (m, d) => (m === 8 && d === 24) || (m === 10 && d === 5) || (m === 11 && d === 8),
    why: "mundus patet",
  },
  {
    /* Ovid, Fasti V; Fowler 1899 marks 9, 11 and 13 May LEMURIA. Temples shut. */
    hit: (m, d) => m === 5 && (d === 9 || d === 11 || d === 13),
    why: "Lemuria",
  },
  {
    /* Livy VI.i and Gellius V.xvii on the dies Alliensis; Fowler 1899, "18. Dies
       Alliensis". The defeat at the Allia, held more calamitous than any other day. */
    hit: (m, d) => m === 7 && d === 18,
    why: "dies Alliensis",
  },
  {
    /* Ovid, Fasti VI; Fowler 1899 on the closed days while the Vestals' cleansing was
       in hand, ending when the sweepings went to the Tiber on 15 June. */
    hit: (m, d) => m === 6 && d >= 7 && d <= 15,
    why: "quando stercus delatum fas",
  },
  {
    /* Livy XXXVII.xxxiii: the army would not move while the ancilia were being carried.
       Fowler 1899 on 19-23 March and the Armilustrium of 19 October. */
    hit: (m, d) => (m === 3 && d >= 19 && d <= 24) || (m === 10 && d === 19),
    why: "ancilia mota",
  },
];

const parse = (argv: string[]): Date => {
  for (const a of argv) {
    if (a.startsWith("--date=")) {
      const [y, m, d] = a.slice(7).split("-").map((n) => Number.parseInt(n, 10));
      return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
    }
  }
  return new Date();
};

const when = parse(process.argv.slice(2));
const month = when.getUTCMonth() + 1;
const day = when.getUTCDate();

const hits = RULES.filter((r) => r.hit(month, day));
const religiosus = hits.length > 0;

const report = [
  `date=${when.toISOString().slice(0, 10)}`,
  `religiosus=${religiosus ? "true" : "false"}`,
  `reason=${hits.map((h) => h.why).join(",")}`,
];
process.stdout.write(`${report.join("\n")}\n`);

const out = process.env.GITHUB_OUTPUT;
if (out !== undefined && out !== "") {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(out, `${report.join("\n")}\n`, "utf8");
}

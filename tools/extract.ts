/**
 * extract.ts — read the coordinate watermark back out of a candidate file.
 *
 * The mechanism is described in full in tools/canary.ts. This is the reader, and it is
 * deliberately separate: a third party in a dispute should be able to take this one file
 * and canary.ts, point them at a suspect SVG, and get an answer without running the
 * generator or trusting anything else in the repository.
 *
 *   node --experimental-strip-types tools/extract.ts <file> [<file> ...] [flags]
 *
 *     --expect=<sha>   check the recovered tag against a commit sha you expect
 *     --json           machine-readable output
 *     --selftest       run the repository's own artifacts through every transform the
 *                      watermark is supposed to survive, and report recovery for each
 *
 * ── the confidence figure ─────────────────────────────────────────────────────
 *
 * Confidence here is not a feeling, it is the answer to one question: how likely is a
 * file that has nothing to do with this work to produce this result by chance?
 *
 * The first 32 bits of the signature are a fixed constant. An unrelated SVG's
 * coordinates land in the 64 slots arbitrarily, so each of those 32 bits comes out right
 * with probability one half, independently. Recovering k of 32 correct by luck has
 * probability
 *
 *     P(k or better) = 2^-32 * sum from j=k to 32 of C(32, j)
 *
 * which this file computes exactly, in integer arithmetic. All 32 correct is one chance
 * in 4,294,967,296. That figure is the whole claim, and it is reported whether it is
 * good or bad.
 *
 * Two things it is NOT:
 *
 *   • It is not a measure of how confident you should be that a file was STOLEN. It
 *     says the file carries this signature. Somebody who read canary.ts could write the
 *     same signature into an unrelated file on purpose; the mechanism is published, so
 *     forging it takes no cleverness. What the watermark is good for is the ordinary
 *     case, where a copier did not know it was there.
 *
 *   • Slot agreement — how unanimously the carriers in a slot voted — is reported too,
 *     but it is a measure of carrier damage, not of authorship. An untouched file with
 *     one-decimal coordinates has perfect agreement and no signature at all, because
 *     every coordinate votes zero. Agreement qualifies the magic match; it never
 *     substitutes for it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAGIC, SIGNATURE_BITS, SPARSE_BELOW, recover, shaTag, walkPath, walkPoints, witness } from "./canary.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ─────────────────────────────────────────────────────────────────────────────
   Exact binomial tail
   ───────────────────────────────────────────────────────────────────────────── */

const choose = (n: number, k: number): bigint => {
  if (k < 0 || k > n) return 0n;
  let r = 1n;
  for (let i = 0; i < k; i++) r = (r * BigInt(n - i)) / BigInt(i + 1);
  return r;
};

/** P(at least `k` of `n` fair coins come up right), as an exact rational reduced to a float. */
const tail = (k: number, n: number): number => {
  let num = 0n;
  for (let j = k; j <= n; j++) num += choose(n, j);
  const den = 1n << BigInt(n);
  /* The ratio is tiny; do the division in floating point after scaling. */
  return Number((num * 10n ** 20n) / den) / 1e20;
};

const oneIn = (p: number): string =>
  p <= 0 ? "0" : p >= 1 ? "1" : Math.round(1 / p).toLocaleString("en-US");

/* ─────────────────────────────────────────────────────────────────────────────
   Report
   ───────────────────────────────────────────────────────────────────────────── */

interface Verdict {
  file: string;
  carriers: number;
  magicBitsCorrect: number;
  magicMatches: boolean;
  shaTagHex: string;
  minAgreement: number;
  meanAgreement: number;
  emptySlots: number;
  minVotes: number;
  pByChance: number;
  sparse: boolean;
  expected?: string;
  expectedMatches?: boolean;
  /** only with --expect: carriers that agree with THAT sha's signature, out of all of them */
  witnessAgreeing?: number;
  witnessTotal?: number;
}

const magicWanted = ((): number[] => {
  const w: number[] = [];
  for (let i = 31; i >= 0; i--) w.push((MAGIC >>> i) & 1);
  return w;
})();

export const inspect = (file: string, svg: string, expect: string | null): Verdict => {
  const r = recover(svg);
  const correct = r.bits.slice(0, 32).filter((b, i) => b === magicWanted[i]).length;
  const totals = r.votes.map((v) => v.zero + v.one);
  const v: Verdict = {
    file,
    carriers: r.carriers,
    magicBitsCorrect: correct,
    magicMatches: r.magicMatches,
    shaTagHex: r.shaTagHex,
    minAgreement: r.minAgreement,
    meanAgreement: r.meanAgreement,
    emptySlots: totals.filter((t) => t === 0).length,
    minVotes: totals.length === 0 ? 0 : Math.min(...totals),
    pByChance: tail(correct, 32),
    sparse: r.carriers < SPARSE_BELOW,
  };
  if (expect !== null) {
    v.expected = shaTag(expect).toString(16).padStart(8, "0");
    v.expectedMatches = v.expected === r.shaTagHex;
    const w = witness(svg, expect);
    v.witnessAgreeing = w.agreeing;
    v.witnessTotal = w.total;
  }
  return v;
};

const say = (v: Verdict): void => {
  const lines = [
    `${v.file}`,
    `  carriers            ${v.carriers.toLocaleString("en-US")} coordinates over ${SIGNATURE_BITS} slots` +
      (v.emptySlots > 0 ? `  (${v.emptySlots} slots got no carrier)` : `  (weakest slot: ${v.minVotes} votes)`),
    `  signature bits      ${v.magicBitsCorrect}/32 of the constant recovered`,
    `  recovered sha tag   ${v.shaTagHex}`,
    `  slot agreement      min ${(v.minAgreement * 100).toFixed(1)}%   mean ${(v.meanAgreement * 100).toFixed(1)}%`,
    `  by chance           1 in ${oneIn(v.pByChance)}`,
  ];
  if (v.expected !== undefined) {
    lines.push(`  expected tag        ${v.expected}   ${v.expectedMatches === true ? "MATCH" : "does not match"}`);
    if (v.witnessTotal !== undefined && v.witnessTotal > 0) {
      const pct = ((v.witnessAgreeing ?? 0) / v.witnessTotal) * 100;
      lines.push(
        `  carriers agreeing   ${(v.witnessAgreeing ?? 0).toLocaleString("en-US")} of ${v.witnessTotal.toLocaleString("en-US")} (${pct.toFixed(1)}%) with that sha's signature`,
      );
    }
  }
  if (v.sparse) {
    lines.push(`  note                fewer than ${SPARSE_BELOW} carriers — too little to conclude much either way`);
  }
  lines.push(
    `  verdict             ${
      !v.magicMatches
        ? "no signature of this work is present"
        : v.expectedMatches === false
          ? "carries this work's signature, but for a different commit"
          : "carries this work's signature"
    }`,
  );
  process.stdout.write(lines.join("\n") + "\n\n");
};

/* ─────────────────────────────────────────────────────────────────────────────
   Selftest — the transforms the watermark claims to survive
   ───────────────────────────────────────────────────────────────────────────── */

/** Collapse inter-element whitespace and fold every newline away. */
const normaliseWhitespace = (svg: string): string =>
  svg.replace(/>\s+</g, "><").replace(/[\n\r\t]+/g, " ").replace(/ {2,}/g, " ");

/** Put every attribute on one line in a different order, the way a serialiser might. */
const reorderAttributes = (svg: string): string =>
  svg.replace(/<([a-zA-Z:]+)((?:\s+[a-zA-Z-:]+="[^"]*")+)(\s*\/?)>/g, (_m, tag: string, attrs: string, close: string) => {
    const found = [...attrs.matchAll(/\s+([a-zA-Z-:]+)="([^"]*)"/g)].map((x) => `${x[1]}="${x[2]}"`);
    found.reverse();
    return `<${tag} ${found.join(" ")}${close}>`;
  });

/** Rewrite every path as one absolute moveto followed by relative linetos. */
const toRelative = (svg: string): string =>
  svg.replace(/(\sd=")([^"]*)(")/g, (_m, a: string, body: string, b: string) => {
    const pts: [number, number][] = [];
    walkPath(body, (x, y) => {
      pts.push([x, y]);
      return [x, y];
    });
    if (pts.length === 0) return a + body + b;
    const r = (v: number): number => Math.round(v * 1000) / 1000;
    let d = `M${pts[0]![0]} ${pts[0]![1]}`;
    let px = pts[0]![0];
    let py = pts[0]![1];
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = pts[i]!;
      d += `l${r(x - px)} ${r(y - py)}`;
      px = x;
      py = y;
    }
    return a + d + b;
  });

/** Turn <polyline points> into <path d>, the way svgo's convertShapeToPath does. */
const shapesToPaths = (svg: string): string =>
  svg.replace(/<polyline([^>]*?)\spoints="([^"]*)"([^>]*?)\/?>/g, (_m, pre: string, pts: string, post: string) => {
    const flat: number[] = [];
    walkPoints(pts, (x, y) => {
      flat.push(x, y);
      return [x, y];
    });
    if (flat.length < 2) return `<path${pre}${post}/>`;
    let d = `M${flat[0]} ${flat[1]}`;
    for (let i = 2; i + 1 < flat.length; i += 2) d += `L${flat[i]} ${flat[i + 1]}`;
    return `<path${pre} d="${d}"${post}/>`;
  });

/** Re-round every coordinate to three decimals, which is svgo's default precision. */
const requantise = (svg: string, decimals: number): string => {
  const f = (v: number): number => Number(v.toFixed(decimals));
  return svg
    .replace(/(\sd=")([^"]*)(")/g, (_m, a: string, body: string, b: string) => a + walkPath(body, (x, y) => [f(x), f(y)]) + b)
    .replace(/(\spoints=")([^"]*)(")/g, (_m, a: string, body: string, b: string) => a + walkPoints(body, (x, y) => [f(x), f(y)]) + b);
};

const TRANSFORMS: { name: string; run: (s: string) => string }[] = [
  { name: "untouched", run: (s) => s },
  { name: "whitespace normalised", run: normaliseWhitespace },
  { name: "attributes reordered", run: (s) => reorderAttributes(normaliseWhitespace(s)) },
  { name: "rewritten relative", run: toRelative },
  { name: "shapes converted to paths", run: shapesToPaths },
  { name: "re-rounded to 3 decimals", run: (s) => requantise(s, 3) },
  { name: "all of the above at once", run: (s) => requantise(shapesToPaths(toRelative(reorderAttributes(normaliseWhitespace(s)))), 3) },
  { name: "re-rounded to 2 decimals", run: (s) => requantise(s, 2) },
];

const selftest = (): number => {
  const files = ["banner-dark.svg", "banner-light.svg", "serpent-dark.svg", "serpent-light.svg"].filter((f) =>
    existsSync(join(ROOT, f)),
  );
  if (files.length === 0) {
    process.stderr.write("error: no generated artifacts to test\n");
    return 1;
  }
  let failures = 0;
  for (const f of files) {
    const svg = readFileSync(join(ROOT, f), "utf8");
    process.stdout.write(`${f}\n`);
    for (const t of TRANSFORMS) {
      let out: string;
      try {
        out = t.run(svg);
      } catch (e) {
        process.stdout.write(`  ${t.name.padEnd(28)} transform threw: ${(e as Error).message}\n`);
        failures++;
        continue;
      }
      const v = inspect(f, out, null);
      /* Two decimals is the documented failure, so it is listed and not counted. */
      const expected = t.name !== "re-rounded to 2 decimals";
      const ok = v.magicMatches === expected;
      if (!ok) failures++;
      process.stdout.write(
        `  ${t.name.padEnd(28)} ${v.magicBitsCorrect}/32  tag=${v.shaTagHex}  ` +
          `agree ${(v.minAgreement * 100).toFixed(1)}%  ${v.magicMatches ? "recovered" : "lost"}` +
          `${expected ? "" : "  (expected: the unit is a thousandth)"}${ok ? "" : "   <-- UNEXPECTED"}\n`,
      );
    }
    process.stdout.write("\n");
  }
  process.stdout.write(`selftest=${failures === 0 ? "ok" : "failed"}\nunexpected=${failures}\n`);
  return failures === 0 ? 0 : 1;
};

/* ─────────────────────────────────────────────────────────────────────────────
   main
   ───────────────────────────────────────────────────────────────────────────── */

const main = (argv: string[]): number => {
  const files: string[] = [];
  let expect: string | null = null;
  let json = false;
  let test = false;

  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--selftest") test = true;
    else if (a.startsWith("--expect=")) expect = a.slice("--expect=".length).trim();
    else if (a.startsWith("--")) {
      process.stderr.write(`error: unknown flag ${a}\n`);
      return 2;
    } else files.push(a);
  }

  if (test) return selftest();

  if (files.length === 0) {
    process.stderr.write(
      "usage: node --experimental-strip-types tools/extract.ts <file> [...] [--expect=<sha>] [--json] [--selftest]\n",
    );
    return 2;
  }

  const verdicts: Verdict[] = [];
  for (const f of files) {
    if (!existsSync(f)) {
      process.stderr.write(`error: ${f} not found\n`);
      return 1;
    }
    verdicts.push(inspect(f, readFileSync(f, "utf8"), expect));
  }

  if (json) process.stdout.write(`${JSON.stringify(verdicts, null, 2)}\n`);
  else for (const v of verdicts) say(v);

  return verdicts.every((v) => v.magicMatches && v.expectedMatches !== false) ? 0 : 1;
};

process.exitCode = main(process.argv.slice(2));

/**
 * canary.ts — the coordinate watermark.
 *
 * THIS IS NOT A SECRET. It is described here in full, on purpose. A watermark whose
 * existence nobody can be shown is worthless in a dispute: the point of it is to be
 * citable, reproducible by a third party, and checkable against this source. Everything
 * needed to recover it — and to forge it, which is the same knowledge — is below.
 *
 * ── what it does ──────────────────────────────────────────────────────────────
 *
 * Every point coordinate in every <path d> and <polyline/polygon points> of the
 * generated SVGs is quantised to thousandths of a user unit, and the last bit of that
 * thousandth carries one bit of a 64-bit signature. Nothing else about the coordinate
 * changes: a value of 388.700 becomes 388.700 or 388.701 and never anything else.
 *
 * Worst case a coordinate moves 0.0015 user units — 0.0005 of quantising plus the
 * 0.001 of the bit. On a 1280-unit-wide viewBox shown at 1600 CSS px, on a 3x display,
 * at 500% browser zoom, one user unit is 18.75 device pixels, so the move is 0.028 of a
 * device pixel. It is below one rendered pixel at every zoom level the banner is viewed
 * at, by three orders of magnitude.
 *
 * Rendered and diffed against an unperturbed control (resvg), the difference is not nil
 * and is not claimed to be. Moving a coordinate at all changes some pixel somewhere.
 * Measured at the generation this was written at:
 *
 *   banner-dark.svg   830px    45 of 193,390 pixels differ   0.023%
 *                    1280px    58 of 460,800                 0.013%   none by more than 8/255
 *                    2560px   279 of 1,843,200               0.015%
 *                    6400px  1565 of 11,520,000              0.014%
 *   serpent-dark.svg  830px  7,344 of 484,720                1.52%
 *                    1280px 14,006 of 1,152,000              1.22%    95% of them by 1 or 2/255
 *                    2560px 19,383 of 4,608,000              0.42%
 *
 * The banner's handful are noise marks drawn with shape-rendering="crispEdges", which
 * switches antialiasing off and snaps a 1px mark to whichever pixel it lands in; a
 * thousandth of a unit is occasionally enough to land it in the next one. The serpent's
 * are antialiasing: it is thousands of thin strokes covering the whole plate, and a
 * stroke edge that moves a thousandth of a unit changes its own coverage by one or two
 * levels out of 255. Nothing in either file moves by as much as a pixel.
 *
 * ── the signature ─────────────────────────────────────────────────────────────
 *
 * 64 bits, big-endian, deterministic from the commit sha the artifact was generated at:
 *
 *   bits  0..31   MAGIC — FNV-1a of "palimpsest-ouroboros/canary/v1", a fixed constant.
 *                 Recovering it is what says "this watermark, not noise".
 *   bits 32..63   the first eight hex digits of that commit sha, as a 32-bit integer.
 *                 The same sha is also in the <metadata> block in plain text. The
 *                 watermark is not hiding it; it is carrying it somewhere that survives
 *                 having the metadata stripped.
 *
 * ── why it is position-independent ────────────────────────────────────────────
 *
 * A coordinate does not carry "the nth bit". It carries the bit its own value asks for.
 * For a coordinate v:
 *
 *   q     = round(v * 1000)           the value in thousandths
 *   base  = 2 * floor(q / 2)          q with its last bit cleared — UNCHANGED by us
 *   slot  = FNV-1a("<axis>:<base>") mod 64
 *   q'    = base + signature[slot]
 *
 * Because `base` is what selects the slot, and `base` is exactly the part we never
 * touch, embedding is idempotent: running it twice is running it once. And because the
 * slot comes from the value and not from the coordinate's position in the file, the
 * watermark does not care about document order. Points may be inserted, removed,
 * reordered, converted from <polyline> to <path>, rewritten from absolute to relative
 * and back — every surviving coordinate still votes for the same slot.
 *
 * Two coordinates that land on the same slot are not a collision to be resolved; they
 * agree, because the slot decides the bit and not the other way round. The banner has
 * 8,406 carriers over 64 slots and its weakest bit is carried 104 times over; the
 * serpent has 44,848 and its weakest bit 657 times over.
 *
 * ── what it survives, and what it does not ────────────────────────────────────
 *
 * Survives: whitespace normalisation, attribute reordering, reserialisation through an
 * XML parser, absolute/relative path rewriting, shape-to-path conversion, and svgo at
 * its default precision (3 decimals) — see `tools/extract.ts --selftest`, which runs
 * all of those and prints the recovered confidence for each.
 *
 * Does NOT survive: quantising coordinates coarser than thousandths (svgo -p 2, -p 1,
 * -p 0), geometric transforms folded into the coordinates (scaling, or translation by
 * anything that is not a whole thousandth), or redrawing the artifact from the
 * generator at a different sha. The
 * first two are destructive edits a copier has to choose to make; the third is not a
 * copy at all. None of them is prevented here, and none is meant to be.
 *
 * H, V, h and v carry nothing. They move one axis and the other is inherited, so
 * writing to them would put a half-set coordinate into the stream. They are skipped by
 * the embedder and by the extractor alike, so the two always see the same carriers.
 */

/* ─────────────────────────────────────────────────────────────────────────────
   The signature
   ───────────────────────────────────────────────────────────────────────────── */

export const SIGNATURE_BITS = 64;

/** The domain string. Changing it invalidates every signature ever emitted. */
export const CANARY_DOMAIN = "palimpsest-ouroboros/canary/v1";

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export const MAGIC = fnv1a(CANARY_DOMAIN);

/**
 * The same number written out, so that an accidental edit to the domain string or to the
 * hash is caught here rather than silently invalidating every signature this repository
 * has ever emitted. 141514741 is 0x086f57f5.
 */
export const MAGIC_EXPECTED = 141514741;
if (MAGIC !== MAGIC_EXPECTED) {
  throw new Error(`canary: MAGIC is ${MAGIC}, expected ${MAGIC_EXPECTED} — the domain string or the hash has changed`);
}

const bitsOf = (n: number, count: number): number[] => {
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) out.push((n >>> i) & 1);
  return out;
};

const numberOf = (bits: number[]): number => {
  let n = 0;
  for (const b of bits) n = ((n << 1) >>> 0) + b;
  return n >>> 0;
};

/** The first eight hex digits of a sha, as an unsigned 32-bit integer. */
export const shaTag = (sha: string): number => {
  const hex = /^[0-9a-f]{8}/i.exec(sha.trim().toLowerCase());
  return hex === null ? 0 : Number.parseInt(hex[0]!, 16) >>> 0;
};

/** The 64-bit signature for a commit sha: MAGIC then the sha tag. */
export const signatureFor = (sha: string): number[] => [
  ...bitsOf(MAGIC, 32),
  ...bitsOf(shaTag(sha), 32),
];

/** Which of the 64 slots a coordinate votes in. `base` must be the cleared value. */
export const slotOf = (axis: "x" | "y", base: number): number =>
  fnv1a(`${axis}:${base}`) % SIGNATURE_BITS;

/* ─────────────────────────────────────────────────────────────────────────────
   Numbers
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Thousandths. Everything the watermark does happens in this unit, and the choice is
 * the whole engineering trade-off in one number.
 *
 * Coarser (hundredths) survives svgo down to `-p 2`, but the banner's noise marks are
 * drawn with shape-rendering="crispEdges", so a hundredth is enough to tip a 1px mark
 * into the neighbouring pixel about one time in a hundred: 0.21% of the rendered image
 * changes. Finer (ten-thousandths) is invisible but svgo's DEFAULT precision is three
 * decimals, so the default minifier erases it.
 *
 * A thousandth is the largest unit that the default minifier keeps and the smallest
 * that is worth keeping. Measured: signature fully recovered after `svgo` at default
 * and at `-p 3`; 0.013% to 0.023% of rendered pixels differ from the unperturbed
 * control. `tools/extract.ts --selftest` re-runs the survival half of that.
 */
export const UNIT = 1000;

export const quantise = (v: number): number => Math.round(v * UNIT);

/** `q` with its last bit cleared. Correct for negatives, unlike `q & ~1`. */
export const baseOf = (q: number): number => 2 * Math.floor(q / 2);

/**
 * Shortest exact rendering of a value in thousandths. Trailing zeros are dropped because
 * dropping them does not change the value, and the watermark lives in the value.
 */
export const fmt = (v: number): string => {
  const r = Math.round(v * UNIT) / UNIT;
  return Object.is(r, -0) ? "0" : String(r);
};

/* ─────────────────────────────────────────────────────────────────────────────
   Path grammar
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Parameter counts per command. The entry for A is 7, but only the last two of those
 * seven are a point; rx, ry, the rotation and the two flags are not coordinates and are
 * never touched.
 */
const ARITY: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

/** For each command, the indices of its parameters that form (x, y) pairs. */
const POINTS_AT: Record<string, number[]> = {
  M: [0], L: [0], C: [0, 2, 4], S: [0, 2], Q: [0, 2], T: [0], A: [5],
  H: [], V: [], Z: [],
};

interface Seg {
  cmd: string;
  params: number[];
}

/**
 * A tolerant SVG path number scanner. It accepts everything the grammar allows and that
 * a minifier emits: leading dots, implicit separators between a number and the next
 * minus sign, and exponents.
 */
const scanNumbers = (s: string, from: number): { nums: number[]; at: number } => {
  const nums: number[] = [];
  let i = from;
  const isDigit = (c: string): boolean => c >= "0" && c <= "9";
  for (;;) {
    while (i < s.length && (s[i] === " " || s[i] === "," || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
    if (i >= s.length) break;
    const start = i;
    if (s[i] === "+" || s[i] === "-") i++;
    let digits = 0;
    while (i < s.length && isDigit(s[i]!)) { i++; digits++; }
    if (s[i] === ".") {
      i++;
      while (i < s.length && isDigit(s[i]!)) { i++; digits++; }
    }
    if (digits === 0) { i = start; break; }
    if (s[i] === "e" || s[i] === "E") {
      const save = i;
      i++;
      if (s[i] === "+" || s[i] === "-") i++;
      let ed = 0;
      while (i < s.length && isDigit(s[i]!)) { i++; ed++; }
      if (ed === 0) i = save;
    }
    nums.push(Number.parseFloat(s.slice(start, i)));
  }
  return { nums, at: i };
};

export const parsePath = (d: string): Seg[] => {
  const segs: Seg[] = [];
  let i = 0;
  let last = "";
  while (i < d.length) {
    const c = d[i]!;
    if (/[A-Za-z]/.test(c)) {
      const up = c.toUpperCase();
      if (ARITY[up] === undefined) return segs; /* unknown command: stop, emit nothing more */
      last = c;
      i++;
      const n = ARITY[up]!;
      if (n === 0) { segs.push({ cmd: c, params: [] }); continue; }
      const got = scanNumbers(d, i);
      i = got.at;
      for (let k = 0; k + n <= got.nums.length; k += n) {
        /* A repeated M takes L for its second and subsequent parameter groups. */
        const cmd = k === 0 ? c : up === "M" ? (c === "m" ? "l" : "L") : c;
        segs.push({ cmd, params: got.nums.slice(k, k + n) });
      }
      if (got.nums.length % n !== 0) return segs; /* malformed tail: stop here */
    } else if (c === " " || c === "," || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (last !== "") {
      /* an implicit repeat of the previous command with no letter of its own */
      const up = last.toUpperCase();
      const n = ARITY[up]!;
      const got = scanNumbers(d, i);
      if (got.nums.length === 0) return segs;
      i = got.at;
      const cmd = up === "M" ? (last === "m" ? "l" : "L") : last;
      for (let k = 0; k + n <= got.nums.length; k += n) segs.push({ cmd, params: got.nums.slice(k, k + n) });
      if (got.nums.length % n !== 0) return segs;
    } else {
      return segs;
    }
  }
  return segs;
};

const emitPath = (segs: Seg[]): string => {
  const out: string[] = [];
  let prev = "";
  for (const s of segs) {
    const body = s.params.map(fmt);
    let head = s.cmd === prev ? "" : s.cmd;
    /* An implicit repeat still needs a separator before a number that starts with a digit. */
    if (head === "" && body.length > 0 && !body[0]!.startsWith("-")) head = " ";
    let text = head;
    for (let k = 0; k < body.length; k++) {
      const t = body[k]!;
      if (k > 0 && !t.startsWith("-")) text += " ";
      text += t;
    }
    out.push(text);
    prev = s.cmd;
  }
  return out.join("");
};

/* ─────────────────────────────────────────────────────────────────────────────
   Walking a path in absolute coordinates
   ───────────────────────────────────────────────────────────────────────────── */

export type Visit = (x: number, y: number, axisPair: true) => [number, number];

/**
 * Walk every coordinate pair of a path in ABSOLUTE terms, hand it to `visit`, and write
 * back whatever `visit` returns — as a delta for a relative command, so the path keeps
 * the shape the generator gave it. The current point is advanced using the value that
 * was actually written, so nothing drifts however long the path is.
 *
 * H, V, h and v advance the current point and carry nothing.
 */
export const walkPath = (d: string, visit: Visit): string => {
  const segs = parsePath(d);
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let started = false;

  for (const s of segs) {
    const up = s.cmd.toUpperCase();
    const rel = s.cmd !== up;
    const p = s.params;

    if (up === "Z") { cx = sx; cy = sy; continue; }

    if (up === "H") { cx = rel ? cx + p[0]! : p[0]!; continue; }
    if (up === "V") { cy = rel ? cy + p[0]! : p[0]!; continue; }

    /* Fold every (x, y) pair this command carries, left to right. The current point
       does NOT move between the pairs of one command — a cubic's two controls and its
       endpoint are all relative to the same origin. */
    for (const at of POINTS_AT[up]!) {
      const ax = rel ? cx + p[at]! : p[at]!;
      const ay = rel ? cy + p[at + 1]! : p[at + 1]!;
      const [nx, ny] = visit(ax, ay, true);
      p[at] = rel ? nx - cx : nx;
      p[at + 1] = rel ? ny - cy : ny;
    }

    /* Now advance to the endpoint, which is the last pair the command carries. */
    const ends = POINTS_AT[up]!;
    if (ends.length > 0) {
      const at = ends[ends.length - 1]!;
      const ex = rel ? cx + p[at]! : p[at]!;
      const ey = rel ? cy + p[at + 1]! : p[at + 1]!;
      cx = ex;
      cy = ey;
    }
    if (up === "M") {
      sx = cx;
      sy = cy;
      started = true;
    } else if (!started) {
      sx = cx;
      sy = cy;
      started = true;
    }
  }
  return emitPath(segs);
};

/** `points` on a <polyline> or <polygon>: a flat list of absolute pairs. */
export const walkPoints = (attr: string, visit: Visit): string => {
  const got = scanNumbers(attr, 0);
  const n = got.nums;
  const out: string[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) {
    const [nx, ny] = visit(n[i]!, n[i + 1]!, true);
    out.push(`${fmt(nx)},${fmt(ny)}`);
  }
  return out.join(" ");
};

/* ─────────────────────────────────────────────────────────────────────────────
   The whole document
   ───────────────────────────────────────────────────────────────────────────── */

const D_ATTR = /(\sd=")([^"]*)(")/g;
const POINTS_ATTR = /(\spoints=")([^"]*)(")/g;

/** Hand every carrier coordinate in the document to `visit`, in document order. */
export const walkSvg = (svg: string, visit: Visit): string =>
  svg
    .replace(D_ATTR, (_m, a: string, body: string, b: string) => a + walkPath(body, visit) + b)
    .replace(POINTS_ATTR, (_m, a: string, body: string, b: string) => a + walkPoints(body, visit) + b);

/**
 * Write `sha`'s signature into every carrier coordinate. Idempotent: embedding an
 * already-embedded document at the same sha returns it byte for byte.
 */
export const embed = (svg: string, sha: string): string => {
  const sig = signatureFor(sha);
  const set = (v: number, axis: "x" | "y"): number => {
    const base = baseOf(quantise(v));
    return (base + sig[slotOf(axis, base)]!) / UNIT;
  };
  return walkSvg(svg, (x, y) => [set(x, "x"), set(y, "y")]);
};

export interface Recovered {
  /** one entry per slot: how many carriers voted 0 and how many voted 1 */
  votes: { zero: number; one: number }[];
  bits: number[];
  carriers: number;
  magic: number;
  magicMatches: boolean;
  shaTag: number;
  /** hex of the recovered sha tag, the form it appears in as a short sha */
  shaTagHex: string;
  /** the weakest slot's agreement, in [0.5, 1] */
  minAgreement: number;
  /** mean agreement across all slots, in [0.5, 1] */
  meanAgreement: number;
}

/**
 * How many carriers agree with the signature a SPECIFIC sha would have written, and how
 * many there are. This is the form to reach for when the question is "did this file come
 * from that commit" rather than "does this file carry a signature at all": it tests one
 * hypothesis directly instead of recovering the bits and comparing afterwards, so a badly
 * damaged file still gives a usable ratio where a majority vote would have given a wrong
 * answer with false confidence.
 */
export const witness = (svg: string, sha: string): { agreeing: number; total: number } => {
  const sig = signatureFor(sha);
  let agreeing = 0;
  let total = 0;
  const check = (v: number, axis: "x" | "y"): void => {
    const q = quantise(v);
    const base = baseOf(q);
    if (q - base === sig[slotOf(axis, base)]) agreeing++;
    total++;
  };
  walkSvg(svg, (x, y) => { check(x, "x"); check(y, "y"); return [x, y]; });
  return { agreeing, total };
};

/**
 * Below this many carriers a document is too small to say anything with. Sixty-four slots
 * want twenty votes apiece before a majority in any of them means much, and 1283 is the
 * first prime above that product — the primality buys nothing, it is there so the number
 * is unmistakably this one and not a round figure somebody else would have reached for.
 */
export const SPARSE_BELOW = 1283;

/** Read the signature back out of a candidate document. Never throws. */
export const recover = (svg: string): Recovered => {
  const votes = Array.from({ length: SIGNATURE_BITS }, () => ({ zero: 0, one: 0 }));
  let carriers = 0;
  const tally = (v: number, axis: "x" | "y"): void => {
    const q = quantise(v);
    const base = baseOf(q);
    const bit = q - base;
    const slot = slotOf(axis, base);
    if (bit === 0) votes[slot]!.zero++;
    else votes[slot]!.one++;
    carriers++;
  };
  walkSvg(svg, (x, y) => { tally(x, "x"); tally(y, "y"); return [x, y]; });

  const bits: number[] = [];
  let minAgreement = 1;
  let sumAgreement = 0;
  let counted = 0;
  for (const v of votes) {
    const total = v.zero + v.one;
    bits.push(v.one > v.zero ? 1 : 0);
    if (total === 0) { minAgreement = 0; continue; }
    const a = Math.max(v.zero, v.one) / total;
    minAgreement = Math.min(minAgreement, a);
    sumAgreement += a;
    counted++;
  }
  const magic = numberOf(bits.slice(0, 32));
  const tag = numberOf(bits.slice(32, 64));
  return {
    votes,
    bits,
    carriers,
    magic,
    magicMatches: magic === MAGIC,
    shaTag: tag,
    shaTagHex: tag.toString(16).padStart(8, "0"),
    minAgreement,
    meanAgreement: counted === 0 ? 0 : sumAgreement / counted,
  };
};

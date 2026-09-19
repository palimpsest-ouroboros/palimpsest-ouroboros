// serpent.ts -- zero-dependency engraved ouroboros generator.
// Composition B: the double coil. The body winds twice around the ring while its
// radius weaves in and out K times, so it crosses over itself K times and closes
// at the mouth. Everything is stroked linework; tone is line density alone.
//
//   node --experimental-strip-types serpent.ts --banner=<path> --out-dir=<dir> [--dry-run]
//
// What the banner's state changes, besides the coil itself:
//   at the seventh hour  a gouge is taken out of the engraved tone, and the two
//                          generations after it burnish the gouge away again
//   layers >= 10           a second body, at 3% and out of phase, behind the first
//   layers >= 12           one patch of plate where the tone is stopped out solid
// and, at every generation, four corner marks and one 0.4-second event on a
// 252-second clock. None of these is labelled anywhere on the plate.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ types */

type V = { x: number; y: number };

interface Meta {
  generation: number;
  sha: string;
  layers: number;
  cap: number;
  variant: string;
  content: string;
}

interface Occ {
  oLo: number; oHi: number;   // over-strand sample range (the occluder)
  uLo: number; uHi: number;   // under-strand sample range it applies to
}

interface Anchor { l: number; v: number }

// every parameter the closed knot needs, so a second body can be built from the
// same machinery with the numbers moved a little
interface KnotP {
  rotBase: number; phK: number; R0: number; R1: number; K: number; eps: number;
  wob1: number; wob2: number; ph1: number; ph2: number;
  aw1: number; aw2: number; ph3: number; ph4: number;
}

/* SOURCED. The four sons of Horus, one at each corner of the plate.

   E. A. Wallis Budge, THE GODS OF THE EGYPTIANS (London, 1904) and THE MUMMY:
   Chapters on Egyptian Funereal Archaeology (Cambridge, 1893), for the names, the
   organ each jar received, the cardinal direction each was assigned, and the head
   each jar was given. Budge's spellings are kept as he prints them. Public domain:
   Budge died 1934 and both works appeared before 1929.

   The corner and direction pairing is fixed and decides where each entry lands. The
   marks' shapes are chosen by corner, not by name, so the names change nothing that
   is drawn. Nothing on the plate says any of this.

   Budge is not consistent about the heart. He gives "the heart and lungs" to
   Tuamutef's jar here, and elsewhere says the heart was taken out, mummified, jarred,
   and a scarab set in its place. The familiar claim that the heart alone was left in
   the body for the weighing is not what this source says, and is not asserted here.
*/

interface Canopic { corner: string; direction: string; name: string; organ: string; head: string }

const CANOPIC: Canopic[] = [
  { corner: "NW", direction: "north", name: "Hapi",        organ: "the small viscerae",               head: "the head of an ape" },
  { corner: "NE", direction: "east",  name: "Tuamutef",    organ: "the heart and lungs",              head: "the head of a jackal" },
  { corner: "SE", direction: "south", name: "Mestha",      organ: "the stomach and large intestines", head: "the head of a man" },
  { corner: "SW", direction: "west",  name: "Qebhsennuf",  organ: "the liver and the gall bladder",   head: "the head of a hawk" },
];

/* ============================== end of the substitutable block ================ */

/* ------------------------------------------------------------- tiny math */

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const sstep = (x: number): number => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

const f2 = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};
/* ------------------------------------------------- self-contained noise */
// FNV-1a over a purpose string -> mulberry32. No clock, no platform entropy.

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const mulberry32 = (a: number): (() => number) => {
  let s = a >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const draw = (sha: string, purpose: string, i: number): (() => number) =>
  mulberry32(fnv1a(sha + ":" + purpose + ":" + i));

// one stable scalar in [lo,hi]
const pick = (sha: string, purpose: string, i: number, lo: number, hi: number): number =>
  lo + (hi - lo) * draw(sha, purpose, i)();

/* -------------------------------------------------------------- banner IO */

const readMeta = (file: string): Meta => {
  const raw = readFileSync(file, "utf8");
  const m = raw.match(/<metadata>\s*palimpsest\s*(\{[\s\S]*?\})\s*<\/metadata>/);
  if (!m) throw new Error("no palimpsest metadata in " + file);
  const j = JSON.parse(m[1]!) as Meta;
  if (typeof j.layers !== "number" || typeof j.sha !== "string") {
    throw new Error("metadata missing layers/sha");
  }
  return j;
};

/* ------------------------------------------------------------ vec helpers */

const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const len = (a: V): number => Math.hypot(a.x, a.y);
const norm = (a: V): V => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const rot = (a: V, th: number): V => {
  const c = Math.cos(th), s = Math.sin(th);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax, dy = by - ay;
  const dd = dx * dx + dy * dy;
  let t = dd > 0 ? ((px - ax) * dx + (py - ay) * dy) / dd : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// piecewise smooth interpolation through anchors, clamped at both ends
const pw = (l: number, an: Anchor[]): number => {
  if (l <= an[0]!.l) return an[0]!.v;
  const last = an[an.length - 1]!;
  if (l >= last.l) return last.v;
  for (let i = 0; i < an.length - 1; i++) {
    const a = an[i]!, b = an[i + 1]!;
    if (l >= a.l && l <= b.l) {
      const t = sstep((l - a.l) / (b.l - a.l));
      return a.v + (b.v - a.v) * t;
    }
  }
  return last.v;
};

/* ============================================================== CLI ==== */

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const pre = "--" + name + "=";
  for (const a of argv) if (a.startsWith(pre)) return a.slice(pre.length);
  return null;
};
const dryRun = argv.includes("--dry-run");
const bannerPath = flag("banner");
const outDir = flag("out-dir");

/* This file lives in tools/, so the repo it draws for is one directory up. Defaulting both
   paths there lets the Action invoke it bare, while --banner/--out-dir stay available for
   rendering a given layer count somewhere else. */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const bannerFile = bannerPath ?? resolve(REPO, "banner-dark.svg");
const outTo = outDir ?? REPO;

if (!existsSync(bannerFile)) {
  console.error(`error: no banner to read state from at ${bannerFile}`);
  process.exit(2);
}

const meta = readMeta(resolve(bannerFile));
const SHA = meta.sha;
const LAYERS = clamp(meta.layers, 1, meta.cap || 14);
const CAP = meta.cap || 14;
const GEN = typeof meta.generation === "number" ? meta.generation : 0;

/* ------------------------------------------------------ where in the cycle */
// Twelve generations to the turn. At the seventh the plate is wounded; the two
// generations after that burnish it back; the rest of the turn remembers
// nothing. Seeded per turn, so no two cycles are cut in the same place.
const CYC = 12;
const PHASE = ((GEN % CYC) + CYC) % CYC;
const TURN = Math.floor(GEN / CYC);
/**
 * The gouge keeps its place while it heals.
 *
 * Seeding it from the banner's own sha would move it, because that sha changes every
 * generation and the wound has to last three of them. The ledger records the sha of the
 * generation at which the cut opened -- the seventh hour of this cycle -- and that one value
 * is the same throughout the heal, so the position still comes from the repository's own
 * history rather than from the cycle number alone. With no ledger to read, the cycle number
 * is used and the wound is deterministic all the same.
 */
const cutSeed = (): string => {
  const opened = TURN * CYC + 6;
  try {
    const led = readFileSync(resolve(REPO, "LEDGER.md"), "utf8");
    for (const line of led.split("\n")) {
      const m = /^\|\s*(\d+)\s*\|\s*([0-9a-f]+)\s*\|/.exec(line.trim());
      if (m !== null && Number.parseInt(m[1]!, 10) === opened) return m[2]!;
    }
  } catch {
    /* nothing to read */
  }
  return `turn:${TURN}`;
};

const cutDepth = PHASE === 6 ? 1 : PHASE === 7 ? 0.54 : PHASE === 8 ? 0.21 : 0;
const cutPhase = PHASE === 6 ? "open" : PHASE === 7 ? "healing" : PHASE === 8 ? "closing" : "absent";
const CUT_ON = cutDepth > 0;

// two thresholds nobody is told about
const GHOST_AT = 10;
const CORVI_AT = 12;
const hasGhost = LAYERS >= GHOST_AT;
const hasCorvi = LAYERS >= CORVI_AT;

/* ====================================================== form from state */

const W = 1280, H = 900;
const CX = W / 2, CY = H / 2;
const SX = 1.3, SY = 1.0;          // the ring is stretched to fill a wide plate
const BUDGET = 400;                // vertical half-extent allowed

const rotBase0 = pick(SHA, "rot", 0, -0.55, 0.55) + 0.10;

// how far along the accumulation we are, 0..1
const g = (LAYERS - 1) / Math.max(1, CAP - 2);

// crossings: 3 -> 9, odd only. A 2-strand torus weave: K crossings, 2 windings.
let K = 3 + 2 * Math.floor(g * 3 + 0.36);

// the serpent thickens
const wBody = 18 + 18 * g;
const wHead = wBody * 1.72;

// ring geometry: solve R0 / R1 so strands clear each other AND the weave
// crosses at a readable angle (shallow crossings at low K look like a smear).
// EPS flattens the inside of each radial trough, where a thick body has the
// least room to turn.
const EPS = 0.12;
let R0 = 300, R1 = 90;

// The weave has to satisfy two things at once: the two windings must clear
// each other between crossings, and no turn may be tighter than the body is
// thick. Solve for it instead of guessing -- shrink the radial swing until the
// tightest turn is comfortable, and drop a pair of crossings if it never is.
const probeR = (r0: number, r1: number, k: number): number => {
  const M0 = 2600;
  const q: V[] = new Array(M0 + 1);
  for (let i = 0; i <= M0; i++) {
    const u = i / M0;
    const a = TAU * 2 * u + rotBase0;
    const ph = TAU * k * u;
    const r = r0 + r1 * (Math.cos(ph) + EPS * Math.cos(2 * ph));
    q[i] = { x: SX * r * Math.cos(a), y: SY * r * Math.sin(a) };
  }
  let best = 1e9;
  for (let i = 0; i <= M0; i++) {
    for (const st of [6, 14, 28]) {
      const a = q[(i - st + M0 + 1) % (M0 + 1)]!, b = q[i]!, c = q[(i + st) % (M0 + 1)]!;
      const A = len(sub(b, a)), B = len(sub(c, b)), C = len(sub(c, a));
      if (A < 1e-9 || B < 1e-9 || C < 1e-9) continue;
      const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
      const kap = (2 * area2) / (A * B * C);
      if (kap > 1e-9) best = Math.min(best, 1 / kap);
    }
  }
  return best;
};

let solved = false;
while (!solved) {
  R1 = Math.max(2.15 * wBody + 11, (0.9 * 300) / K);
  for (let t = 0; t < 60; t++) {
    R0 = BUDGET - R1 * (1 + EPS) - wBody;
    if (probeR(R0, R1, K) >= 1.28 * wBody) { solved = true; break; }
    if (R1 <= 1.85 * wBody + 8) break;
    R1 *= 0.955;
  }
  if (solved || K <= 3) break;
  K -= 2;
}
R0 = BUDGET - R1 * (1 + EPS) - wBody;

const rotBase = rotBase0;
const phK = pick(SHA, "phK", 0, -0.35, 0.35);
const wob1 = pick(SHA, "wob", 1, -1, 1) * 0.16 * R1;
const wob2 = pick(SHA, "wob", 2, -1, 1) * 0.10 * R1;
const ph1 = pick(SHA, "wph", 1, 0, TAU);
const ph2 = pick(SHA, "wph", 2, 0, TAU);
const aw1 = pick(SHA, "awb", 1, -1, 1) * 0.075;
const aw2 = pick(SHA, "awb", 2, -1, 1) * 0.045;
const ph3 = pick(SHA, "aph", 1, 0, TAU);
const ph4 = pick(SHA, "aph", 2, 0, TAU);

// base closed knot. Only EVEN harmonics wobble it, so the two windings stay
// congruent and the K crossings survive intact. Parameterised, because the
// thing behind it is built from exactly this and nothing else.
const mkKnot = (p: KnotP): ((u: number) => V) => (u: number): V => {
  const ang = TAU * 2 * u + p.rotBase + p.aw1 * Math.sin(TAU * 2 * u + p.ph3) + p.aw2 * Math.sin(TAU * 4 * u + p.ph4);
  const ph = TAU * p.K * u + p.phK;
  const r =
    p.R0 + p.R1 * (Math.cos(ph) + p.eps * Math.cos(2 * ph)) +
    p.wob1 * Math.cos(TAU * 2 * u + p.ph1) +
    p.wob2 * Math.cos(TAU * 4 * u + p.ph2);
  return { x: CX + SX * r * Math.cos(ang), y: CY + SY * r * Math.sin(ang) };
};

const BASEK: KnotP = {
  rotBase, phK, R0, R1, K, eps: EPS,
  wob1, wob2, ph1, ph2, aw1, aw2, ph3, ph4,
};
const knot = mkKnot(BASEK);

/* ------------------------------------------ raw sampling + head/tail warp */

const RAW = 7200;
const uHead = 0.052;               // head turns off the ring a little
const uTail = 0.905;               // tail leaves the ring to come into the mouth
const headTurn = pick(SHA, "hturn", 0, -1, 1) > 0 ? 0.30 : -0.30;
const biteAng = (pick(SHA, "bite", 0, -1, 1) > 0 ? 1 : -1) * (0.24 + 0.12 * (1 - g));

const rawPts: V[] = new Array(RAW + 1);
for (let k = 0; k <= RAW; k++) rawPts[k] = knot(k / RAW);

// head warp: rotate the first stretch about the neck pivot so the skull turns
const pivot = knot(uHead);
for (let k = 0; k <= RAW; k++) {
  const u = k / RAW;
  if (u >= uHead) break;
  const a = headTurn * sstep((uHead - u) / uHead);
  rawPts[k] = add(pivot, rot(sub(rawPts[k]!, pivot), a));
}

// mouth: snout is raw[0] after the warp; the gape opens along -tangent
const snout = rawPts[0]!;
const headFwd = norm(sub(rawPts[6]!, rawPts[0]!));     // points INTO the body
const tipTarget = add(snout, mul(headFwd, 0.62 * wHead));
const tipDir = rot(headFwd, biteAng);                  // tail enters the jaws crosswise

// Tail warp. The tail has to be BITTEN, which means it must arrive through the
// gape rather than through the roof of the skull. It leaves the ring, passes a
// waypoint set clear of the head on the outside, then turns back between the
// jaws. Two cubics through that waypoint -- a single one only leans toward a
// control point and would be swallowed by the skull on the way past.
{
  const kw = Math.floor(uTail * RAW);
  const B0 = rawPts[kw]!;
  const T0d = norm(sub(rawPts[kw + 4]!, rawPts[kw]!));
  const nHead: V = { x: -headFwd.y, y: headFwd.x };
  const sgn = biteAng >= 0 ? 1 : -1;
  const Wp: V = {
    x: clamp(snout.x - headFwd.x * 1.42 * wHead + nHead.x * sgn * 0.80 * wHead, 74, W - 74),
    y: clamp(snout.y - headFwd.y * 1.42 * wHead + nHead.y * sgn * 0.80 * wHead, 74, H - 74),
  };
  const dW = norm(sub(tipTarget, Wp));
  const hermite = (P0: V, m0: V, P1: V, m1: V, t: number): V => {
    const h00 = 2 * t * t * t - 3 * t * t + 1, h10 = t * t * t - 2 * t * t + t;
    const h01 = -2 * t * t * t + 3 * t * t, h11 = t * t * t - t * t;
    return {
      x: h00 * P0.x + h10 * m0.x + h01 * P1.x + h11 * m1.x,
      y: h00 * P0.y + h10 * m0.y + h01 * P1.y + h11 * m1.y,
    };
  };
  const dA = len(sub(Wp, B0)), dB = len(sub(tipTarget, Wp));
  const SPLIT = 0.70;
  for (let k = kw; k <= RAW; k++) {
    const t = (k - kw) / (RAW - kw);
    rawPts[k] = t < SPLIT
      ? hermite(B0, mul(T0d, dA * 1.15), Wp, mul(dW, dA * 0.95), t / SPLIT)
      : hermite(Wp, mul(dW, dB * 1.05), tipTarget, mul(tipDir, dB * 0.85), (t - SPLIT) / (1 - SPLIT));
  }
}

/* --------------------------------------------- resample by arc length */

const resampleArc = (raw: V[], n: number): { P: V[]; S: number } => {
  const m = raw.length - 1;
  const cum: number[] = new Array(m + 1);
  cum[0] = 0;
  for (let k = 1; k <= m; k++) cum[k] = cum[k - 1]! + len(sub(raw[k]!, raw[k - 1]!));
  const total = cum[m]!;
  const out: V[] = new Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    while (k < m - 1 && cum[k + 1]! < target) k++;
    const a = cum[k]!, b = cum[k + 1]!;
    const t = b > a ? (target - a) / (b - a) : 0;
    out[i] = {
      x: raw[k]!.x + (raw[k + 1]!.x - raw[k]!.x) * t,
      y: raw[k]!.y + (raw[k + 1]!.y - raw[k]!.y) * t,
    };
  }
  return { P: out, S: total };
};

// tangents + normals (n is the left normal; s = -1 is the SPINE side)
const framesOf = (Q: V[]): { T: V[]; Nr: V[] } => {
  const n = Q.length;
  const t: V[] = new Array(n);
  const nr: V[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Q[Math.max(0, i - 1)]!, b = Q[Math.min(n - 1, i + 1)]!;
    t[i] = norm(sub(b, a));
    nr[i] = { x: -t[i]!.y, y: t[i]!.x };
  }
  return { T: t, Nr: nr };
};

const N = 1500;
const arc = resampleArc(rawPts, N);
const P = arc.P;
const S = arc.S;
const ds = S / (N - 1);

const fr0 = framesOf(P);
const T = fr0.T;
const Nr = fr0.Nr;

/* ----------------------------------------------------- half-width w(t) */

const headLen = 2.70 * wHead;
const anchors: Anchor[] = [
  { l: 0.0, v: 0.34 * wHead },
  { l: 0.17 * headLen, v: 0.72 * wHead },
  { l: 0.52 * headLen, v: 1.00 * wHead },
  { l: 0.74 * headLen, v: 0.86 * wHead },
  { l: 1.04 * headLen, v: 0.60 * wHead },          // neck pinch
  { l: 1.85 * headLen, v: 1.00 * wBody },
];
const undA = pick(SHA, "und", 1, 0, TAU);
const undB = pick(SHA, "und", 2, 0, TAU);
const taperStart = 0.58 * S;

const wArr: number[] = new Array(N);
for (let i = 0; i < N; i++) {
  const l = (i / (N - 1)) * S;
  let w = pw(l, anchors);
  if (l > taperStart) {
    const f = (l - taperStart) / (S - taperStart);
    w *= 1 - 0.91 * Math.pow(f, 2.6);
  }
  w *= 1 + 0.055 * Math.sin((l / S) * TAU * 7 + undA) + 0.032 * Math.sin((l / S) * TAU * 13 + undB);
  wArr[i] = Math.max(0.7, w);
}

// Clamp the half-width against the local radius of curvature, or the inner
// offset folds over itself and the silhouette grows little lassos. Menger
// curvature at several stencil widths, take the worst; erode the limit so a
// narrow spike cannot be smoothed back out; clamp LAST, never smooth after.
const curvLimitOf = (Q: V[], n: number, fac: number): number[] => {
  const kMax: number[] = new Array(n).fill(0);
  for (const sten of [3, 6, 12, 24]) {
    for (let i = 0; i < n; i++) {
      const a = Q[Math.max(0, i - sten)]!, b = Q[i]!, c = Q[Math.min(n - 1, i + sten)]!;
      const A = len(sub(b, a)), B = len(sub(c, b)), C = len(sub(c, a));
      if (A < 1e-9 || B < 1e-9 || C < 1e-9) continue;
      const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
      const kappa = (2 * area2) / (A * B * C);
      if (kappa > kMax[i]!) kMax[i] = kappa;
    }
  }
  const lim: number[] = new Array(n);
  for (let i = 0; i < n; i++) lim[i] = kMax[i]! > 1e-9 ? fac / kMax[i]! : 1e9;
  const er = lim.slice();
  const R = 5;
  for (let i = 0; i < n; i++) {
    let m = 1e9;
    for (let j = Math.max(0, i - R); j <= Math.min(n - 1, i + R); j++) m = Math.min(m, er[j]!);
    lim[i] = m;
  }
  for (let s = 0; s < 4; s++) {
    const cp = lim.slice();
    for (let i = 1; i < n - 1; i++) lim[i] = (cp[i - 1]! + 2 * cp[i]! + cp[i + 1]!) / 4;
  }
  return lim;
};
const limit = curvLimitOf(P, N, 0.70);
for (let i = 0; i < N; i++) wArr[i] = Math.min(wArr[i]!, limit[i]!);
for (let s = 0; s < 3; s++) {
  const cp = wArr.slice();
  for (let i = 1; i < N - 1; i++) wArr[i] = (cp[i - 1]! + 2 * cp[i]! + cp[i + 1]!) / 4;
}
for (let i = 0; i < N; i++) wArr[i] = Math.max(0.7, Math.min(wArr[i]!, limit[i]!));

let minCurvR = 1e9, clampedAt = 0;
for (let i = 0; i < N; i++) {
  if (limit[i]! < minCurvR) minCurvR = limit[i]!;
  if (wArr[i]! >= limit[i]! - 1e-6 && limit[i]! < 1e8) clampedAt++;
}

// A folded offset shows up as a LOCAL self-intersection of an edge polyline
// (|i-j| small). Crossings of the knot itself are far apart in i and expected.
const folds = ((): number => {
  let n = 0;
  for (const sEdge of [-1, 1]) {
    const Q: V[] = new Array(N);
    for (let i = 0; i < N; i++) {
      Q[i] = { x: P[i]!.x + Nr[i]!.x * sEdge * wArr[i]!, y: P[i]!.y + Nr[i]!.y * sEdge * wArr[i]! };
    }
    for (let i = 0; i < N - 1; i++) {
      for (let j = i + 3; j < Math.min(N - 1, i + 120); j++) {
        const r = sub(Q[i + 1]!, Q[i]!), sv = sub(Q[j + 1]!, Q[j]!);
        const den = r.x * sv.y - r.y * sv.x;
        if (Math.abs(den) < 1e-12) continue;
        const qp = sub(Q[j]!, Q[i]!);
        const t = (qp.x * sv.y - qp.y * sv.x) / den;
        const u = (qp.x * r.y - qp.y * r.x) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) n++;
      }
    }
  }
  return n;
})();

const pt = (i: number, s: number): V => ({
  x: P[i]!.x + Nr[i]!.x * s * wArr[i]!,
  y: P[i]!.y + Nr[i]!.y * s * wArr[i]!,
});

/* -------------------------------------------- find the self-crossings */

interface Cross { a: number; b: number; overAt: number; underAt: number }
const rawCross: { a: number; b: number }[] = [];
const GAPI = 26;
for (let i = 0; i < N - 1; i++) {
  const p1 = P[i]!, p2 = P[i + 1]!;
  const r = sub(p2, p1);
  for (let j = i + GAPI; j < N - 1; j++) {
    const q1 = P[j]!, q2 = P[j + 1]!;
    const sV = sub(q2, q1);
    const den = r.x * sV.y - r.y * sV.x;
    if (Math.abs(den) < 1e-12) continue;
    const qp = sub(q1, p1);
    const t = (qp.x * sV.y - qp.y * sV.x) / den;
    const u = (qp.x * r.y - qp.y * r.x) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) rawCross.push({ a: i, b: j });
  }
}
// cluster near-duplicates
const crossings: Cross[] = [];
for (const c of rawCross) {
  let merged = false;
  for (const e of crossings) {
    if (Math.abs(e.a - c.a) < 40 && Math.abs(e.b - c.b) < 40) { merged = true; break; }
  }
  if (!merged) crossings.push({ a: c.a, b: c.b, overAt: -1, underAt: -1 });
}
crossings.sort((x, y) => x.a - y.a);

// alternate over/under along the strand, forcing consistency at the 2nd visit
{
  const enc: { ci: number; idx: number }[] = [];
  crossings.forEach((c, ci) => { enc.push({ ci, idx: c.a }); enc.push({ ci, idx: c.b }); });
  enc.sort((x, y) => x.idx - y.idx);
  let cur = true;
  for (const e of enc) {
    const c = crossings[e.ci]!;
    let isOver: boolean;
    if (c.overAt < 0 && c.underAt < 0) { isOver = cur; }
    else { isOver = c.overAt < 0; }
    if (isOver) c.overAt = e.idx; else c.underAt = e.idx;
    cur = !isOver;
  }
}

/* ------------------------------------------------------- occluder list */

const occs: Occ[] = [];
for (const c of crossings) {
  if (c.overAt < 0 || c.underAt < 0) continue;
  const wo = wArr[c.overAt]!, wu = wArr[c.underAt]!;
  const spanO = Math.ceil((3.4 * (wo + wu)) / ds) + 10;
  const spanU = Math.ceil((3.0 * wo + 2.4 * wu) / ds) + 12;
  occs.push({
    oLo: Math.max(0, c.overAt - spanO), oHi: Math.min(N - 1, c.overAt + spanO),
    uLo: Math.max(0, c.underAt - spanU), uHi: Math.min(N - 1, c.underAt + spanU),
  });
}
// the head is always over the tail: the tail disappears into the jaws
{
  const iHead = Math.min(N - 1, Math.ceil((headLen * 1.02) / ds));
  const iTail = Math.max(0, N - 1 - Math.ceil((headLen * 2.6) / ds));
  occs.push({ oLo: 0, oHi: iHead, uLo: iTail, uHi: N - 1 });
}

const occAt: number[][] = new Array(N);
for (let i = 0; i < N; i++) occAt[i] = [];
occs.forEach((o, oi) => { for (let i = o.uLo; i <= o.uHi; i++) occAt[i]!.push(oi); });

const MARGIN = 2.9;
// negative => hidden by the strand above; small positive => in its cast shadow
const clearance = (x: number, y: number, i: number): number => {
  const list = occAt[i]!;
  if (list.length === 0) return 1e9;
  let best = 1e9;
  for (const oi of list) {
    const o = occs[oi]!;
    for (let j = o.oLo; j < o.oHi; j += 2) {
      const jj = Math.min(o.oHi - 1, j);
      const d = segDist(x, y, P[jj]!.x, P[jj]!.y, P[jj + 1]!.x, P[jj + 1]!.y) - (wArr[jj]! + MARGIN);
      if (d < best) best = d;
    }
  }
  return best;
};
const hidden = (p: V, i: number): boolean => clearance(p.x, p.y, i) < 0;

/* ------------------------------------------------------------- lighting */

const LX = -0.52, LY = -0.63, LZ = 0.578;
const mottA = pick(SHA, "mot", 1, 0, TAU);
const mottB = pick(SHA, "mot", 2, 0, TAU);

// On the dark plate the ground IS the black, so linework is light: ink density
// follows illumination. Lit flanks silt up with strokes, shadowed flanks fall
// away to bare plate. Lambert on a tube whose axis follows the body.
const ink = (i: number, s: number): number => {
  const nl = Nr[i]!.x * LX + Nr[i]!.y * LY;
  const lam = s * nl + Math.sqrt(Math.max(0, 1 - s * s)) * LZ;
  let v = Math.pow(clamp(lam, 0, 1), 1.15);
  v *= 1 - 0.34 * Math.pow(Math.abs(s), 4);                   // silhouette turns away
  const u = i / (N - 1);
  v *= 1 + 0.12 * Math.sin(u * TAU * 5 + mottA) + 0.08 * Math.sin(u * TAU * 11 + mottB);
  return clamp(v, 0, 1);
};

const SHADOW = 20;
const inkAt = (i: number, s: number, p: V): number => {
  let v = ink(i, s);
  const c = clearance(p.x, p.y, i);
  if (c >= 0 && c < SHADOW) v *= 0.16 + 0.84 * (c / SHADOW);   // cast shadow
  return v;
};

/* ======================================= the scour: what is not on the plate */
// Two kinds of absence, and neither of them is drawn.
//
// The first is the seventh-hour cut: a graver slip, a lens-shaped gouge laid
// ACROSS the body. Inside it there is no tone at all; along its lip the burr
// has shouldered the neighbouring strokes aside by a couple of points, the way
// a scored copper plate does. It is not an outline and it is not a gash: the
// silhouette runs straight through it, unbroken, which is exactly what makes
// it read as damage to the PLATE rather than a wound drawn on the animal.
// Two generations of burnishing shrink it and let the tone creep back.
//
// The second is the caput corvi -- the raven's head, the sign that the
// blackening has been reached. One patch of the plate where the hatching stops
// dead and the ground shows through solid. No edge, no label, no explanation.

let cutC: V = { x: 0, y: 0 }, cutU: V = { x: 1, y: 0 }, cutV: V = { x: 0, y: 1 };
let cutHalfLen = 0, cutHalfW = 0, cutBurr = 0, cutSurv = 0, cutAtI = 0;
// Where the tone is DENSEST and in plain sight, because that is the only place
// an absence is unmistakably an absence and not just the shadowed flank.
const bestLitS = (i: number): number => {
  let vb = -1, sb = 0;
  for (let q = -5; q <= 5; q++) {
    const sv = q / 6.5;
    const p = pt(i, sv);
    if (hidden(p, i)) continue;
    const v = inkAt(i, sv, p);
    if (v > vb) { vb = v; sb = sv; }
  }
  return vb < 0 ? 1e9 : sb;
};

if (CUT_ON) {
  const r = draw(cutSeed(), "sevenths", TURN);
  const uc = 0.17 + 0.40 * r();          // on the body proper, never out on the thin tail
  const i0 = clamp(Math.round(uc * (N - 1)), 0, N - 1);
  let bi = i0, bv = -1, bs = 0;
  for (let i = Math.max(4, i0 - 70); i <= Math.min(N - 5, i0 + 70); i += 5) {
    const sv = bestLitS(i);
    if (sv > 1e8) continue;
    const score = inkAt(i, sv, pt(i, sv)) * Math.min(1, wArr[i]! / wBody);
    if (score > bv) { bv = score; bi = i; bs = sv; }
  }
  cutAtI = bi;
  cutC = pt(cutAtI, clamp(bs + 0.22 * (2 * r() - 1), -0.62, 0.62));
  const th = (r() > 0.5 ? 1 : -1) * (0.86 + 0.52 * r());
  cutU = rot(T[cutAtI]!, th);
  cutV = { x: -cutU.y, y: cutU.x };
  const size = 0.30 + 0.70 * cutDepth;           // the region shrinks as it heals
  cutHalfLen = (1.60 + 0.80 * r()) * wBody * size;
  cutHalfW = (0.13 + 0.07 * r()) * wBody * size;
  cutBurr = 3.8 * size;
  cutSurv = (1 - cutDepth) * 0.8;                // ...and the tone comes back into it
}

let corvC: V = { x: 0, y: 0 }, corvR = 0, corvA = 0, corvB = 0, corvAtI = 0;
if (hasCorvi) {
  const r = draw(SHA, "corvus", 0);
  const u0 = 0.24 + 0.34 * r();
  const jit = 0.14 * (2 * r() - 1);
  corvR = 0.33 * wBody + 3.4;
  // Six candidate seats around the body, taken in a fixed order. The first one
  // that is not within reach of this cycle's wound wins -- the two absences
  // must never be mistaken for one another, and they are different things.
  const keepOff = CUT_ON ? cutHalfLen + corvR + 26 : 0;
  let far = -1;
  for (let k = 0; k < 6; k++) {
    const uc = clamp(u0 + k * 0.1187 - Math.floor(u0 + k * 0.1187 - 0.20), 0.20, 0.62);
    const j0 = Math.round(uc * (N - 1));
    let bi = j0, bv = -1, bs = 0;
    for (let i = Math.max(4, j0 - 60); i <= Math.min(N - 5, j0 + 60); i += 5) {
      const sv = bestLitS(i);
      if (sv > 1e8) continue;
      const score = inkAt(i, sv, pt(i, sv)) * Math.min(1, wArr[i]! / wBody);
      if (score > bv) { bv = score; bi = i; bs = sv; }
    }
    const c = pt(bi, clamp(bs + jit, -0.55, 0.55));
    const d = CUT_ON ? Math.hypot(c.x - cutC.x, c.y - cutC.y) : 1e9;
    if (d > far) { far = d; corvAtI = bi; corvC = c; }
    if (d >= keepOff) break;
  }
  corvA = r() * TAU;
  corvB = r() * TAU;
}

const SCOUR = CUT_ON || hasCorvi;
let cutTicks = 0, cutHatch = 0, cutContour = 0, cutEdge = 0;
let corvTicks = 0, corvHatch = 0, corvContour = 0, corvEdge = 0;
let hitCut = false, hitCorv = false;

// null => this point is not on the plate. otherwise: the point, possibly
// shouldered aside by the burr.
const scour = (p: V, tag: number): V | null => {
  if (!SCOUR) return p;
  let q = p;
  if (CUT_ON) {
    const dx = p.x - cutC.x, dy = p.y - cutC.y;
    const a = dx * cutU.x + dy * cutU.y;
    if (a > -cutHalfLen && a < cutHalfLen) {
      const b = dx * cutV.x + dy * cutV.y;
      const e = a / cutHalfLen;
      const lens = Math.pow(Math.max(0, 1 - e * e), 0.55);      // the slip tapers out
      const hw = cutHalfW * lens;
      const ab = Math.abs(b);
      if (ab < hw) {
        if (cutSurv <= 0 || ((fnv1a(SHA + ":scour:" + tag) >>> 9) & 1023) / 1024 >= cutSurv) { hitCut = true; return null; }
      } else if (ab < hw + cutBurr * lens) {
        const push = (hw + cutBurr * lens - ab) * 0.62 * (b < 0 ? -1 : 1);
        q = { x: q.x + cutV.x * push, y: q.y + cutV.y * push };
        hitCut = true;
      }
    }
  }
  if (hasCorvi) {
    const dx = q.x - corvC.x, dy = q.y - corvC.y;
    const d = Math.hypot(dx, dy);
    if (d < corvR + 4.4) {
      const th = Math.atan2(dy, dx);
      const rw = corvR * (1 + 0.21 * Math.sin(3 * th + corvA) + 0.13 * Math.sin(5 * th + corvB));
      if (d < rw) { hitCorv = true; return null; }
      if (d < rw + 3.0 && ((fnv1a(SHA + ":corv:" + tag) >>> 11) & 255) < 150) { hitCorv = true; return null; }
    }
  }
  return q;
};

// A stroke that runs into the score does not disappear: it STOPS at the lip,
// and one that crosses the score is left in two pieces with a gap between. One
// tag for the whole stroke, so the burnishing of a healing cut lets whole
// strokes back rather than speckling them.
const scourSeg = (a: V, b: V, tag: number): V[][] => {
  hitCut = false; hitCorv = false;
  if (!SCOUR) return [[a, b]];
  const NS = 12;
  const alive: boolean[] = new Array(NS + 1);
  const qs: V[] = new Array(NS + 1);
  for (let q = 0; q <= NS; q++) {
    const t = q / NS;
    const raw: V = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const sp = scour(raw, tag);
    alive[q] = sp !== null;
    qs[q] = sp === null ? raw : sp;
  }
  const out: V[][] = [];
  let q = 0;
  while (q <= NS) {
    if (!alive[q]) { q++; continue; }
    let e = q;
    while (e + 1 <= NS && alive[e + 1]) e++;
    if (e > q) out.push([qs[q]!, qs[e]!]);
    q = e + 1;
  }
  return out;
};

/* ============================================ the single body outline */

const STEP = 4;
const idxList: number[] = [];
for (let i = 0; i < N; i += STEP) idxList.push(i);
if (idxList[idxList.length - 1] !== N - 1) idxList.push(N - 1);

const ring: V[] = [];
const ringIdx: number[] = [];       // body sample each ring vertex belongs to

for (const i of idxList) { ring.push(pt(i, -1)); ringIdx.push(i); }          // spine edge, head -> tail
{
  const i = N - 1, w = wArr[i]!;
  for (const a of [0.25, 0.5, 0.75]) {
    const th = a * Math.PI;
    ring.push({
      x: P[i]!.x + w * (-Math.cos(th) * Nr[i]!.x + Math.sin(th) * T[i]!.x),
      y: P[i]!.y + w * (-Math.cos(th) * Nr[i]!.y + Math.sin(th) * T[i]!.y),
    });
    ringIdx.push(i);
  }
}
for (let k = idxList.length - 1; k >= 0; k--) { const i = idxList[k]!; ring.push(pt(i, 1)); ringIdx.push(i); }
{
  // the gape: lips forward, a deep notch cut back into the skull
  const i = 0, w = wArr[0]!;
  const lip: [number, number][] = [[-0.92, -0.50], [-0.52, 0.34], [-0.13, 1.18], [0.30, 0.44], [0.80, -0.46]];
  for (const [ns, ts] of lip) {
    ring.push({
      x: P[i]!.x + w * (ns * Nr[i]!.x + ts * T[i]!.x),
      y: P[i]!.y + w * (ns * Nr[i]!.y + ts * T[i]!.y),
    });
    ringIdx.push(i);
  }
}

// Catmull-Rom -> cubic Bezier around the closed ring
const bezRing = (r: V[]): { c1: V[]; c2: V[] } => {
  const m = r.length;
  const a: V[] = new Array(m), b: V[] = new Array(m);
  for (let k = 0; k < m; k++) {
    const p0 = r[(k - 1 + m) % m]!, p1 = r[k]!, p2 = r[(k + 1) % m]!, p3 = r[(k + 2) % m]!;
    a[k] = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    b[k] = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
  }
  return { c1: a, c2: b };
};

const dOfRing = (r: V[], a: V[], b: V[]): string => {
  const m = r.length;
  let d = "M" + f2(r[0]!.x) + " " + f2(r[0]!.y);
  for (let k = 0; k < m; k++) {
    const p2 = r[(k + 1) % m]!;
    d += "C" + f2(a[k]!.x) + " " + f2(a[k]!.y) + " " + f2(b[k]!.x) + " " + f2(b[k]!.y) +
      " " + f2(p2.x) + " " + f2(p2.y);
  }
  return d + "Z";
};

const M = ring.length;
const bez = bezRing(ring);
const c1 = bez.c1, c2 = bez.c2;

// per-segment arc length (so the break pattern lands where we mean it to)
const segLen: number[] = new Array(M);
for (let k = 0; k < M; k++) {
  const p1 = ring[k]!, p2 = ring[(k + 1) % M]!, a = c1[k]!, b = c2[k]!;
  let L = 0; let px = p1.x, py = p1.y;
  for (let q = 1; q <= 10; q++) {
    const t = q / 10, mt = 1 - t;
    const x = mt * mt * mt * p1.x + 3 * mt * mt * t * a.x + 3 * mt * t * t * b.x + t * t * t * p2.x;
    const y = mt * mt * mt * p1.y + 3 * mt * mt * t * a.y + 3 * mt * t * t * b.y + t * t * t * p2.y;
    L += Math.hypot(x - px, y - py); px = x; py = y;
  }
  segLen[k] = L;
}
const cumSeg: number[] = new Array(M + 1);
cumSeg[0] = 0;
for (let k = 0; k < M; k++) cumSeg[k + 1] = cumSeg[k]! + segLen[k]!;
const PATHLEN = cumSeg[M]!;

// the engraver's trick: where the body dives under itself, the outline stops
const occRing: boolean[] = ring.map((p, k) => hidden(p, ringIdx[k]!));
const gaps: [number, number][] = [];
{
  let k = 0;
  while (k < M) {
    if (!occRing[k]) { k++; continue; }
    let e = k;
    while (e + 1 < M && occRing[e + 1]) e++;
    const a = cumSeg[k]! - 0.5 * segLen[(k - 1 + M) % M]!;
    const b = cumSeg[e]! + 1.5 * segLen[e]!;
    gaps.push([Math.max(0, a), Math.min(PATHLEN, b)]);
    k = e + 1;
  }
}
gaps.sort((a, b) => a[0] - b[0]);
const merged: [number, number][] = [];
for (const gp of gaps) {
  const last = merged[merged.length - 1];
  if (last && gp[0] - last[1] < 2.5) last[1] = Math.max(last[1], gp[1]);
  else merged.push([gp[0], gp[1]]);
}

let dashArr = "";
{
  const parts: number[] = [];
  let cursor = 0;
  for (const [a, b] of merged) {
    parts.push(Math.max(0, a - cursor));
    parts.push(Math.max(0.5, b - a));
    cursor = b;
  }
  parts.push(Math.max(0.5, PATHLEN - cursor));
  if (parts.length % 2 === 1) parts.push(0.001);        // keep the loop in phase
  dashArr = parts.map(f2).join(" ");
}

const bodyD = dOfRing(ring, c1, c2);

/* ============================================ the one that is also there */
// Built from the same knot, the same resampler, the same width anchors, the
// same curvature clamp and the same ring-to-Bezier as the body above -- the
// numbers are simply somewhere else. It does not arrive and it does not leave.

let ghostD = "", ghostTicks = "";
let ghostHead: V = { x: CX, y: CY };
let ghostSeg = 0;
if (hasGhost) {
  const r = draw(SHA, "ghost", 0);
  const GP: KnotP = {
    rotBase: BASEK.rotBase + 0.22 + 0.30 * r(),
    phK: BASEK.phK + 0.60 + 0.85 * r(),
    R0: BASEK.R0 * (0.952 + 0.034 * r()),
    R1: BASEK.R1 * (1.02 + 0.10 * r()),
    K: BASEK.K,
    eps: BASEK.eps,
    wob1: BASEK.wob1 * (0.70 + 0.9 * r()),
    wob2: BASEK.wob2 * (0.70 + 0.9 * r()),
    ph1: BASEK.ph1 + 0.85 * r(),
    ph2: BASEK.ph2 + 0.85 * r(),
    aw1: BASEK.aw1 * 1.26,
    aw2: BASEK.aw2 * 1.26,
    ph3: BASEK.ph3 + 0.5,
    ph4: BASEK.ph4 + 0.5,
  };
  const kg = mkKnot(GP);
  const RG = 3000, NG = 700;
  const rawG: V[] = new Array(RG + 1);
  for (let k = 0; k <= RG; k++) rawG[k] = kg(k / RG);
  const ag = resampleArc(rawG, NG);
  const PG = ag.P, SG = ag.S;
  const fg = framesOf(PG);
  const lg = curvLimitOf(PG, NG, 0.62);
  const wG: number[] = new Array(NG);
  for (let i = 0; i < NG; i++) {
    const l = (i / (NG - 1)) * SG;
    let w = pw(l, anchors);
    if (l > 0.58 * SG) { const f = (l - 0.58 * SG) / (SG - 0.58 * SG); w *= 1 - 0.91 * Math.pow(f, 2.6); }
    const u = i / (NG - 1);
    // it has no mouth: the tail simply resumes being the head
    if (u > 0.90) { const t = sstep((u - 0.90) / 0.10); w = w * (1 - t) + pw(0, anchors) * t; }
    wG[i] = Math.max(1.2, Math.min(w * 0.88, lg[i]!));
  }
  for (let sm = 0; sm < 3; sm++) {
    const cp = wG.slice();
    for (let i = 1; i < NG - 1; i++) wG[i] = (cp[i - 1]! + 2 * cp[i]! + cp[i + 1]!) / 4;
  }
  for (let i = 0; i < NG; i++) wG[i] = Math.min(wG[i]!, lg[i]!);
  const ptG = (i: number, sv: number): V => ({
    x: PG[i]!.x + fg.Nr[i]!.x * sv * wG[i]!,
    y: PG[i]!.y + fg.Nr[i]!.y * sv * wG[i]!,
  });
  const ig: number[] = [];
  for (let i = 0; i < NG; i += 7) ig.push(i);
  if (ig[ig.length - 1] !== NG - 1) ig.push(NG - 1);
  const ringG: V[] = [];
  for (const i of ig) ringG.push(ptG(i, -1));
  for (let k = ig.length - 1; k >= 0; k--) ringG.push(ptG(ig[k]!, 1));
  const bg = bezRing(ringG);
  ghostD = dOfRing(ringG, bg.c1, bg.c2);
  ghostSeg = ringG.length;
  ghostHead = PG[0]!;
  for (let i = 5; i < NG - 5; i += 9) {
    const a = ptG(i, -0.74), b = ptG(i, 0.74);
    ghostTicks += "M" + f2(a.x) + " " + f2(a.y) + "l" + f2(b.x - a.x) + " " + f2(b.y - a.y);
  }
}

/* ================================================== engraving passes */

const SMAX = 0.955;
const SVENT = 0.44;                              // where dorsal scales give way to scutes
const NB = 7 + Math.round(g * 5);                // dorsal bands across the width

let tickCount = 0, hatchCount = 0;

// compact segment: absolute move, relative line
const seg = (a: V, b: V): string =>
  "M" + f2(a.x) + " " + f2(a.y) + "l" + f2(b.x - a.x) + " " + f2(b.y - a.y);

// --- scales: perpendicular ticks, a real density gradient spine -> belly ---
// 6 groups = 3 stroke weights (tone) x 2 creep phases, so the shimmer is incoherent
const TICKG = 6;
const tickPaths: string[] = new Array(TICKG).fill("");
const bandEdges: number[] = [];   // longitudinal scale-row lines run along these
{
  // Scale spacing is proportional to the local half-width, so a thicker body
  // would otherwise read SPARSER as strata accumulate. Compensate against the
  // width at layers=1 and tighten a little further, so tone genuinely deepens.
  const base = 0.86 * (18 / wBody) * (1 - 0.14 * g);
  type Band = { sLo: number; sHi: number; dens: number; ph: number };
  const bands: Band[] = [];
  for (let j = 0; j < NB; j++) {
    const sLo = -SMAX + ((SVENT + SMAX) * j) / NB;
    const sHi = -SMAX + ((SVENT + SMAX) * (j + 1)) / NB;
    const xr = ((sLo + sHi) / 2 + SMAX) / (SVENT + SMAX);      // 0 spine, 1 flank
    bands.push({ sLo, sHi, dens: 0.26 + 0.86 * Math.pow(xr, 1.25), ph: (j % 2) * 0.5 + pick(SHA, "bph", j, 0, 0.35) });
  }
  // ventral scutes: one wide band, far sparser
  bands.push({ sLo: SVENT + 0.02, sHi: SMAX, dens: 1.62, ph: pick(SHA, "bph", 99, 0, 1) });

  bandEdges.push(-SMAX);
  for (const bd of bands) bandEdges.push(bd.sHi);
  bands.forEach((bd, j) => {
    const sMid = (bd.sLo + bd.sHi) / 2;
    let i = 2 + Math.round(bd.ph * 8);
    let n = 0;
    while (i < N - 2) {
      const w = wArr[i]!;
      const a = pt(i, bd.sLo), b = pt(i, bd.sHi);
      const mid = pt(i, sMid);
      const v = inkAt(i, sMid, mid);
      if (v > 0.05 && w > 2.6 && !hidden(mid, i) && !hidden(a, i) && !hidden(b, i)) {
        const parts = scourSeg(a, b, j * 131071 + n * 3);
        if (hitCut) cutTicks++;
        if (hitCorv) corvTicks++;
        const wb = v < 0.36 ? 0 : v < 0.7 ? 1 : 2;
        const gi = wb * 2 + ((fnv1a(SHA + ":tk:" + j + ":" + n) >>> 5) & 1);
        for (const pr of parts) { tickPaths[gi] += seg(pr[0]!, pr[1]!); tickCount++; }
      }
      n++;
      const hd = i * ds < headLen * 1.15 ? 0.6 : 1;
      i += Math.max(1, Math.round((w * base * bd.dens * hd) / ds));
    }
  });
}

// --- contour shading -------------------------------------------------------
// The engraver's line: long strokes that follow the form, laid at even spacing
// and simply STOPPING where the light leaves. Tone is where they stop and how
// heavy they are -- never opacity.
const contour: string[][] = [[], [], []];
const CW = [0.45, 0.62, 0.85];
let contourRuns = 0;
{
  // Contour spacing tightens as strata accumulate, so the added bulk is carried
  // by MORE line rather than the same line spread thinner.
  const NL = clamp(Math.round(wBody / (1.55 - 0.3 * g)), 9, 30);
  for (let q = 0; q < NL; q++) {
    const sv = -0.93 + (1.86 * q) / (NL - 1);
    const cut = 0.17 + pick(SHA, "cut", q, 0, 0.11);
    let pts: string[] = [];
    let sum = 0, cnt = 0;
    const flush = (): void => {
      if (pts.length > 2) {
        const avg = sum / cnt;
        contour[avg < 0.46 ? 0 : avg < 0.74 ? 1 : 2]!.push(pts.join(" "));
        contourRuns++;
      }
      pts = []; sum = 0; cnt = 0;
    };
    let prev: V = pt(0, sv);
    for (let i = 0; i < N; i += 4) {
      const p = pt(i, sv);
      const v = inkAt(i, sv, p);
      if (hidden(p, i) || wArr[i]! < 3.4 || v < cut) { flush(); continue; }
      const tg = 1048573 + q * 4093 + i;
      hitCut = false; hitCorv = false;
      const sp = scour(p, tg);
      const spm = pts.length > 0 ? scour({ x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 }, tg) : p;
      if (!sp || !spm) {
        flush();
        if (hitCut) cutContour++;
        if (hitCorv) corvContour++;
        prev = p;
        continue;
      }
      prev = p;
      pts.push(f2(sp.x) + "," + f2(sp.y));
      sum += v; cnt++;
    }
    flush();
  }
}

// --- crosshatch: a second and third direction laid only over the lit crest ---
const hatchMid: string[] = [];
const hatchHeavy: string[] = [];
{
  const passes: { slope: number; thr: number; bucket: string[]; sp0: number; sp1: number; off: number; skew: number }[] = [
    { slope: -1, thr: 0.60, bucket: hatchMid, sp0: 7.2, sp1: 3.6, off: 0.37, skew: 0.55 },
    { slope: 1, thr: 0.82, bucket: hatchHeavy, sp0: 6.4, sp1: 3.6, off: 0.71, skew: 0.9 },
  ];
  const HB = Math.max(3, Math.round(NB * 0.7));
  for (const ps of passes) {
    for (let j = 0; j < HB; j++) {
      const sLo = -SMAX + (2 * SMAX * j) / HB;
      const sHi = -SMAX + (2 * SMAX * (j + 1)) / HB;
      const sMid = (sLo + sHi) / 2;
      let i = 3 + Math.round(ps.off * 11);
      while (i < N - 4) {
        const w = wArr[i]!;
        const hd = i * ds < headLen * 1.15 ? 0.55 : 1;
        const skew = Math.max(2, Math.round((w * ps.skew * hd) / ds));
        const i2 = clamp(Math.round(i + ps.slope * skew), 0, N - 1);
        const im = Math.round((i + i2) / 2);
        const aS = ps.slope > 0 ? sLo : sHi;
        const bS = ps.slope > 0 ? sHi : sLo;
        const a = pt(i, aS), b = pt(i2, bS);
        const mid = pt(im, sMid);
        const v = inkAt(im, sMid, mid);
        if (v > ps.thr && !hidden(a, i) && !hidden(b, i2) && !hidden(mid, im)) {
          const parts = scourSeg(a, b, 4194301 + j * 7919 + i * 5 + (ps.slope > 0 ? 2 : 0));
          if (hitCut) cutHatch++;
          if (hitCorv) corvHatch++;
          for (const pr of parts) { ps.bucket.push(seg(pr[0]!, pr[1]!)); hatchCount++; }
        }
        if (w < 5) { i += 4; continue; }
        const perp = (ps.sp0 + (ps.sp1 - ps.sp0) * clamp((v - ps.thr) / (1 - ps.thr), 0, 1)) *
          clamp(w / wBody, 0.52, 1.1) * (hd < 1 ? 1.45 : 1) * (1 - 0.22 * g);
        const run = skew * ds, rise = Math.max(1e-6, (sHi - sLo) * w);
        const step = (perp * Math.hypot(run, rise)) / rise;
        i += Math.max(1, Math.round(step / ds));
      }
    }
  }
}

// --- edge weight: heavier strokes hugging the outline on the lit crest ---
const edgeSeg: string[] = [];
{
  for (const sEdge of [-0.88, 0.88]) {
    let i = 2;
    while (i < N - 6) {
      const w = wArr[i]!;
      const a = pt(i, sEdge);
      const v = inkAt(i, sEdge, a);
      if (v > 0.66 && !hidden(a, i)) {
        const i2 = Math.min(N - 1, i + Math.max(2, Math.round((w * 1.8) / ds)));
        const b = pt(i2, sEdge);
        if (!hidden(b, i2)) {
          const parts = scourSeg(a, b, 8388593 + i * 11 + (sEdge > 0 ? 1 : 0));
          if (hitCut) cutEdge++;
          if (hitCorv) corvEdge++;
          for (const pr of parts) edgeSeg.push(seg(pr[0]!, pr[1]!));
        }
      }
      i += Math.max(2, Math.round((w * 1.5) / ds));
    }
  }
}

/* ------------------------------------------------------------ the head */

const headParts: string[] = [];
const jawParts: string[] = [];
let eyeLid = "";
let eyePupil = "";
{
  const iAt = (frac: number): number => clamp(Math.round((frac * headLen) / ds), 0, N - 1);
  const poly = (fa: number, fb: number, sa: number, sb: number, bow: number, n: number): string => {
    const o: string[] = [];
    const ia = iAt(fa), ib = iAt(fb);
    for (let q = 0; q <= n; q++) {
      const t = q / n;
      const i = Math.round(ia + (ib - ia) * t);
      const sv = sa + (sb - sa) * sstep(t) + bow * Math.sin(Math.PI * t);
      const p = pt(clamp(i, 0, N - 1), sv);
      o.push(f2(p.x) + "," + f2(p.y));
    }
    return o.join(" ");
  };

  // brow ridge, temple, cheek: the arcs that give the skull its mass
  headParts.push(poly(0.08, 0.86, -0.88, -0.30, -0.06, 22));
  headParts.push(poly(0.46, 1.15, -0.22, -0.72, 0.10, 18));

  // nostril
  {
    const i = iAt(0.13);
    const a = pt(i, -0.26), b = pt(i, -0.02);
    headParts.push(f2(a.x) + "," + f2(a.y) + " " + f2(b.x) + "," + f2(b.y));
  }

  // --- the jaw: a wedge opening at the snout, hinged behind the eye ---
  const fHinge = 0.64;
  {
    // commissure -- the line of the mouth, snout to hinge
    jawParts.push("POLY" + poly(0.02, fHinge, 0.02, 0.52, -0.10, 18));
    // the lower jaw itself, slung beneath it
    jawParts.push("POLY" + poly(0.02, fHinge, 0.70, 0.62, 0.22, 18));
    // the quadrate strut back from the hinge
    jawParts.push("POLY" + poly(fHinge, 1.12, 0.52, 0.86, 0.0, 8));

    // teeth: recurved fangs off both jaws, longest at the front
    for (let q = 0; q < 8; q++) {
      const t = q / 8;
      const f = 0.05 + (fHinge - 0.16) * t;
      const i = iAt(f);
      const sU = 0.02 + 0.50 * sstep((f - 0.02) / (fHinge - 0.02));
      const grow = 0.30 * (1 - 0.55 * t);
      const a = pt(i, sU), b = pt(clamp(i - 3, 0, N - 1), sU + grow);
      jawParts.push(seg(a, b));
      const sL = 0.70 - 0.08 * sstep(t) + 0.22 * Math.sin(Math.PI * t);
      const c = pt(i, sL), d = pt(clamp(i - 3, 0, N - 1), sL - grow * 0.85);
      jawParts.push(seg(c, d));
    }
  }

  // --- the eye: an almond lid, and the one ichor mark on the plate ---
  {
    const i = iAt(0.42);
    const c = pt(i, -0.40);
    const ang = Math.atan2(T[i]!.y, T[i]!.x);
    const ax = wHead * 0.36, by = wHead * 0.205;
    // lens: pointed at both canthi, not a circle
    const lens = (rx: number, ry: number, pnt: number, n: number, t0 = 0, t1 = 1): string => {
      const o: string[] = [];
      for (let q = 0; q <= n; q++) {
        const th = (t0 + (t1 - t0) * (q / n)) * TAU;
        const sh = Math.pow(Math.abs(Math.cos(th)), pnt) * (Math.cos(th) < 0 ? -1 : 1);
        const v = rot({ x: rx * sh, y: ry * Math.sin(th) }, ang);
        o.push(f2(c.x + v.x) + "," + f2(c.y + v.y));
      }
      return o.join(" ");
    };
    eyeLid = lens(ax, by, 0.55, 30);
    headParts.push(lens(ax * 1.30, by * 1.75, 0.7, 20, 0.54, 1.02));   // brow over the socket
    // a vertical slit pupil, the way a night hunter carries one
    eyePupil = lens(ax * 0.17, by * 0.94, 1.6, 22);
  }
}

/* ---------------------------------------------------- tail tip + plate */

const tailRings: string[] = [];
{
  for (let q = 1; q <= 4; q++) {
    const i = N - 1 - q * Math.round(9 + 5 * g);
    if (i < 1) break;
    const a = pt(i, -0.9), b = pt(i, 0.9);
    if (hidden(a, i) || hidden(b, i)) continue;
    tailRings.push("M" + f2(a.x) + " " + f2(a.y) + "L" + f2(b.x) + " " + f2(b.y));
  }
}

const frame: string[] = [];
{
  const mk = (in_: number): string => {
    const a = in_, b1 = W - in_, c = H - in_;
    return `${a},${a} ${b1},${a} ${b1},${c} ${a},${c} ${a},${a}`;
  };
  frame.push(mk(24));
  frame.push(mk(31));
}

/* ----------------------------------------- four marks, one to each corner */
// Where a printer would put his registration. Four of them, none the same as
// another, in the order the CANOPIC block at the head of this file fixes. The
// shape is chosen by CORNER, never by name, so the names can be substituted
// without a single line on the plate moving.

const cornerMarks: string[] = [];
{
  const INS = 40;
  const anch = [
    { x: INS, y: INS, sx: 1, sy: 1 },              // NW
    { x: W - INS, y: INS, sx: -1, sy: 1 },         // NE
    { x: W - INS, y: H - INS, sx: -1, sy: -1 },    // SE
    // SW stands off the bottom rule, because the strata tally already has that
    // corner and a mark sitting in the same row would read as part of the count
    { x: INS, y: H - 86, sx: 1, sy: -1 },          // SW
  ];

  // the quadrant, struck out in code so its arc is a real arc
  const quad: number[] = [];
  for (let q = 0; q <= 12; q++) {
    const th = 0.10 + (1.46 - 0.10) * (q / 12);
    quad.push(14.5 * Math.cos(th), 14.5 * Math.sin(th));
  }
  const ray = (th: number, r0: number, r1: number): number[] =>
    [r0 * Math.cos(th), r0 * Math.sin(th), r1 * Math.cos(th), r1 * Math.sin(th)];

  const shapes: number[][][] = [
    // NW -- the lintel: a squared angle, stepped once, with a bar set off it
    [[0, 15, 0, 0, 15, 0], [0, 5.5, 5.5, 5.5, 5.5, 0], [9.5, 9.8, 14.6, 9.8], [12.2, 12.4, 12.2, 16.2]],
    // NE -- the comb: a spine, three obliques shortening, one crossbar
    [[0, 0, 0, 15.5], [0, 2, 9.2, 5.1], [0, 6.1, 6.6, 9.2], [0, 10.2, 4.1, 13.3], [3.1, 1.2, 3.1, 12.4]],
    // SE -- the quadrant: an open arc and two rays that overrun it
    [quad, ray(0.40, 14.5, 18.9), ray(1.14, 14.5, 18.9)],
    // SW -- the lozenge: three sides of four, barred
    [[0, 8, 8, 0, 16, 8, 8, 16], [5.4, 8, 10.8, 8], [12.8, 12.8, 16.4, 16.4]],
  ];

  CANOPIC.forEach((_c, ci) => {
    const a = anch[ci]!;
    for (const poly of shapes[ci]!) {
      const o: string[] = [];
      for (let q = 0; q < poly.length; q += 2) {
        o.push(f2(a.x + a.sx * poly[q]!) + "," + f2(a.y + a.sy * poly[q + 1]!));
      }
      cornerMarks.push(o.join(" "));
    }
  });
}

// tally of the strata, cut into the plate like a printer's count
const tally: string[] = [];
{
  const x0 = 60, y0 = H - 48, hgt = 17, gapx = 7;
  let x = x0;
  for (let n = 0; n < LAYERS; n++) {
    if (n % 5 === 4) {
      tally.push("M" + f2(x - 4 * gapx - 3) + " " + f2(y0 + hgt) + "L" + f2(x + 3) + " " + f2(y0));
      x += gapx + 9;
    } else {
      tally.push("M" + f2(x) + " " + f2(y0) + "L" + f2(x) + " " + f2(y0 + hgt));
      x += gapx;
    }
  }
}

/* ============================================================== emit */

/* ================================================================= the strike */
// There is no trigger and there can be none, so the whole thing is one very
// long clock with almost nothing on it.
//
// For nearly three minutes: the breath, and that is all. Then the GATHERING --
// eight and a half seconds in which the coil draws in by one per cent and the
// head backs off by under two, an amount you cannot name and can only feel,
// arranged so that almost none of it happens until the last half second.
// Then four tenths of a second in which the ring flattens toward you and the
// skull is suddenly very close.
//
// Then it lets go. Three and a half seconds take away six sevenths of it; the
// last few per cent are given the next twenty-six seconds to leave, so there is
// no moment at which it has stopped, and the value it returns to is the value
// it started from, exactly.
//
// The breath is a separate animation on the same group, summed, with its own
// clock -- the strike neither interrupts it nor resets it.

const f6 = (v: number): string => {
  let t = v.toFixed(6);
  if (t.indexOf(".") >= 0) t = t.replace(/0+$/, "").replace(/\.$/, "");
  return t === "-0" || t === "" ? "0" : t;
};

interface Beat { t: number; head: number; sx: number; sy: number; ease: string }
interface Track { kt: string; ks: string; head: string; coil: string; lunge: number; gather: number; back: number }

const strikeTrack = (period: number, open: number, peak: number, px: number, py: number): Track => {
  const h = (f: number): number => 1 + (peak - 1) * f;
  const x = (f: number): number => 1 + (px - 1) * f;
  const y = (f: number): number => 1 + (py - 1) * f;
  const beats: Beat[] = [
    // t (s)            head        coil x     coil y     easing OUT of this beat
    { t: 0, head: 1, sx: 1, sy: 1, ease: "0 0 1 1" },
    // THE GATHERING. Eight and a half seconds, of which the first five and a
    // half do nothing at all; then a third of one per cent; then, in the four
    // tenths of a second immediately before the lunge, the deepest part of the
    // recoil -- the coil drawn in, the head pulled back onto its own neck.
    // Under two per cent, all told. You cannot see it. You can feel it.
    { t: open, head: 1, sx: 1, sy: 1, ease: "0.93 0 0.96 0.42" },
    { t: open + 5.6, head: 0.997, sx: 0.9982, sy: 0.9982, ease: "0.70 0 0.85 0.40" },
    { t: open + 8.0, head: 0.9895, sx: 0.9945, sy: 0.9945, ease: "0.35 0 0.55 1" },
    { t: open + 8.4, head: 0.9832, sx: 0.9902, sy: 0.9902, ease: "0.10 0.62 0.28 1" },
    // 0.4s. The ring flattens hard toward the viewer -- the axis it flattens on
    // crowds the scale ticks together -- and the skull is very close.
    { t: open + 8.8, head: peak, sx: px, sy: py, ease: "0.40 0 0.60 1" },
    { t: open + 8.96, head: h(0.962), sx: x(0.885), sy: y(0.960), ease: "0.50 0 0.28 1" },
    // and then it lets go, and goes on letting go for half a minute
    { t: open + 12.5, head: h(0.137), sx: x(0.115), sy: y(0.125), ease: "0.42 0 0.30 1" },
    { t: open + 21.5, head: h(0.0158), sx: x(0.014), sy: y(0.0155), ease: "0.35 0 0.25 1" },
    { t: open + 39.0, head: 1, sx: 1, sy: 1, ease: "0 0 1 1" },   // and it was never anywhere
    { t: period, head: 1, sx: 1, sy: 1, ease: "" },
  ];
  const kt = beats.map((b) => f6(b.t / period));
  return {
    kt: kt.join(";"),
    ks: beats.slice(0, -1).map((b) => b.ease).join(";"),
    head: beats.map((b) => f6(b.head)).join(";"),
    coil: beats.map((b) => f6(b.sx) + " " + f6(b.sy)).join(";"),
    lunge: (Number(kt[5]) - Number(kt[4])) * period,
    gather: (Number(kt[4]) - Number(kt[1])) * period,
    back: (Number(kt[9]) - Number(kt[5])) * period,
  };
};

const STRIKE_PERIOD = 252, STRIKE_OPEN = 178, BREATH = 46;
const GHOST_PERIOD = 227, GHOST_OPEN = 121, GHOST_BREATH = 53, GHOST_DASH = 181;
const mainTrack = strikeTrack(STRIKE_PERIOD, STRIKE_OPEN, 1.50, 0.895, 0.775);
const ghostTrack = strikeTrack(GHOST_PERIOD, GHOST_OPEN, 1.22, 0.944, 0.884);

// the skull's own centre: the lunge is a magnification about THIS, not a slide
const headCtr = pt(clamp(Math.round((0.30 * headLen) / ds), 0, N - 1), -0.05);

const scaleTo = (vals: string, tr: Track, dur: number): string =>
  `<animateTransform attributeName="transform" type="scale" additive="sum" values="${vals}"` +
  ` keyTimes="${tr.kt}" keySplines="${tr.ks}" calcMode="spline" dur="${dur}s" repeatCount="indefinite"/>`;

const breathe = (dur: number): string =>
  `<animateTransform attributeName="transform" type="scale" additive="sum" values="1 1;1.006 1.0042;1 1"` +
  ` keyTimes="0;0.5;1" keySplines="0.4 0 0.6 1;0.4 0 0.6 1" calcMode="spline" dur="${dur}s" repeatCount="indefinite"/>`;

const lift = (cx: number, cy: number, anims: string): string =>
  `<g transform="translate(${f2(cx)},${f2(cy)})"><g>${anims}<g transform="translate(${f2(-cx)},${f2(-cy)})">`;
const drop = `</g></g></g>`;

const spl = `calcMode="spline" keyTimes="0;1" keySplines="0.42 0 0.58 1"`;
const splT = `calcMode="spline" keyTimes="0;0.5;1" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"`;

const tickDur = [97, 113, 127, 139, 151, 163];
const durList: number[] = [];

/**
 * Fifteen places the cursor can be, and how far the plate leans toward each. Two points at
 * the most; it should read as the thing having shifted while you were not looking, not as
 * a control responding.
 */
const ZONES: [number, number][] = (() => {
  const z: [number, number][] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) z.push([(c - 2) * 0.9, (r - 1) * 0.7]);
  return z;
})();

const render = (ground: string, line: string): string => {
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  o.push(`<desc>ouroboros; double coil; layers ${LAYERS} of ${CAP}; ${K} crossings; engraved linework, no fills</desc>`);
  /*
   * Everything below the zones is inert when this file is an image.
   *
   * A README loads it through <img>, which exposes no document and dispatches no events
   * into it, so :hover can never match and every rule here is dead weight. Opened as a
   * document it is a different thing: pointer events land, :hover matches, and the plate
   * answers the cursor. Scripts are refused in both places by the serving CSP, so this is
   * the only way in. No rule outside a :hover changes anything that is drawn.
   */
  o.push(`<style>`);
  o.push(`.w{pointer-events:none}.z{fill:none;pointer-events:all}`);
  o.push(`svg:hover .w{stroke-opacity:1}`);
  for (let zi = 0; zi < ZONES.length; zi++) {
    const [dx, dy] = ZONES[zi]!;
    o.push(`.z${zi}:hover~.w{transform:translate(${f2(dx)}px,${f2(dy)}px)}`);
  }
  o.push(`</style>`);
  for (let zi = 0; zi < ZONES.length; zi++) {
    const cx = (zi % 5) * (W / 5);
    const cy = Math.floor(zi / 5) * (H / 3);
    o.push(`<rect class="z z${zi}" x="${f2(cx)}" y="${f2(cy)}" width="${f2(W / 5)}" height="${f2(H / 3)}"/>`);
  }
  o.push(`<g class="w">`);
  o.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${ground}"/>`);
  o.push(`<g fill="none" stroke="${line}" stroke-linecap="round" stroke-linejoin="round">`);

  // Behind everything, including the plate rules. Three per cent: there is no
  // moment at which it appears, because there is no moment at which it did not.
  if (hasGhost) {
    durList.push(GHOST_PERIOD); durList.push(GHOST_BREATH); durList.push(GHOST_DASH);
    o.push(`<g opacity="0.03">`);
    o.push(lift(ghostHead.x, ghostHead.y, scaleTo(ghostTrack.head, ghostTrack, GHOST_PERIOD)));
    o.push(lift(CX, CY, breathe(GHOST_BREATH) + scaleTo(ghostTrack.coil, ghostTrack, GHOST_PERIOD)));
    o.push(`<g stroke-width="1.05"><path d="${ghostD}"/></g>`);
    o.push(`<g stroke-width="0.55" stroke-dasharray="8 4" stroke-dashoffset="0">`);
    o.push(`<animate attributeName="stroke-dashoffset" values="0;-24" dur="${GHOST_DASH}s" ${spl} repeatCount="indefinite"/>`);
    o.push(`<path d="${ghostTicks}"/></g>`);
    o.push(drop + drop);
    o.push(`</g>`);
  }

  // plate
  o.push(`<g stroke-width="0.8"><polyline points="${frame[0]}"/></g>`);
  o.push(`<g stroke-width="1.9"><polyline points="${frame[1]}"/></g>`);
  o.push(`<g stroke-width="1.7"><path d="${tally.join("")}"/></g>`);
  o.push(`<g stroke-width="0.75">`);
  for (const cm of cornerMarks) o.push(`<polyline points="${cm}"/>`);
  o.push(`</g>`);

  // Everything from here to the close is the creature, and the creature alone:
  // the plate itself must not move when it lunges.
  durList.push(STRIKE_PERIOD); durList.push(BREATH);
  o.push(lift(headCtr.x, headCtr.y, scaleTo(mainTrack.head, mainTrack, STRIKE_PERIOD)));
  o.push(lift(CX, CY, breathe(BREATH) + scaleTo(mainTrack.coil, mainTrack, STRIKE_PERIOD)));

  // the shading, laid down first: contour lines then the crossing strokes
  durList.push(90);
  o.push(`<g stroke-dasharray="27 7" stroke-dashoffset="0">`);
  o.push(`<animate attributeName="stroke-dashoffset" values="0;-272" dur="90s" ${spl} repeatCount="indefinite"/>`);
  for (let b = 0; b < 3; b++) {
    if (contour[b]!.length === 0) continue;
    o.push(`<g stroke-width="${CW[b]}">`);
    for (const r of contour[b]!) o.push(`<polyline points="${r}"/>`);
    o.push(`</g>`);
  }
  o.push(`</g>`);
  o.push(`<g stroke-width="0.6"><path d="${hatchMid.join("")}"/></g>`);
  o.push(`<g stroke-width="0.95"><path d="${hatchHeavy.join("")}"/></g>`);

  // scales -- each band group creeps on its own long clock
  for (let j = 0; j < TICKG; j++) {
    if (!tickPaths[j]) continue;
    const d = tickDur[j]!;
    durList.push(d);
    o.push(
      `<g stroke-width="${f2(0.5 + 0.3 * Math.floor(j / 2))}" stroke-dasharray="7.6 2.4" stroke-dashoffset="0">` +
      `<animate attributeName="stroke-dashoffset" values="0;-20" dur="${d}s" ${spl} repeatCount="indefinite"/>` +
      `<path d="${tickPaths[j]}"/></g>`
    );
  }

  durList.push(126);
  o.push(`<g stroke-width="1.45" stroke-dasharray="9 6" stroke-dashoffset="0">`);
  o.push(`<animate attributeName="stroke-dashoffset" values="0;-150" dur="126s" ${spl} repeatCount="indefinite"/>`);
  o.push(`<path d="${edgeSeg.join("")}"/></g>`);

  o.push(`<g stroke-width="1.2"><path d="${tailRings.join("")}"/></g>`);

  // the body: ONE closed cubic path, interrupted where it dives beneath itself
  o.push(`<path d="${bodyD}" fill="none" stroke-width="${f2(1.9 + 0.7 * g)}" stroke-dasharray="${dashArr}"/>`);

  // skull
  o.push(`<g stroke-width="1.25">`);
  for (const hp of headParts) o.push(`<polyline points="${hp}"/>`);
  o.push(`</g>`);

  // jaw: the bite deepens and releases
  durList.push(40);
  o.push(`<g stroke-width="1.35" opacity="1">`);
  o.push(`<animate attributeName="opacity" values="1;0.34;1" dur="40s" ${splT} repeatCount="indefinite"/>`);
  const jl = jawParts.filter((s) => s.startsWith("POLY"));
  const jp = jawParts.filter((s) => !s.startsWith("POLY"));
  for (const j of jl) o.push(`<polyline points="${j.slice(4)}"/>`);
  o.push(`<path d="${jp.join("")}"/>`);
  o.push(`</g>`);

  o.push(`<g stroke-width="1.15"><polyline points="${eyeLid}"/></g>`);

  // ichor -- exactly one element in the plate, and it is a stroke
  durList.push(74);
  o.push(`<polyline points="${eyePupil}" stroke="#6e1f14" stroke-width="2.6" stroke-dasharray="5 3" stroke-dashoffset="0">`);
  o.push(`<animate attributeName="stroke-dashoffset" values="0;-48" dur="74s" ${spl} repeatCount="indefinite"/>`);
  o.push(`</polyline>`);

  o.push(drop + drop);
  o.push(`</g></g></svg>`);
  return o.join("\n");
};

const darkSvg = render("#0b0a09", "#d6cfc0");
const lightSvg = render("#d6cfc0", "#0b0a09");

/* ------------------------------------------------------------- report */

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const count = (s: string, re: RegExp): number => (s.match(re) || []).length;

let changed = true;
{
  const dk = resolve(outTo, "serpent-dark.svg");
  const lt = resolve(outTo, "serpent-light.svg");
  if (existsSync(dk) && existsSync(lt)) {
    changed = readFileSync(dk, "utf8") !== darkSvg || readFileSync(lt, "utf8") !== lightSvg;
  }
  /* The serpent only redraws when the strata move, so most runs are a no-op. Leaving the
     bytes alone keeps the commit guard honest instead of relying on it to notice. */
  if (changed && !dryRun) {
    mkdirSync(outTo, { recursive: true });
    writeFileSync(dk, darkSvg, "utf8");
    writeFileSync(lt, lightSvg, "utf8");
  }
}

const durs = Array.from(new Set(durList)).sort((a, b) => a - b);
console.log(`layers=${LAYERS}  cap=${CAP}  gen=${meta.generation}  sha=${SHA.slice(0, 12)}`);
console.log(`coils=2  crossings=${K}  detected=${crossings.length}  bands=${NB}`);
console.log(`curv_min=${f2(minCurvR)}  w_clamped=${clampedAt}/${N}  outline_folds=${folds}`);
console.log(`halfwidth=${f2(wBody)}  head=${f2(wHead)}  R0=${f2(R0)}  R1=${f2(R1)}  bodylen=${f2(S)}`);
console.log(`ticks=${tickCount}  hatch=${hatchCount}  contour=${contourRuns}  edge=${edgeSeg.length}  breaks=${merged.length}`);
console.log(`segments=${M}  pathlen=${f2(PATHLEN)}  elements=${count(darkSvg, /<(path|polyline|line|rect|g)\b/g)}`);
console.log(`dur_min=${durs[0]}s  durs=${durs.map((d) => d + "s").join(",")}`);
console.log(
  `strike=${STRIKE_PERIOD}s  gather=${f2(mainTrack.gather)}s  lunge=${f2(mainTrack.lunge)}s  ` +
  `withdraw=${f2(mainTrack.back)}s  breath=${BREATH}s  head_at=${f2(headCtr.x)},${f2(headCtr.y)}`
);
console.log(
  `cut=${cutPhase}  gen%${CYC}=${PHASE}  turn=${TURN}  depth=${f2(cutDepth)}  ` +
  (CUT_ON
    ? `at=${f2((cutAtI / (N - 1)) * 100)}% (${f2(cutC.x)},${f2(cutC.y)})  len=${f2(2 * cutHalfLen)}  wide=${f2(2 * cutHalfW)}  ` +
      `scoured t/h/c/e=${cutTicks}/${cutHatch}/${cutContour}/${cutEdge}`
    : `scoured t/h/c/e=0/0/0/0`)
);
console.log(
  `second_serpent=${hasGhost ? "on" : "off"} (layers>=${GHOST_AT})  ` +
  (hasGhost ? `ghost_seg=${ghostSeg}  ghost_period=${GHOST_PERIOD}s  ` : "") +
  `caput_corvi=${hasCorvi ? "on" : "off"} (layers>=${CORVI_AT})` +
  (hasCorvi
    ? `  corvi_at=${f2((corvAtI / (N - 1)) * 100)}% (${f2(corvC.x)},${f2(corvC.y)})  r=${f2(corvR)}  ` +
      `smothered t/h/c/e=${corvTicks}/${corvHatch}/${corvContour}/${corvEdge}`
    : "")
);
console.log(`corner_marks=${CANOPIC.length} in ${cornerMarks.length} strokes (${CANOPIC.map((c) => c.corner + ":" + c.direction + ":" + c.name).join(" ")})`);
console.log(`dark_bytes=${bytes(darkSvg)}  light_bytes=${bytes(lightSvg)}  changed=${changed}  dry=${dryRun}`);

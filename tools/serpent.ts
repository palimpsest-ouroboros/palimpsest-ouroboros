// serpent.ts -- zero-dependency engraved ouroboros generator.
// Composition B: the double coil. The body winds twice around the ring while its
// radius weaves in and out K times, so it crosses over itself K times and closes
// at the mouth. Everything is stroked linework; tone is line density alone.
//
//   node --experimental-strip-types serpent.ts --banner=<path> --out-dir=<dir> [--dry-run]

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
// congruent and the K crossings survive intact.
const knot = (u: number): V => {
  const ang = TAU * 2 * u + rotBase + aw1 * Math.sin(TAU * 2 * u + ph3) + aw2 * Math.sin(TAU * 4 * u + ph4);
  const ph = TAU * K * u + phK;
  const r =
    R0 + R1 * (Math.cos(ph) + EPS * Math.cos(2 * ph)) +
    wob1 * Math.cos(TAU * 2 * u + ph1) +
    wob2 * Math.cos(TAU * 4 * u + ph2);
  return { x: CX + SX * r * Math.cos(ang), y: CY + SY * r * Math.sin(ang) };
};

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

const cumRaw: number[] = new Array(RAW + 1);
cumRaw[0] = 0;
for (let k = 1; k <= RAW; k++) cumRaw[k] = cumRaw[k - 1]! + len(sub(rawPts[k]!, rawPts[k - 1]!));
const S = cumRaw[RAW]!;

const N = 1500;
const P: V[] = new Array(N);
{
  let k = 0;
  for (let i = 0; i < N; i++) {
    const target = (i / (N - 1)) * S;
    while (k < RAW - 1 && cumRaw[k + 1]! < target) k++;
    const a = cumRaw[k]!, b = cumRaw[k + 1]!;
    const t = b > a ? (target - a) / (b - a) : 0;
    P[i] = {
      x: rawPts[k]!.x + (rawPts[k + 1]!.x - rawPts[k]!.x) * t,
      y: rawPts[k]!.y + (rawPts[k + 1]!.y - rawPts[k]!.y) * t,
    };
  }
}
const ds = S / (N - 1);

// tangents + normals (n is the left normal; s = -1 is the SPINE side)
const T: V[] = new Array(N);
const Nr: V[] = new Array(N);
for (let i = 0; i < N; i++) {
  const a = P[Math.max(0, i - 1)]!, b = P[Math.min(N - 1, i + 1)]!;
  T[i] = norm(sub(b, a));
  Nr[i] = { x: -T[i]!.y, y: T[i]!.x };
}

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
const kMax: number[] = new Array(N).fill(0);
for (const sten of [3, 6, 12, 24]) {
  for (let i = 0; i < N; i++) {
    const a = P[Math.max(0, i - sten)]!, b = P[i]!, c = P[Math.min(N - 1, i + sten)]!;
    const A = len(sub(b, a)), B = len(sub(c, b)), C = len(sub(c, a));
    if (A < 1e-9 || B < 1e-9 || C < 1e-9) continue;
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
    const kappa = (2 * area2) / (A * B * C);
    if (kappa > kMax[i]!) kMax[i] = kappa;
  }
}
const limit: number[] = new Array(N);
for (let i = 0; i < N; i++) limit[i] = kMax[i]! > 1e-9 ? 0.70 / kMax[i]! : 1e9;
{
  const er = limit.slice();
  const R = 5;
  for (let i = 0; i < N; i++) {
    let m = 1e9;
    for (let j = Math.max(0, i - R); j <= Math.min(N - 1, i + R); j++) m = Math.min(m, er[j]!);
    limit[i] = m;
  }
  for (let s = 0; s < 4; s++) {
    const cp = limit.slice();
    for (let i = 1; i < N - 1; i++) limit[i] = (cp[i - 1]! + 2 * cp[i]! + cp[i + 1]!) / 4;
  }
}
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

const M = ring.length;
// Catmull-Rom -> cubic Bezier around the closed ring
const c1: V[] = new Array(M), c2: V[] = new Array(M);
for (let k = 0; k < M; k++) {
  const p0 = ring[(k - 1 + M) % M]!, p1 = ring[k]!, p2 = ring[(k + 1) % M]!, p3 = ring[(k + 2) % M]!;
  c1[k] = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
  c2[k] = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
}

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

let bodyD = "M" + f2(ring[0]!.x) + " " + f2(ring[0]!.y);
for (let k = 0; k < M; k++) {
  const p2 = ring[(k + 1) % M]!;
  bodyD += "C" + f2(c1[k]!.x) + " " + f2(c1[k]!.y) + " " + f2(c2[k]!.x) + " " + f2(c2[k]!.y) +
    " " + f2(p2.x) + " " + f2(p2.y);
}
bodyD += "Z";

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
        const wb = v < 0.36 ? 0 : v < 0.7 ? 1 : 2;
        const gi = wb * 2 + ((fnv1a(SHA + ":tk:" + j + ":" + n) >>> 5) & 1);
        tickPaths[gi] += seg(a, b);
        tickCount++;
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
    for (let i = 0; i < N; i += 4) {
      const p = pt(i, sv);
      const v = inkAt(i, sv, p);
      if (hidden(p, i) || wArr[i]! < 3.4 || v < cut) { flush(); continue; }
      pts.push(f2(p.x) + "," + f2(p.y));
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
          ps.bucket.push(seg(a, b));
          hatchCount++;
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
        if (!hidden(b, i2)) edgeSeg.push(seg(a, b));
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

const spl = `calcMode="spline" keyTimes="0;1" keySplines="0.42 0 0.58 1"`;
const splT = `calcMode="spline" keyTimes="0;0.5;1" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"`;

const tickDur = [97, 113, 127, 139, 151, 163];
const durList: number[] = [];

const render = (ground: string, line: string): string => {
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  o.push(`<desc>ouroboros; double coil; layers ${LAYERS} of ${CAP}; ${K} crossings; engraved linework, no fills</desc>`);
  o.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${ground}"/>`);
  o.push(`<g fill="none" stroke="${line}" stroke-linecap="round" stroke-linejoin="round">`);

  // plate
  o.push(`<g stroke-width="0.8"><polyline points="${frame[0]}"/></g>`);
  o.push(`<g stroke-width="1.9"><polyline points="${frame[1]}"/></g>`);
  o.push(`<g stroke-width="1.7"><path d="${tally.join("")}"/></g>`);

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

  o.push(`</g></svg>`);
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
console.log(`dark_bytes=${bytes(darkSvg)}  light_bytes=${bytes(lightSvg)}  changed=${changed}  dry=${dryRun}`);

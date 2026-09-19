/**
 * palimpsest.ts — the inscription engine for `palimpsest-ouroboros`.
 *
 * Every run reads the banner it wrote last time, demotes each existing text layer
 * (fainter, nudged, tilted, pushed deeper in z-order), prunes what has faded past
 * legibility, and inscribes one new line on top. The result is a palimpsest: a
 * surface that is only ever overwritten, never cleared.
 *
 * What is inscribed is not the handle but the fragment for this generation, drawn
 * from a table of twelve. The visible banner is always the newest fragment over a
 * haze of everything said before, and the file's source is a readable archive of all
 * of it. Every twelfth generation the handle resurfaces and the cycle restarts.
 *
 * All randomness is seeded from the repo HEAD sha, so the whole banner is
 * reproducible by replaying the repo's sha sequence and nothing else. There is no
 * Math.random, no Date, no clock, no ambient state anywhere in this file.
 *
 * Run with Node's type stripping — zero runtime dependencies, no build step:
 *
 *   node --experimental-strip-types tools/palimpsest.ts [flags]
 *
 *     (none)        inscribe a new generation; emit both variants; append LEDGER.md
 *                   only if the SVG bytes actually changed
 *     --readme      regenerate only the README's generated regions (idempotent)
 *     --seed=<sha>  override the HEAD sha used for seeding (replay + tests)
 *     --dry-run     compute and report to stdout, write nothing to disk
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FONT_STACK,
  LETTER_SPACING,
  altFragmentFor,
  fontSizeFor,
  fragmentFor,
  widthOf,
} from "./fragments.ts";

/* ─────────────────────────────────────────────────────────────────────────────
   Paths and constants
   ───────────────────────────────────────────────────────────────────────────── */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BANNER_LIGHT = join(ROOT, "banner-light.svg");
const BANNER_DARK = join(ROOT, "banner-dark.svg");
const LEDGER_PATH = join(ROOT, "LEDGER.md");
const README_PATH = join(ROOT, "README.md");

/** The entire palette. Exactly three hex literals may appear in any emitted SVG. */
const VELLUM = "#0b0a09";
const BONE = "#d6cfc0";
const ICHOR = "#6e1f14";

const WIDTH = 1280;
const HEIGHT = 360;

/** Every numeric attribute is rounded to this many decimals so output is byte-stable. */
const DECIMALS = 3;

/* rewrite rules */
const DEMOTE_FACTOR = 0.72;
const JITTER_XY = 3; /* +/- px */
const JITTER_ROT = 0.4; /* +/- degrees */
const PRUNE_BELOW = 0.015;
const MAX_LAYERS = 14;
const INSCRIBE_DX = 14;
const INSCRIBE_DY = 8;

/* clamps — the inscription can never walk off-canvas, however many generations run */
const X_MIN = 560;
const X_MAX = 720;
const Y_MIN = 165;
const Y_MAX = 240;
const ROT_MIN = -6;
const ROT_MAX = 6;

/* cold start placement */
const COLD_X = 640;
const COLD_Y = 205;

/* the ring */
const RING_CX = 640;
const RING_CY = 180;
const RING_R = 128;
const RING_STROKE = 4;
const RING_GAP = 0.24; /* radians of arc left open */

/* the ground */
const NOISE_MARKS = 4200;
const NOISE_STEPS = [0.06, 0.12, 0.2, 0.32];

/** Generations back over which a demoted layer bleeds from bone to ichor. */
const BLEED_OVER = 5;

const NULL_SHA = "0000000000000000000000000000000000000000";

/* ledger + readme */
const LEDGER_HEAD = "| generation | sha | layers |";
const LEDGER_RULE = "| ---: | --- | ---: |";
const STRATA_ROWS = 12;
const STRATA_START = "<!-- strata:start -->";
const STRATA_END = "<!-- strata:end -->";
const BANNER_START = "<!-- banner:start -->";
const BANNER_END = "<!-- banner:end -->";

/**
 * The ancestor of the whole design, named in the file that reenacts it.
 */
const CHRYSOPOEIA = `
    Chrysopoeia of Kleopatra. Alexandria, third century, copied and recopied until
    the earliest sheet anyone still holds is Venetian, eleventh century at best.

    A serpent drawn as a ring, its jaws closed on its own tail. Half the body is
    inked solid; the other half is left the colour of the sheet. Inside the ring,
    three words: hen to pan. The all is one.

    The half that is black and the half that is bare are not two creatures. They
    are one creature, and the drawing is the argument. Matter and spirit, the
    fixed and the volatile, the thing dissolved and the thing coagulated again —
    solve et coagula — are states of a single body that has to eat itself to
    continue.

    This file is that drawing, redrawn every twelve hours, and never twice the
    same. Each pass fades what the last pass said and writes over it without
    erasing it. What you see is the newest line. What is under it is still here,
    in the markup, going quiet at a rate of 0.72 a generation.
`;

/* ─────────────────────────────────────────────────────────────────────────────
   Types
   ───────────────────────────────────────────────────────────────────────────── */

interface Layer {
  x: number;
  y: number;
  rot: number;
  opacity: number;
  content: string;
}

interface Variant {
  name: "light" | "dark";
  ground: string;
  line: string;
}

interface BannerMeta {
  generation: number;
  sha: string;
  layers: number;
  variant: string;
  strata?: Layer[];
}

/**
 * Light and dark differ in exactly two colour tokens. Ichor is identical in both.
 * The dark one is the design; the light one is its negative.
 */
const DARK = { name: "dark", ground: VELLUM, line: BONE } satisfies Variant;
const LIGHT = { name: "light", ground: BONE, line: VELLUM } satisfies Variant;

/* ─────────────────────────────────────────────────────────────────────────────
   PRNG — FNV-1a hash into mulberry32, keyed per draw
   ───────────────────────────────────────────────────────────────────────────── */

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** One reproducible float in [0,1), keyed on `${sha}:${purpose}:${index}`. */
const draw = (sha: string, purpose: string, index: number): number => {
  const rng = mulberry32(fnv1a(`${sha}:${purpose}:${index}`));
  rng(); /* one warm-up step, for avalanche */
  return rng();
};

/** A reproducible value in [-amp, +amp]. */
const jitter = (sha: string, purpose: string, index: number, amp: number): number =>
  (draw(sha, purpose, index) * 2 - 1) * amp;

/* ─────────────────────────────────────────────────────────────────────────────
   Numbers — rounding shared by emit and parse, so round trips are byte-stable
   ───────────────────────────────────────────────────────────────────────────── */

const round = (n: number): number => Number(n.toFixed(DECIMALS));

const fmt = (n: number): string => {
  const r = round(n);
  return Object.is(r, -0) ? "0" : String(r);
};

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/** Text nodes need only these two escaped. Keeping quotes literal is what lets the
    metadata block stay readable as JSON when someone opens the file. */
const xmlText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Attribute values additionally need the quote and, defensively, the close bracket. */
const xmlAttr = (s: string): string =>
  xmlText(s).replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ─────────────────────────────────────────────────────────────────────────────
   Git
   ───────────────────────────────────────────────────────────────────────────── */

const git = (args: string[]): string =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** Resolve symlinks so the toplevel comparison is not defeated by /tmp -> /private/tmp. */
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const headSha = (): string => {
  try {
    /*
     * `git rev-parse HEAD` walks UP the directory tree, so a profile checked out
     * inside an unrelated repository would silently seed from that repository's
     * history — the same content would render a different banner depending on
     * where it sits on disk. Only accept a HEAD whose worktree root IS this repo.
     */
    if (real(git(["rev-parse", "--show-toplevel"])) !== real(ROOT)) return NULL_SHA;
    const out = git(["rev-parse", "HEAD"]);
    return /^[0-9a-f]{7,64}$/i.test(out) ? out : NULL_SHA;
  } catch {
    /* not a repo, or no commits yet — still deterministic, just unseeded */
    return NULL_SHA;
  }
};

const short = (sha: string): string => sha.slice(0, 7);

/* ─────────────────────────────────────────────────────────────────────────────
   Parse — the metadata block is the record; the <text> elements are the fallback
   ───────────────────────────────────────────────────────────────────────────── */

const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m === null ? null : m[1]!;
};

const attrNum = (attrs: string, name: string, fallback: number): number => {
  const raw = attr(attrs, name);
  const n = raw === null ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(n) ? round(n) : fallback;
};

const unxml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/**
 * The parser is total: every field comes back finite and inside its documented range.
 * demote() and inscribe() clamp, but a replay re-emits parsed layers untouched, so a
 * hand-edited, half-written or merge-mangled banner would otherwise propagate NaN,
 * off-canvas coordinates or an out-of-range opacity into both variants forever. On
 * well-formed output of this generator every clamp here is a no-op.
 */
const sane = (l: Partial<Layer>): Layer => {
  const num = (v: unknown, fb: number): number => {
    const n = typeof v === "number" ? v : Number.NaN;
    return Number.isFinite(n) ? round(n) : fb;
  };
  return {
    x: clamp(num(l.x, COLD_X), X_MIN, X_MAX),
    y: clamp(num(l.y, COLD_Y), Y_MIN, Y_MAX),
    rot: clamp(num(l.rot, 0), ROT_MIN, ROT_MAX),
    opacity: clamp(num(l.opacity, 1), 0, 1),
    content: typeof l.content === "string" && l.content.length > 0 ? l.content : fragmentFor(0),
  };
};

/**
 * Fallback for a banner whose metadata has been lost: read the layers back out of the
 * drawing itself.
 *
 * Each demoted layer is drawn twice — an ichor bed, with the line colour fading off it as
 * the layer ages — so the two passes cannot both be counted. Past the bleed horizon the
 * line-colour pass is dropped entirely and only the bed remains, which is why the beds,
 * not the visible text, are what this counts: there is exactly one per ghost at every age.
 * The newest layer has no bed, and is the last <text> in the document.
 */
const parseLayersFromText = (svg: string): Layer[] => {
  const all: { attrs: string; body: string }[] = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null = re.exec(svg);
  while (m !== null) {
    all.push({ attrs: m[1]!, body: m[2]! });
    m = re.exec(svg);
  }
  if (all.length === 0) return [];
  const read = (t: { attrs: string; body: string }): Layer => {
    const rot = /rotate\(\s*(-?[0-9.]+)/.exec(attr(t.attrs, "transform") ?? "");
    const rotNum = rot === null ? Number.NaN : Number.parseFloat(rot[1]!);
    return sane({
      x: attrNum(t.attrs, "x", COLD_X),
      y: attrNum(t.attrs, "y", COLD_Y),
      rot: Number.isFinite(rotNum) ? rotNum : 0,
      opacity: attrNum(t.attrs, "data-weight", attrNum(t.attrs, "opacity", 1)),
      content: unxml(t.body),
    });
  };
  const beds = all.filter((t) => attr(t.attrs, "fill") === ICHOR);
  /* A banner written before the strata bled carries one <text> per layer and no beds at
     all. Reading it by the bed rule would throw away every ghost it has, so fall back to
     the older shape when there are none, and the surface carries over intact. */
  if (beds.length === 0) return all.map(read);
  return [...beds.map(read), read(all[all.length - 1]!)];
};

const parseMeta = (svg: string): BannerMeta | null => {
  const block = /<metadata>([\s\S]*?)<\/metadata>/.exec(svg);
  if (block === null) return null;
  const json = /\{[\s\S]*\}/.exec(unxml(block[1]!));
  if (json === null) return null;
  try {
    const o = JSON.parse(json[0]) as Partial<BannerMeta>;
    if (typeof o.generation !== "number" || !Number.isFinite(o.generation)) return null;
    const strata = Array.isArray(o.strata) ? o.strata.map((l) => sane(l as Partial<Layer>)) : undefined;
    return {
      generation: o.generation,
      sha: typeof o.sha === "string" ? o.sha : "",
      layers: typeof o.layers === "number" ? o.layers : 0,
      variant: typeof o.variant === "string" ? o.variant : "dark",
      strata,
    };
  } catch {
    return null;
  }
};

/** Layers in document order: faintest/oldest first, newest last. */
const parseLayers = (svg: string, meta: BannerMeta | null): Layer[] => {
  if (meta !== null && meta.strata !== undefined && meta.strata.length > 0) return meta.strata;
  return parseLayersFromText(svg);
};

/* ─────────────────────────────────────────────────────────────────────────────
   Demote / prune / inscribe
   ───────────────────────────────────────────────────────────────────────────── */

/** Fainter, nudged, tilted. Relative order is preserved, so older stays deeper. */
const demote = (layers: Layer[], sha: string): Layer[] =>
  layers.map((l, i) => ({
    opacity: round(l.opacity * DEMOTE_FACTOR),
    x: round(clamp(l.x + jitter(sha, "demote-x", i, JITTER_XY), X_MIN, X_MAX)),
    y: round(clamp(l.y + jitter(sha, "demote-y", i, JITTER_XY), Y_MIN, Y_MAX)),
    rot: round(clamp(l.rot + jitter(sha, "demote-rot", i, JITTER_ROT), ROT_MIN, ROT_MAX)),
    content: l.content,
  }));

/**
 * Drop anything below legibility, then hard-cap the total (ghosts + the layer about
 * to be inscribed) by dropping the faintest/oldest first. The file can never unbound.
 */
const prune = (ghosts: Layer[]): Layer[] => {
  const kept = ghosts.filter((l) => l.opacity >= PRUNE_BELOW);
  const excess = kept.length + 1 - MAX_LAYERS;
  return excess > 0 ? kept.slice(excess) : kept;
};

/** The new top line, offset from the previous top by a seeded amount. */
const inscribe = (ghosts: Layer[], sha: string, generation: number): Layer => {
  const content = fragmentFor(generation);
  const prev = ghosts.length > 0 ? ghosts[ghosts.length - 1]! : null;
  if (prev === null) return { x: COLD_X, y: COLD_Y, rot: 0, opacity: 1, content };
  return {
    x: round(clamp(prev.x + jitter(sha, "inscribe-x", 0, INSCRIBE_DX), X_MIN, X_MAX)),
    y: round(clamp(prev.y + jitter(sha, "inscribe-y", 0, INSCRIBE_DY), Y_MIN, Y_MAX)),
    rot: 0,
    opacity: 1,
    content,
  };
};

/* ─────────────────────────────────────────────────────────────────────────────
   The ground — scorched hide, not a black rectangle
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * A few thousand 1px marks, seeded from the sha, bucketed into four weights and emitted as
 * four paths rather than four thousand elements. Density rises toward the edges, so the
 * canvas reads as hide that has been held too close to a flame.
 */
const ground = (sha: string, line: string): string[] => {
  const buckets: string[][] = NOISE_STEPS.map(() => []);
  for (let i = 0; i < NOISE_MARKS; i++) {
    const x = draw(sha, "noise-x", i) * WIDTH;
    const y = draw(sha, "noise-y", i) * HEIGHT;
    const edge = Math.max(Math.abs(x - WIDTH / 2) / (WIDTH / 2), Math.abs(y - HEIGHT / 2) / (HEIGHT / 2));
    const pick = clamp(edge * edge * 1.15 + draw(sha, "noise-w", i) * 0.6, 0, 0.999);
    const b = Math.floor(pick * NOISE_STEPS.length);
    const run = draw(sha, "noise-o", i) < 0.5 ? "h1" : "v1";
    buckets[b]!.push(`M${x.toFixed(1)} ${y.toFixed(1)}${run}`);
  }
  return buckets.map(
    (d, i) =>
      `    <path opacity="${NOISE_STEPS[i]}" stroke="${line}" d="${d.join("")}"/>`,
  );
};

/* ─────────────────────────────────────────────────────────────────────────────
   The ring — open at the point where the newest inscription begins
   ───────────────────────────────────────────────────────────────────────────── */

const ringPath = (top: Layer): string => {
  const begins = top.x - widthOf(top.content, fontSizeFor(top.content)) / 2;
  const theta = Math.atan2(top.y - RING_CY, begins - RING_CX);
  const a0 = theta + RING_GAP / 2;
  const a1 = theta - RING_GAP / 2 + Math.PI * 2;
  const mid = (a0 + a1) / 2;
  const at = (a: number): string =>
    `${fmt(RING_CX + RING_R * Math.cos(a))} ${fmt(RING_CY + RING_R * Math.sin(a))}`;
  return `M${at(a0)}A${RING_R} ${RING_R} 0 0 1 ${at(mid)}A${RING_R} ${RING_R} 0 0 1 ${at(a1)}`;
};

/* ─────────────────────────────────────────────────────────────────────────────
   Emit — one pass over the layer list produces both variants
   ───────────────────────────────────────────────────────────────────────────── */

const textEl = (l: Layer, fill: string, opacity: number, indent: string, weight: number): string => {
  const size = fontSizeFor(l.content);
  return (
    `${indent}<text x="${fmt(l.x)}" y="${fmt(l.y)}" transform="rotate(${fmt(l.rot)}, ${fmt(l.x)}, ${fmt(l.y)})"` +
    ` opacity="${fmt(opacity)}" data-weight="${fmt(weight)}" font-family="${FONT_STACK}" font-size="${fmt(size)}"` +
    ` font-weight="600" letter-spacing="${LETTER_SPACING}" text-anchor="middle" fill="${fill}">${xmlText(l.content)}</text>`
  );
};

/**
 * The ink bleed: +/-1.5px horizontally over 11s, ease-in-out via keySplines, forever.
 * It lives on the wrapping <g> so it composes with the rotate() on the inner <text>
 * instead of fighting it. This is the only animated element in the file — SMIL is the
 * only dynamic surface available, since the SVG is loaded through <img>.
 */
const SMIL = [
  `      <animateTransform attributeName="transform" type="translate"`,
  `        values="-1.5 0;1.5 0;-1.5 0" keyTimes="0;0.5;1"`,
  `        calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"`,
  `        dur="11s" repeatCount="indefinite"/>`,
].join("\n");

const render = (layers: Layer[], v: Variant, generation: number, sha: string): string => {
  const ghosts = layers.slice(0, -1);
  const top = layers[layers.length - 1]!;
  const n = layers.length;

  const meta = JSON.stringify({
    /* The FULL sha, not the short one: replay detection compares this against HEAD, and
       two commits sharing a 7-hex prefix would otherwise be mistaken for the same one and
       silently skip a generation. LEDGER.md still records the short sha, for reading. */
    generation,
    sha,
    layers: n,
    cap: MAX_LAYERS,
    variant: v.name,
    content: top.content,
    alt: altFragmentFor(generation),
    strata: layers.map((l, i) => ({
      i,
      x: l.x,
      y: l.y,
      rot: l.rot,
      opacity: l.opacity,
      size: fontSizeFor(l.content),
      content: l.content,
    })),
  });

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${xmlAttr(altFragmentFor(generation))}">`,
  );
  out.push(`  <metadata>palimpsest ${xmlText(meta)}</metadata>`);
  out.push(`  <!--${CHRYSOPOEIA}  -->`);
  out.push(`  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${v.ground}"/>`);
  out.push(`  <g fill="none" stroke-width="1" shape-rendering="crispEdges">`);
  out.push(...ground(sha, v.line));
  out.push(`  </g>`);
  out.push(
    `  <path d="${ringPath(top)}" fill="none" stroke="${ICHOR}" stroke-width="${RING_STROKE}" stroke-linecap="butt" opacity="0.55"/>`,
  );
  /*
   * A demoted layer does not merely dim, it bleeds. Each ghost is drawn twice: an ichor bed
   * at the layer's own weight, and the line colour over it, fading out as the layer ages.
   * Compositing two palette colours keeps the file to three hex literals — an interpolated
   * RGB ramp would invent hues the palette does not contain.
   */
  for (let i = 0; i < ghosts.length; i++) {
    const g = ghosts[i]!;
    const depth = n - 1 - i;
    const t = clamp((depth - 1) / BLEED_OVER, 0, 1);
    out.push(textEl(g, ICHOR, g.opacity, "  ", g.opacity));
    if (t < 1) out.push(textEl(g, v.line, round(g.opacity * (1 - t)), "  ", g.opacity));
  }
  out.push(`  <g>`);
  out.push(SMIL);
  out.push(textEl(top, v.line, top.opacity, "    ", top.opacity));
  out.push(`  </g>`);
  out.push(`</svg>`);
  return out.join("\n") + "\n";
};

/* ─────────────────────────────────────────────────────────────────────────────
   Ledger — append-only, never edited
   ───────────────────────────────────────────────────────────────────────────── */

const readLedgerRows = (): string[] => {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\|\s*\d+\s*\|/.test(line));
};

const ledgerRow = (generation: number, sha: string, layers: number): string =>
  `| ${generation} | ${short(sha)} | ${layers} |`;

/** The generation recorded by the last data row, or null if the ledger has no rows yet. */
const lastLedgerGeneration = (): number | null => {
  const rows = readLedgerRows();
  if (rows.length === 0) return null;
  const m = /^\|\s*(\d+)\s*\|/.exec(rows[rows.length - 1]!);
  return m === null ? null : Number.parseInt(m[1]!, 10);
};

const appendLedger = (row: string): void => {
  const fresh = !existsSync(LEDGER_PATH) || readFileSync(LEDGER_PATH, "utf8").trim() === "";
  if (fresh) {
    writeFileSync(LEDGER_PATH, `${LEDGER_HEAD}\n${LEDGER_RULE}\n${row}\n`, "utf8");
    return;
  }
  const current = readFileSync(LEDGER_PATH, "utf8");
  appendFileSync(LEDGER_PATH, `${current.endsWith("\n") ? "" : "\n"}${row}\n`, "utf8");
};

/* ─────────────────────────────────────────────────────────────────────────────
   README — regenerate only the marked regions
   ───────────────────────────────────────────────────────────────────────────── */

const strataTable = (): string => {
  const rows = readLedgerRows();
  const last = rows.slice(Math.max(0, rows.length - STRATA_ROWS));
  return [LEDGER_HEAD, LEDGER_RULE, ...last].join("\n");
};

/**
 * The alt text is deliberately not the line the banner is showing. A screen reader
 * announces one fragment; a sighted visitor sees another. Both are true entries.
 */
const bannerBlock = (): string => {
  const svg = existsSync(BANNER_DARK) ? readFileSync(BANNER_DARK, "utf8") : "";
  const meta = parseMeta(svg);
  const alt = meta === null ? altFragmentFor(0) : altFragmentFor(meta.generation);
  return [
    `<div align="center">`,
    `  <picture>`,
    `    <source media="(prefers-color-scheme: light)" srcset="banner-light.svg">`,
    `    <img src="banner-dark.svg" alt="${xmlAttr(alt)}" width="100%">`,
    `  </picture>`,
    `</div>`,
  ].join("\n");
};

const replaceRegion = (doc: string, start: string, end: string, body: string): string | null => {
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  if (a === -1 || b === -1 || b < a) return null;
  return doc.slice(0, a + start.length) + "\n\n" + body + "\n\n" + doc.slice(b);
};

const regenerateReadme = (dryRun: boolean): number => {
  if (dryRun) {
    process.stdout.write(`${bannerBlock()}\n${strataTable()}\n`);
    process.stdout.write("readme=dry-run\n");
    return 0;
  }
  if (!existsSync(README_PATH)) {
    process.stdout.write("readme=skipped\n");
    return 0;
  }
  const current = readFileSync(README_PATH, "utf8");
  const withBanner = replaceRegion(current, BANNER_START, BANNER_END, bannerBlock());
  if (withBanner === null) {
    process.stderr.write(`error: ${BANNER_START} / ${BANNER_END} markers not found in README.md\n`);
    return 1;
  }
  const next = replaceRegion(withBanner, STRATA_START, STRATA_END, strataTable());
  if (next === null) {
    process.stderr.write(`error: ${STRATA_START} / ${STRATA_END} markers not found in README.md\n`);
    return 1;
  }
  if (next !== current) writeFileSync(README_PATH, next, "utf8");
  process.stdout.write(`readme=${next === current ? "unchanged" : "updated"}\n`);
  return 0;
};

/* ─────────────────────────────────────────────────────────────────────────────
   Inscribe
   ───────────────────────────────────────────────────────────────────────────── */

const readIfPresent = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, "utf8") : null;

const runInscribe = (sha: string, dryRun: boolean): number => {
  const priorLight = readIfPresent(BANNER_LIGHT);
  const priorDark = readIfPresent(BANNER_DARK);
  const priorMeta = priorLight === null ? null : parseMeta(priorLight);
  const priorLayers = priorLight === null ? [] : parseLayers(priorLight, priorMeta);

  let layers: Layer[];
  let generation: number;
  let replay = false;

  if (priorLayers.length === 0) {
    /* cold start: no ghosts, generation 0 (or the ledger's count, so it never resets) */
    generation = readLedgerRows().length;
    layers = [inscribe([], sha, generation)];
  } else if (priorMeta !== null && priorMeta.sha === sha) {
    /* this sha is already inscribed — re-emit as-is; the round trip makes it a no-op */
    replay = true;
    generation = priorMeta.generation;
    layers = priorLayers;
  } else {
    generation = priorMeta === null ? readLedgerRows().length : priorMeta.generation + 1;
    const ghosts = prune(demote(priorLayers, sha));
    layers = [...ghosts, inscribe(ghosts, sha, generation)];
  }

  const light = render(layers, LIGHT, generation, sha);
  const dark = render(layers, DARK, generation, sha);
  const changed = light !== priorLight || dark !== priorDark;

  const report = [
    `generation=${generation}`,
    `sha=${short(sha)}`,
    `layers=${layers.length}`,
    `content=${layers[layers.length - 1]!.content}`,
    replay ? "replay=true" : "replay=false",
  ];
  if (dryRun) report.push("dry-run=true");

  if (changed && !dryRun) {
    writeFileSync(BANNER_LIGHT, light, "utf8");
    writeFileSync(BANNER_DARK, dark, "utf8");
    /*
     * The ledger records inscriptions, not writes. A replay re-emits a generation that is
     * already inscribed; it can still change bytes on disk — a variant deleted or hand-edited
     * is repaired here — but it must not book a second row for the same generation. The same
     * guard, expressed as "the generation must be past the last one recorded", also catches
     * any other re-entry at an already-booked generation. The ledger is append-only, so a
     * duplicate row could never be taken back.
     */
    const booked = lastLedgerGeneration();
    if (!replay && (booked === null || generation > booked)) {
      appendLedger(ledgerRow(generation, sha, layers.length));
    }
  }

  report.push(`changed=${changed ? "true" : "false"}`);
  process.stdout.write(`${report.join("\n")}\n`);
  return 0;
};

/* ─────────────────────────────────────────────────────────────────────────────
   main
   ───────────────────────────────────────────────────────────────────────────── */

const main = (argv: string[]): number => {
  let dryRun = false;
  let readme = false;
  let seed: string | null = null;

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--readme") readme = true;
    else if (arg.startsWith("--seed=")) seed = arg.slice("--seed=".length).trim();
    else {
      process.stderr.write(`error: unknown flag ${arg}\n`);
      return 2;
    }
  }

  if (readme) return regenerateReadme(dryRun);
  return runInscribe(seed !== null && seed !== "" ? seed : headSha(), dryRun);
};

process.exitCode = main(process.argv.slice(2));

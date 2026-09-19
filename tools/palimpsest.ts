/**
 * palimpsest.ts — the inscription engine for `palimpsest-ouroboros`.
 *
 * Every run reads the banner it wrote last time, demotes each existing text layer
 * (fainter, nudged, tilted, pushed deeper in z-order), prunes what has faded past
 * legibility, and inscribes one new line on top. The result is a palimpsest: a
 * surface that is only ever overwritten, never cleared.
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
 *     --readme      regenerate only the README strata table from LEDGER.md (idempotent)
 *     --seed=<sha>  override the HEAD sha used for seeding (replay + tests)
 *     --dry-run     compute and report to stdout, write nothing to disk
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* ─────────────────────────────────────────────────────────────────────────────
   Paths and constants
   ───────────────────────────────────────────────────────────────────────────── */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BANNER_LIGHT = join(ROOT, "banner-light.svg");
const BANNER_DARK = join(ROOT, "banner-dark.svg");
const LEDGER_PATH = join(ROOT, "LEDGER.md");
const README_PATH = join(ROOT, "README.md");

/** The entire palette. Exactly three hex literals may appear in any emitted SVG. */
const INK = "#1c1917";
const ACCENT = "#8c6d46";
const PARCHMENT = "#e7e0d4";

const WIDTH = 1280;
const HEIGHT = 360;
const TITLE = "palimpsest-ouroboros";
const FONT_STACK = "Georgia, 'Times New Roman', Times, serif";
const FONT_SIZE = 76;

/** Every numeric attribute is rounded to this many decimals so output is byte-stable. */
const DECIMALS = 3;

/* rewrite rules */
const DEMOTE_FACTOR = 0.72;
const JITTER_XY = 3; /* +/- px */
const JITTER_ROT = 0.4; /* +/- degrees */
const PRUNE_BELOW = 0.015;
const MAX_LAYERS = 24;
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

const NULL_SHA = "0000000000000000000000000000000000000000";

/* ledger + readme */
const LEDGER_HEAD = "| generation | sha | layers |";
const LEDGER_RULE = "| ---: | --- | ---: |";
const STRATA_ROWS = 12;
const STRATA_START = "<!-- strata:start -->";
const STRATA_END = "<!-- strata:end -->";

/* ─────────────────────────────────────────────────────────────────────────────
   Types
   ───────────────────────────────────────────────────────────────────────────── */

interface Layer {
  x: number;
  y: number;
  rot: number;
  opacity: number;
}

interface Variant {
  name: "light" | "dark";
  fg: string;
  bg: string;
}

interface BannerMeta {
  generation: number;
  sha: string;
  layers: number;
  variant: string;
}

/** Light and dark differ in exactly two colour tokens. Accent is identical in both. */
const LIGHT = { name: "light", fg: INK, bg: PARCHMENT } satisfies Variant;
const DARK = { name: "dark", fg: PARCHMENT, bg: INK } satisfies Variant;

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
   Parse — written against this file's own canonical emitted form
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

/**
 * Every <text> in document order: faintest/oldest first, newest last.
 * The last element is therefore the previous top layer.
 */
const parseLayers = (svg: string): Layer[] => {
  const layers: Layer[] = [];
  const re = /<text\b([^>]*)>/g;
  let m: RegExpExecArray | null = re.exec(svg);
  while (m !== null) {
    const attrs = m[1]!;
    const rot = /rotate\(\s*(-?[0-9.]+)/.exec(attr(attrs, "transform") ?? "");
    const rotNum = rot === null ? Number.NaN : round(Number.parseFloat(rot[1]!));
    /* The parser is total: every field comes back finite and inside its documented range.
       demote() and inscribe() clamp, but a replay re-emits parsed layers untouched, so a
       hand-edited, half-written or merge-mangled banner would otherwise propagate NaN,
       off-canvas coordinates or an out-of-range opacity into both variants forever. On
       well-formed output of this generator every clamp here is a no-op. */
    layers.push({
      x: clamp(attrNum(attrs, "x", COLD_X), X_MIN, X_MAX),
      y: clamp(attrNum(attrs, "y", COLD_Y), Y_MIN, Y_MAX),
      rot: Number.isFinite(rotNum) ? clamp(rotNum, ROT_MIN, ROT_MAX) : 0,
      opacity: clamp(attrNum(attrs, "opacity", 1), 0, 1),
    });
    m = re.exec(svg);
  }
  return layers;
};

const parseMeta = (svg: string): BannerMeta | null => {
  const block = /<metadata>([\s\S]*?)<\/metadata>/.exec(svg);
  if (block === null) return null;
  const json = /\{[\s\S]*\}/.exec(block[1]!);
  if (json === null) return null;
  try {
    const o = JSON.parse(json[0]) as Partial<BannerMeta>;
    if (typeof o.generation !== "number" || !Number.isFinite(o.generation)) return null;
    return {
      generation: o.generation,
      sha: typeof o.sha === "string" ? o.sha : "",
      layers: typeof o.layers === "number" ? o.layers : 0,
      variant: typeof o.variant === "string" ? o.variant : "light",
    };
  } catch {
    return null;
  }
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
const inscribe = (ghosts: Layer[], sha: string): Layer => {
  const prev = ghosts.length > 0 ? ghosts[ghosts.length - 1]! : null;
  if (prev === null) return { x: COLD_X, y: COLD_Y, rot: 0, opacity: 1 };
  return {
    x: round(clamp(prev.x + jitter(sha, "inscribe-x", 0, INSCRIBE_DX), X_MIN, X_MAX)),
    y: round(clamp(prev.y + jitter(sha, "inscribe-y", 0, INSCRIBE_DY), Y_MIN, Y_MAX)),
    rot: 0,
    opacity: 1,
  };
};

/* ─────────────────────────────────────────────────────────────────────────────
   Emit — one pass over the layer list produces both variants
   ───────────────────────────────────────────────────────────────────────────── */

const textEl = (l: Layer, fg: string, indent: string): string =>
  `${indent}<text x="${fmt(l.x)}" y="${fmt(l.y)}" transform="rotate(${fmt(l.rot)}, ${fmt(l.x)}, ${fmt(l.y)})"` +
  ` opacity="${fmt(l.opacity)}" font-family="${FONT_STACK}" font-size="${FONT_SIZE}" font-weight="600"` +
  ` letter-spacing="2" text-anchor="middle" fill="${fg}">${TITLE}</text>`;

/**
 * The ink bleed: +/-1.5px horizontally over 11s, ease-in-out via keySplines, forever.
 * It lives on the wrapping <g> so it composes with the rotate() on the inner <text>
 * instead of fighting it. This is the only animated element in the file — SMIL is the
 * only dynamic surface available, since the SVG is loaded through <img>.
 */
const SMIL = [
  `    <animateTransform attributeName="transform" type="translate"`,
  `      values="-1.5 0;1.5 0;-1.5 0" keyTimes="0;0.5;1"`,
  `      calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"`,
  `      dur="11s" repeatCount="indefinite"/>`,
].join("\n");

const render = (layers: Layer[], v: Variant, generation: number, sha: string): string => {
  const ghosts = layers.slice(0, -1);
  const top = layers[layers.length - 1]!;
  const meta = JSON.stringify({
    /* The FULL sha, not the short one: replay detection compares this against HEAD, and
       two commits sharing a 7-hex prefix would otherwise be mistaken for the same one and
       silently skip a generation. LEDGER.md still records the short sha, for reading. */
    generation,
    sha,
    layers: layers.length,
    variant: v.name,
  });

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${TITLE}">`,
  );
  out.push(`  <metadata>palimpsest ${meta}</metadata>`);
  out.push(`  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${v.bg}"/>`);
  out.push(
    `  <circle cx="640" cy="180" r="128" fill="none" stroke="${ACCENT}" stroke-width="1" opacity="0.18"/>`,
  );
  for (const g of ghosts) out.push(textEl(g, v.fg, "  "));
  out.push(`  <g>`);
  out.push(SMIL);
  out.push(textEl(top, v.fg, "    "));
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
   README — regenerate only the region between the strata markers
   ───────────────────────────────────────────────────────────────────────────── */

const strataTable = (): string => {
  const rows = readLedgerRows();
  const last = rows.slice(Math.max(0, rows.length - STRATA_ROWS));
  return [LEDGER_HEAD, LEDGER_RULE, ...last].join("\n");
};

const regenerateReadme = (dryRun: boolean): number => {
  const table = strataTable();
  if (dryRun) {
    process.stdout.write(`${table}\n`);
    process.stdout.write("readme=dry-run\n");
    return 0;
  }
  if (!existsSync(README_PATH)) {
    process.stdout.write("readme=skipped\n");
    return 0;
  }
  const current = readFileSync(README_PATH, "utf8");
  const a = current.indexOf(STRATA_START);
  const b = current.indexOf(STRATA_END);
  if (a === -1 || b === -1 || b < a) {
    process.stderr.write(`error: ${STRATA_START} / ${STRATA_END} markers not found in README.md\n`);
    return 1;
  }
  const next = current.slice(0, a + STRATA_START.length) + "\n\n" + table + "\n\n" + current.slice(b);
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
  const priorLayers = priorLight === null ? [] : parseLayers(priorLight);

  let layers: Layer[];
  let generation: number;
  let replay = false;

  if (priorLayers.length === 0) {
    /* cold start: no ghosts, generation 0 (or the ledger's count, so it never resets) */
    generation = readLedgerRows().length;
    layers = [inscribe([], sha)];
  } else if (priorMeta !== null && priorMeta.sha === sha) {
    /* this sha is already inscribed — re-emit as-is; the round trip makes it a no-op */
    replay = true;
    generation = priorMeta.generation;
    layers = priorLayers;
  } else {
    generation = priorMeta === null ? readLedgerRows().length : priorMeta.generation + 1;
    const ghosts = prune(demote(priorLayers, sha));
    layers = [...ghosts, inscribe(ghosts, sha)];
  }

  const light = render(layers, LIGHT, generation, sha);
  const dark = render(layers, DARK, generation, sha);
  const changed = light !== priorLight || dark !== priorDark;

  const report = [
    `generation=${generation}`,
    `sha=${short(sha)}`,
    `layers=${layers.length}`,
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

/**
 * attest.ts — the ledger reduced to one number.
 *
 * LEDGER.md is append-only. Every row is one inscription: the generation, the short sha
 * of the commit the surface was seeded from, and how many strata were standing when it
 * was written. Nothing in the artifact is random; every mark on both plates is a pure
 * function of that sha chain. So the chain is the work's identity, and this file states
 * it as a single digest anyone can recompute.
 *
 *   node --experimental-strip-types tools/attest.ts [flags]
 *
 *     (none)      print the digest and the row count
 *     --verbose   also print the canonical pre-image, line by line
 *     --verify    additionally resolve every recorded sha against this repository's
 *                 history and check the rows are in ancestor order; exit 1 if not
 *     --notice    rewrite the marked region in NOTICE with the current digest
 *     --check     exit 1 if NOTICE's published digest is not the current one
 *
 * ── the canonical form ────────────────────────────────────────────────────────
 *
 * Every data row of LEDGER.md, in file order, is reduced to
 *
 *     <generation>\t<sha>\t<layers>\n
 *
 * with surrounding whitespace stripped from each cell and an absent cell written as the
 * empty string. The ∅ row — the state before the first inscription — is included, with
 * "∅" as its generation, because it is a row of the ledger and leaving it out would make
 * the digest depend on a judgement rather than on the file. The trailing fourth column
 * is the countdown to the cap; it is derived from `layers` and is NOT part of the
 * pre-image. The pre-image is then hashed with SHA-256 and printed as lowercase hex.
 *
 * The digest is computed from LEDGER.md and nothing else, on purpose: a third party with
 * only the published files can recompute it and get the same answer, without a clone and
 * without trusting this program. `--verify` is the separate, stronger check that wants a
 * repository.
 *
 * ── what the digest does and does not prove ───────────────────────────────────
 *
 * It proves that two ledgers are the same ledger. That is all a hash can do.
 *
 * What makes it worth publishing is the property underneath it. The banner and the
 * plate are deterministic from the sha chain: change one commit anywhere and every
 * subsequent generation renders differently — different noise, different placement,
 * different decay, a different watermark. So:
 *
 *   • A fork that does not preserve the exact sha chain cannot produce these files.
 *     Its own artifact will be visibly and provably a different artifact, and its
 *     ledger will digest to something else.
 *
 *   • A fork that DOES produce these files has preserved the sha chain, which means it
 *     has copied this repository's history. The copy is the proof of the copy.
 *
 * Neither of those is enforcement. A copier is free to do either. The point is that
 * whichever they do, the question "is this the same work?" has an answer that does not
 * depend on anybody's word.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LEDGER_PATH = join(ROOT, "LEDGER.md");
const NOTICE_PATH = join(ROOT, "NOTICE");

const DIGEST_START = "<!-- attestation:start -->";
const DIGEST_END = "<!-- attestation:end -->";

export interface Row {
  generation: string;
  sha: string;
  layers: string;
}

/** Split a markdown table row into its cells, dropping the leading and trailing pipes. */
const cells = (line: string): string[] => {
  const t = line.trim();
  const inner = t.slice(1, t.endsWith("|") ? -1 : undefined);
  return inner.split("|").map((c) => c.trim());
};

/** Is this a header or a rule, rather than data? */
const isFurniture = (c: string[]): boolean =>
  c[0] === "generation" || /^:?-{3,}:?$/.test(c[0] ?? "");

export const readRows = (text: string): Row[] => {
  const out: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const c = cells(line);
    if (c.length < 3 || isFurniture(c)) continue;
    out.push({ generation: c[0] ?? "", sha: c[1] ?? "", layers: c[2] ?? "" });
  }
  return out;
};

/**
 * The shape of the canonical pre-image, named and versioned. The digest means nothing
 * without it: two people who agree on the rows and disagree on the separator get two
 * different answers and no way to tell which is wrong. Changing the shape means changing
 * this tag too, so that a published digest always says which form produced it.
 */
export const PREIMAGE_FORM = "ledger/generation-sha-layers/tab/v1";

export const preimage = (rows: Row[]): string =>
  rows.map((r) => `${r.generation}\t${r.sha}\t${r.layers}\n`).join("");

export const digestOf = (rows: Row[]): string =>
  createHash("sha256").update(preimage(rows), "utf8").digest("hex");

/* ─────────────────────────────────────────────────────────────────────────────
   Git — only for --verify
   ───────────────────────────────────────────────────────────────────────────── */

const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

interface Checked {
  row: Row;
  full: string | null;
  problem: string | null;
}

/**
 * Resolve each recorded sha in this repository and check that the rows are in ancestor
 * order — row n's commit must be an ancestor of row n+1's. A row with no sha (the cap
 * has been reached, so the ledger stops naming one) is skipped, not failed.
 */
const verifyAgainstGit = (rows: Row[]): Checked[] => {
  const out: Checked[] = [];
  let previous: string | null = null;
  for (const row of rows) {
    if (row.sha === "" || /^0+$/.test(row.sha)) {
      out.push({ row, full: null, problem: null });
      continue;
    }
    let full: string | null = null;
    let problem: string | null = null;
    try {
      full = git(["rev-parse", "--verify", `${row.sha}^{commit}`]);
    } catch {
      problem = "not a commit in this repository";
    }
    if (full !== null && previous !== null) {
      try {
        git(["merge-base", "--is-ancestor", previous, full]);
      } catch {
        problem = `not a descendant of the previous recorded commit (${previous.slice(0, 7)})`;
      }
    }
    if (full !== null) previous = full;
    out.push({ row, full, problem });
  }
  return out;
};

/* ─────────────────────────────────────────────────────────────────────────────
   NOTICE
   ───────────────────────────────────────────────────────────────────────────── */

const noticeBlock = (digest: string, rows: number): string =>
  [
    "```",
    `sha256  ${digest}`,
    `rows    ${rows}`,
    "```",
    "",
    "Recompute it with `node --experimental-strip-types tools/attest.ts`.",
  ].join("\n");

const publishedDigest = (notice: string): string | null => {
  const a = notice.indexOf(DIGEST_START);
  const b = notice.indexOf(DIGEST_END);
  if (a === -1 || b === -1 || b < a) return null;
  const m = /sha256\s+([0-9a-f]{64})/.exec(notice.slice(a, b));
  return m === null ? null : m[1]!;
};

const writeNotice = (digest: string, rows: number): number => {
  if (!existsSync(NOTICE_PATH)) {
    process.stderr.write("error: NOTICE not found\n");
    return 1;
  }
  const current = readFileSync(NOTICE_PATH, "utf8");
  const a = current.indexOf(DIGEST_START);
  const b = current.indexOf(DIGEST_END);
  if (a === -1 || b === -1 || b < a) {
    process.stderr.write(`error: ${DIGEST_START} / ${DIGEST_END} markers not found in NOTICE\n`);
    return 1;
  }
  const next =
    current.slice(0, a + DIGEST_START.length) + "\n\n" + noticeBlock(digest, rows) + "\n\n" + current.slice(b);
  if (next !== current) writeFileSync(NOTICE_PATH, next, "utf8");
  process.stdout.write(`notice=${next === current ? "unchanged" : "updated"}\n`);
  return 0;
};

/* ─────────────────────────────────────────────────────────────────────────────
   main
   ───────────────────────────────────────────────────────────────────────────── */

const main = (argv: string[]): number => {
  let verbose = false;
  let verify = false;
  let notice = false;
  let check = false;
  for (const a of argv) {
    if (a === "--verbose") verbose = true;
    else if (a === "--verify") verify = true;
    else if (a === "--notice") notice = true;
    else if (a === "--check") check = true;
    else {
      process.stderr.write(`error: unknown flag ${a}\n`);
      return 2;
    }
  }

  if (!existsSync(LEDGER_PATH)) {
    process.stderr.write("error: LEDGER.md not found\n");
    return 1;
  }
  const rows = readRows(readFileSync(LEDGER_PATH, "utf8"));
  const digest = digestOf(rows);

  process.stdout.write(`form=${PREIMAGE_FORM}\nrows=${rows.length}\ndigest=${digest}\n`);
  if (verbose) {
    process.stdout.write("preimage:\n");
    for (const r of rows) process.stdout.write(`  ${JSON.stringify(`${r.generation}\t${r.sha}\t${r.layers}`)}\n`);
  }

  let status = 0;

  if (verify) {
    const checked = verifyAgainstGit(rows);
    let bad = 0;
    for (const c of checked) {
      const name = `${c.row.generation}/${c.row.sha === "" ? "—" : c.row.sha}`;
      if (c.problem !== null) {
        process.stdout.write(`  ${name}: ${c.problem}\n`);
        bad++;
      } else if (verbose) {
        process.stdout.write(`  ${name}: ${c.full ?? "(no sha recorded)"}\n`);
      }
    }
    process.stdout.write(`verify=${bad === 0 ? "ok" : "failed"}\nunresolved=${bad}\n`);
    if (bad > 0) status = 1;
  }

  if (notice) {
    const rc = writeNotice(digest, rows.length);
    if (rc !== 0) status = rc;
  }

  if (check) {
    const published = existsSync(NOTICE_PATH) ? publishedDigest(readFileSync(NOTICE_PATH, "utf8")) : null;
    const same = published === digest;
    process.stdout.write(`published=${published ?? "none"}\ncheck=${same ? "ok" : "stale"}\n`);
    if (!same) status = 1;
  }

  const out = process.env.GITHUB_OUTPUT;
  if (out !== undefined && out !== "") appendFileSync(out, `digest=${digest}\nrows=${rows.length}\n`, "utf8");

  return status;
};

process.exitCode = main(process.argv.slice(2));

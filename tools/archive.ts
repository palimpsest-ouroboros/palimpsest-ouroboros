/**
 * archive.ts — Software Heritage: ask, submit, and record.
 *
 *   node --experimental-strip-types tools/archive.ts [flags]
 *
 *     (none)        report what the archive currently holds for this origin
 *     --submit      ASK THE ARCHIVE TO TAKE IT. This is the irreversible step.
 *     --notice      write the recovered SWHID and visit date into NOTICE
 *     --origin=URL  use this origin instead of the `origin` remote
 *     --json        machine-readable output
 *
 * Read-only without `--submit`. Nothing here posts anything unless that flag is
 * given, and the flag is separate precisely so that running the file to look at
 * something cannot archive it by accident.
 *
 * ── read this before using --submit ───────────────────────────────────────────
 *
 * Software Heritage is a permanent public archive and archival is, in practice, a
 * one-way door. From their own documentation and terms, checked before this file was
 * written:
 *
 *   • It archives regardless of licence, without preliminary checks.
 *   • It keeps what it has taken after the upstream repository is deleted.
 *   • There is no self-service opt-out. Removal takes a formal, identity-bearing
 *     takedown request under French law.
 *   • They name removal requests motivated by a change of licence as an abuse of
 *     that process. This repository has just changed its licence, which is a reason
 *     to be sure before submitting rather than a reason not to.
 *   • Every commit author name, email address and timestamp in the history becomes
 *     permanent public record. This repository's history carries only GitHub noreply
 *     addresses, which is why that is a footnote here and might not be in another.
 *
 * None of that is an argument against archiving. Permanence is the entire point, and
 * an archive that would quietly drop a work on request would be no use as proof of
 * priority. It is written down so the button is pressed knowingly.
 *
 * ── sequence ──────────────────────────────────────────────────────────────────
 *
 * Push first, then submit. The archive takes a snapshot of what it can clone at the
 * moment it visits; submitting before the licence change is pushed would record the
 * old state and the SWHID in NOTICE would name a version whose LICENSE says
 * something else. Submit, wait for `succeeded`, then `--notice`.
 *
 * ── which SWHID goes in NOTICE ────────────────────────────────────────────────
 *
 * The snapshot one, `swh:1:snp:…`, qualified with the origin. A snapshot is the whole
 * set of refs as they stood at one visit; a revision SWHID pins one commit and would
 * miss the other branches and `refs/notes/maat`. The date is not inside the
 * identifier — it lives in the visit record — so the two are always published
 * together.
 *
 * Core SWHIDs can also be computed offline from the git objects, and `--json` prints
 * the revision one for HEAD. That is a verifiable name for a commit and nothing more:
 * it carries no date, no provenance, and no evidence that anyone but you ever saw it.
 * It is not a substitute for the archive's own identifier.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOTICE_PATH = join(ROOT, "NOTICE");

const SWHID_START = "<!-- swhid:start -->";
const SWHID_END = "<!-- swhid:end -->";

const API = "https://archive.softwareheritage.org/api/1";

const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** The origin url Software Heritage would be asked to visit: the `origin` remote, https, no .git. */
const originUrl = (): string => {
  let url = git(["remote", "get-url", "origin"]);
  url = url.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
  return url;
};

interface Answer {
  status: number;
  body: unknown;
}

const call = async (url: string, method: "GET" | "POST"): Promise<Answer> => {
  const res = await fetch(url, { method, headers: { Accept: "application/json" } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

const field = (o: unknown, name: string): string | null => {
  if (o === null || typeof o !== "object") return null;
  const v = (o as Record<string, unknown>)[name];
  return typeof v === "string" ? v : null;
};

/** The archive returns either one save record or a list of them, newest last. */
const newestSave = (body: unknown): Record<string, unknown> | null => {
  if (Array.isArray(body)) return body.length === 0 ? null : (body[body.length - 1] as Record<string, unknown>);
  if (body !== null && typeof body === "object") return body as Record<string, unknown>;
  return null;
};

const saveUrl = (origin: string): string => `${API}/origin/save/git/url/${origin}/`;

const writeNotice = (swhid: string, visited: string, origin: string): number => {
  if (!existsSync(NOTICE_PATH)) {
    process.stderr.write("error: NOTICE not found\n");
    return 1;
  }
  const current = readFileSync(NOTICE_PATH, "utf8");
  const a = current.indexOf(SWHID_START);
  const b = current.indexOf(SWHID_END);
  if (a === -1 || b === -1 || b < a) {
    process.stderr.write(`error: ${SWHID_START} / ${SWHID_END} markers not found in NOTICE\n`);
    return 1;
  }
  const block = [
    "Archived by Software Heritage. The snapshot identifier and the date it was taken,",
    "which belong together because the identifier does not carry the date:",
    "",
    "```",
    `${swhid};origin=${origin}`,
    "```",
    "",
    `Visited ${visited}. Resolve it at https://archive.softwareheritage.org/${swhid}`,
    "",
    "Recheck it with `node --experimental-strip-types tools/archive.ts`.",
  ].join("\n");
  const next = current.slice(0, a + SWHID_START.length) + "\n\n" + block + "\n\n" + current.slice(b);
  if (next !== current) writeFileSync(NOTICE_PATH, next, "utf8");
  process.stdout.write(`notice=${next === current ? "unchanged" : "updated"}\n`);
  return 0;
};

const main = async (argv: string[]): Promise<number> => {
  let submit = false;
  let notice = false;
  let json = false;
  let origin: string | null = null;

  for (const a of argv) {
    if (a === "--submit") submit = true;
    else if (a === "--notice") notice = true;
    else if (a === "--json") json = true;
    else if (a.startsWith("--origin=")) origin = a.slice("--origin=".length).trim();
    else {
      process.stderr.write(`error: unknown flag ${a}\n`);
      return 2;
    }
  }

  const url = origin ?? originUrl();
  process.stdout.write(`origin=${url}\n`);

  if (submit) {
    process.stdout.write("submitting — this is the irreversible step\n");
    const posted = await call(saveUrl(url), "POST");
    process.stdout.write(`post=${posted.status}\n`);
    if (posted.status >= 400) {
      process.stdout.write(`${JSON.stringify(posted.body, null, 2)}\n`);
      return 1;
    }
  }

  const got = await call(saveUrl(url), "GET");
  if (got.status === 404) {
    process.stdout.write("archived=no\nnote=this origin is not known to the archive; --submit asks it to take it\n");
    return notice ? 1 : 0;
  }
  const save = newestSave(got.body);
  if (save === null) {
    process.stdout.write("archived=no\nnote=the archive returned no save record\n");
    return notice ? 1 : 0;
  }

  const request = field(save, "save_request_status");
  const task = field(save, "save_task_status");
  const swhid = field(save, "snapshot_swhid");
  const visited = field(save, "visit_date") ?? field(save, "save_request_date") ?? "";

  process.stdout.write(
    [
      `request=${request ?? "unknown"}`,
      `task=${task ?? "unknown"}`,
      `swhid=${swhid ?? "none yet"}`,
      `visited=${visited === "" ? "none yet" : visited}`,
      "",
    ].join("\n"),
  );

  if (json) {
    let head: string | null = null;
    try {
      head = `swh:1:rev:${git(["rev-parse", "HEAD"])}`;
    } catch {
      head = null;
    }
    process.stdout.write(`${JSON.stringify({ origin: url, save, localHeadSwhid: head }, null, 2)}\n`);
  }

  if (notice) {
    if (swhid === null || swhid === "") {
      process.stderr.write("error: no snapshot SWHID yet — the visit has not completed; nothing written\n");
      return 1;
    }
    return writeNotice(swhid, visited, url);
  }

  return 0;
};

process.exitCode = await main(process.argv.slice(2));

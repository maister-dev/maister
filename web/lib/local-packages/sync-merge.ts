import "server-only";

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { gitMergeFile } from "./git";

import { MaisterError } from "@/lib/errors";

// ADR-132 §d (T19): synthetic 3-way merge over exported TREES — no shared git
// history exists between a fork and its source installs, so the merge is
// byte-level per file: base = the fork's original source install, theirs =
// the sync-target install, ours = the fork working dir (mutated IN PLACE).
// Pure lib: no DB, no network; `git merge-file` only for textual merges.
//
// Case table (the contract — one test per row in sync-merge.test.ts):
//   unchanged ours + changed theirs      → take theirs            (clean)
//   changed ours + unchanged theirs      → keep ours              (no-op)
//   both changed same                    → keep                   (no-op)
//   both changed different               → git merge-file         (clean|conflict)
//   added in theirs only                 → add                    (clean)
//   added in ours only                   → keep                   (no-op)
//   added both identical                 → keep                   (no-op)
//   added both different                 → merge-file, empty base (conflict)
//   deleted in theirs + ours unchanged   → delete                 (clean)
//   deleted in theirs + ours changed     → keep ours              (conflict)
//   deleted in ours + theirs changed     → do NOT resurrect       (conflict)
//   deleted in ours + theirs unchanged   → stays deleted          (no-op)
//   deleted in both                      → converged              (no-op)
//   binary (NUL-sniff) differing         → ours kept              (conflict)
//
// `cleanFiles` = paths the merge WROTE or DELETED in ours; no-op rows are not
// listed — re-running on an already-merged clean tree returns empty
// (idempotent, the crash-window Resume guarantee).

// Never part of package content — the fork's git dir + runtime materializations.
const MERGE_EXCLUDES = [".git/", ".maister/", ".claude/"] as const;
// git's binary heuristic: a NUL byte within the first 8000 bytes.
const BINARY_SNIFF_BYTES = 8000;

export type MergeTreesResult = {
  cleanFiles: string[];
  conflictedFiles: string[];
};

async function walkFiles(
  root: string,
  rel = "",
  out: string[] = [],
): Promise<string[]> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });

  for (const entry of entries) {
    const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;

    if (MERGE_EXCLUDES.some((prefix) => entryRel.startsWith(prefix))) continue;
    if (entry.isDirectory()) await walkFiles(root, entryRel, out);
    else if (entry.isFile()) out.push(entryRel);
  }

  return out;
}

// Uint8Array end-to-end: the dual @types/node peer-dep variants disagree on
// Buffer's ArrayBufferLike parameter, so Buffer never crosses fn boundaries.
async function readIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

function isBinary(buf: Uint8Array | null): boolean {
  if (buf === null) return false;

  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function eq(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;

  return true;
}

async function assertDir(dir: string, label: string): Promise<void> {
  try {
    const st = await stat(dir);

    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `${label} directory unavailable at ${dir}: ${(err as Error).message}`,
    );
  }
}

export async function mergeTrees(opts: {
  baseDir: string;
  theirsDir: string;
  oursDir: string;
  // Names the theirs side in conflict markers (e.g. "upstream v1.2.0").
  markerLabel: string;
}): Promise<MergeTreesResult> {
  const { baseDir, theirsDir, oursDir, markerLabel } = opts;

  await assertDir(baseDir, "base");
  await assertDir(theirsDir, "theirs");
  await assertDir(oursDir, "ours");

  const union = new Set<string>([
    ...(await walkFiles(baseDir)),
    ...(await walkFiles(theirsDir)),
    ...(await walkFiles(oursDir)),
  ]);

  const cleanFiles: string[] = [];
  const conflictedFiles: string[] = [];
  // One empty file serves every add/add merge as the synthetic base.
  let emptyBaseDir: string | null = null;

  try {
    for (const rel of [...union].sort()) {
      const base = await readIfExists(join(baseDir, rel));
      const theirs = await readIfExists(join(theirsDir, rel));
      const ours = await readIfExists(join(oursDir, rel));

      if (ours === null && theirs === null) continue; // deleted in both / base-only

      if (theirs === null) {
        if (base === null) continue; // added in ours only → keep
        if (eq(ours, base)) {
          await rm(join(oursDir, rel), { force: true }); // deleted in theirs, ours unchanged
          cleanFiles.push(rel);
        } else {
          conflictedFiles.push(rel); // modify/delete — keep ours
        }
        continue;
      }

      if (ours === null) {
        if (base === null) {
          await mkdir(dirname(join(oursDir, rel)), { recursive: true });
          await writeFile(join(oursDir, rel), theirs); // added in theirs only
          cleanFiles.push(rel);
        } else if (!eq(theirs, base)) {
          conflictedFiles.push(rel); // delete/modify — do NOT resurrect
        }
        // theirs unchanged → the fork's deletion wins (no-op)
        continue;
      }

      // Both sides present.
      if (eq(ours, theirs)) continue; // converged (both changed same / added identical)
      if (base !== null && eq(ours, base)) {
        await writeFile(join(oursDir, rel), theirs); // take theirs
        cleanFiles.push(rel);
        continue;
      }
      if (base !== null && eq(theirs, base)) continue; // keep ours

      // Both changed differently (or add/add different).
      if (isBinary(base) || isBinary(ours) || isBinary(theirs)) {
        conflictedFiles.push(rel); // binary — ours kept byte-identical
        continue;
      }

      let basePath = join(baseDir, rel);

      if (base === null) {
        emptyBaseDir ??= await mkdtemp(join(tmpdir(), "sync-merge-base-"));
        basePath = join(emptyBaseDir, "empty");
        await writeFile(basePath, "");
      }
      const conflicts = await gitMergeFile(
        join(oursDir, rel),
        basePath,
        join(theirsDir, rel),
        { markerLabel },
      );

      if (conflicts === 0) cleanFiles.push(rel);
      else conflictedFiles.push(rel);
    }
  } finally {
    if (emptyBaseDir !== null) {
      await rm(emptyBaseDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  return { cleanFiles, conflictedFiles };
}

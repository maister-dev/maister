import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DiffPrepResult } from "@/lib/diff/prepare";

import { stat } from "node:fs/promises";

import { eq } from "drizzle-orm";
import pino from "pino";

import { gitDiffNoIndex } from "./git";
import { getLocalPackage } from "./service";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { prepareDiff, prepareDiffSummary } from "@/lib/diff/prepare";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "local-packages/divergence",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = NodePgDatabase<typeof schema>;

function resolveDb(db?: Db): Db {
  return db ?? (getDb() as unknown as Db);
}

const pi = schema.packageInstalls;

// Never part of a package's content: the fork's git dir + runtime materializations.
const DIVERGENCE_EXCLUDES = [".git/", ".maister/", ".claude/"] as const;

export type UpstreamDivergence = DiffPrepResult & {
  changedCount: number;
  // The lineage source install the comparison ran against.
  base: { installId: string; versionLabel: string };
  compared:
    | { kind: "working_dir" }
    | { kind: "cut"; installId: string; versionLabel: string };
};

// Install row + on-disk bundle guard (mirrors fork.ts loadInstallSource):
// a missing row, a `set null`-orphaned path, or GC'd bytes all degrade to a
// typed CONFIG the UI can render — never a raw fs error.
async function loadInstallDir(
  d: Db,
  installId: string,
  context: string,
): Promise<{ installedPath: string; versionLabel: string; row: Record<string, unknown> }> {
  const rows = await d.select().from(pi).where(eq(pi.id, installId));
  const install = rows[0] as
    | { installedPath?: string; versionLabel?: string }
    | undefined;

  if (!install || !install.installedPath) {
    throw new MaisterError("CONFIG", `${context} unavailable: ${installId}`);
  }
  try {
    const st = await stat(install.installedPath);

    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `${context} bundle missing on disk for ${installId}: ${(err as Error).message}`,
    );
  }

  return {
    installedPath: install.installedPath,
    versionLabel: install.versionLabel ?? "",
    row: install as Record<string, unknown>,
  };
}

// Rewrite `git diff --no-index` header lines from absolute-dir prefixes to
// package-relative `a/<rel>` / `b/<rel>`. git emits `a<absDir>/rel` (the
// leading `/` of the dir merges with the prefix); ADDED files carry the
// SAME (right) dir under both prefixes, so all four combos are rewritten.
// Only header-shaped lines are touched — content lines stay byte-exact.
function relativizeNoIndexDiff(
  text: string,
  oursDir: string,
  theirsDir: string,
): string {
  const replace = (line: string): string =>
    line
      .replaceAll(`a${oursDir}/`, "a/")
      .replaceAll(`b${oursDir}/`, "b/")
      .replaceAll(`a${theirsDir}/`, "a/")
      .replaceAll(`b${theirsDir}/`, "b/");

  return text
    .split("\n")
    .map((line) =>
      line.startsWith("diff --git ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("copy from ") ||
      line.startsWith("copy to ") ||
      line.startsWith("Binary files ")
        ? replace(line)
        : line,
    )
    .join("\n");
}

// Split a unified diff into per-file blocks and keep only blocks whose
// (relativized) path passes the filter. Preamble before the first
// `diff --git` (none in practice) is dropped with the excluded blocks.
function filterDiffBlocks(
  text: string,
  keep: (headerLine: string) => boolean,
): { text: string; blockCount: number } {
  const lines = text.split("\n");
  const out: string[] = [];
  let keeping = false;
  let blockCount = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      keeping = keep(line);
      if (keeping) blockCount += 1;
    }
    if (keeping) out.push(line);
  }

  return { text: out.join("\n"), blockCount };
}

function blockPathAllowed(
  headerLine: string,
  elementPrefix: string | undefined,
): boolean {
  // `diff --git a/<pathA> b/<pathB>` — check both sides (adds/deletes).
  const paths = [...headerLine.matchAll(/ [ab]\/([^\s]+)/g)].map((m) => m[1]!);

  if (paths.length === 0) return false;
  if (
    paths.some((p) =>
      DIVERGENCE_EXCLUDES.some((prefix) => p.startsWith(prefix)),
    )
  ) {
    return false;
  }
  if (elementPrefix !== undefined) {
    const prefix = elementPrefix.endsWith("/")
      ? elementPrefix
      : `${elementPrefix}/`;

    return paths.some((p) => p === elementPrefix || p.startsWith(prefix));
  }

  return true;
}

// ADR-129 (T17): fork-vs-source divergence — ours = the fork's working dir
// (default) or one of ITS OWN cuts (`cutInstallId` is lineage-validated,
// never used as a raw path); theirs = the lineage source install's bundle.
// Purely local bytes (D3 — no network); a GC'd or unlinked source degrades
// to typed CONFIG. `element` narrows to one package-relative subtree.
export async function computeUpstreamDivergence(opts: {
  localPackageId: string;
  cutInstallId?: string;
  element?: string;
  db?: Db;
}): Promise<UpstreamDivergence> {
  const d = resolveDb(opts.db);
  const pkg = await getLocalPackage(opts.localPackageId, d);

  if (!pkg || pkg.status !== "active") {
    throw new MaisterError("PRECONDITION", "local package not found");
  }
  if (!pkg.sourceInstallId) {
    throw new MaisterError(
      "CONFIG",
      "source install unavailable: this package has no upstream lineage",
    );
  }

  const source = await loadInstallDir(d, pkg.sourceInstallId, "source install");

  let oursDir = pkg.workingDir;
  let compared: UpstreamDivergence["compared"] = { kind: "working_dir" };

  if (opts.cutInstallId !== undefined) {
    const cut = await loadInstallDir(d, opts.cutInstallId, "cut install");

    if (cut.row.sourceLocalPackageId !== pkg.id) {
      throw new MaisterError(
        "CONFLICT",
        `install ${opts.cutInstallId} is not a cut of this package`,
      );
    }
    oursDir = cut.installedPath;
    compared = {
      kind: "cut",
      installId: opts.cutInstallId,
      versionLabel: cut.versionLabel,
    };
  }

  // theirs → ours orientation: the fork's state is the `+` side.
  const raw = await gitDiffNoIndex(source.installedPath, oursDir);
  const relativized = relativizeNoIndexDiff(
    raw.text,
    source.installedPath,
    oursDir,
  );
  const filtered = filterDiffBlocks(relativized, (header) =>
    blockPathAllowed(header, opts.element),
  );

  const base = {
    installId: pkg.sourceInstallId,
    versionLabel: source.versionLabel,
  };

  try {
    const prepared = await prepareDiff(filtered.text, raw.truncated);

    return {
      ...prepared,
      changedCount: filtered.blockCount,
      base,
      compared,
    };
  } catch (err) {
    // Highlight/prepare failure degrades to the summary projection — the
    // file list + truncated flag still surface (diffWorkingDir idiom).
    log.warn(
      {
        localPackageId: opts.localPackageId,
        err: err instanceof Error ? err.message : String(err),
      },
      "divergence diff prepare failed — summary only",
    );
    const summary = prepareDiffSummary(filtered.text, raw.truncated);

    return {
      files: summary.files,
      perFile: [],
      truncated: summary.truncated,
      changedCount: filtered.blockCount,
      base,
      compared,
    };
  }
}

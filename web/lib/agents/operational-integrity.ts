import "server-only";

import type {
  OperationalIntegrityBaseline,
  OperationalIntegrityEntry,
  OperationalResourceKind,
} from "@/lib/run-results/operational-types";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { MaisterError, isMaisterError } from "@/lib/errors";

const exec = promisify(execFile);
const MAX_ENTRIES = 100_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_PROBE_MS = 30_000;

type Limits = { maxEntries?: number; maxBytes?: number; maxProbeMs?: number };
type Tree = Omit<
  OperationalIntegrityBaseline,
  "version" | "generation" | "resourceKind" | "capturedAt" | "platform"
>;
export type OperationalRefEvidence = {
  kind: "allocated" | "disposed";
  ref: string;
  sha: string;
};
export type OperationalIntegrityResult = {
  verdict: "clean" | "changed" | "indeterminate";
  reasonCodes: string[];
  changedPaths: string[];
};

const digest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const entryKey = (entry: OperationalIntegrityEntry): string =>
  canonicalCommandJson(entry);

function probeError(reason: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "operational integrity could not be established; preserve the workspace for diagnosis",
    { details: { reason } },
  );
}

async function captureTree(
  cwd: string,
  resourceKind: OperationalResourceKind,
  limits: Limits,
): Promise<Tree> {
  const candidate = path.resolve(cwd);
  const rootInfo = await lstat(candidate);

  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw probeError("operational_integrity_root_replaced");
  const root = await realpath(candidate);
  const deadline =
    performance.now() +
    Math.min(limits.maxProbeMs ?? MAX_PROBE_MS, MAX_PROBE_MS);
  const maxEntries = Math.min(limits.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES);
  const maxBytes = Math.min(limits.maxBytes ?? MAX_BYTES, MAX_BYTES);
  const source: OperationalIntegrityEntry[] = [];
  let bytes = 0;
  const check = (): void => {
    if (
      performance.now() >= deadline ||
      bytes > maxBytes ||
      source.length > maxEntries
    )
      throw probeError("operational_integrity_limit");
  };
  const visit = async (relative: string): Promise<void> => {
    check();
    if (source.length >= maxEntries)
      throw probeError("operational_integrity_limit");
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    const mode = info.mode & 0o777;

    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);

      bytes += Buffer.byteLength(target);
      source.push({
        path: relative,
        type: "symlink",
        sha256: digest(target),
        mode,
      });
    } else if (info.isDirectory()) {
      if ((await realpath(absolute)) !== absolute)
        throw probeError("operational_integrity_symlink_race");
      source.push({
        path: relative,
        type: "directory",
        sha256: digest(""),
        mode,
      });
      for (const name of (await readdir(absolute)).sort())
        await visit(`${relative}/${name}`);
    } else if (info.isFile()) {
      bytes += info.size;
      check();
      const file = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );

      try {
        const opened = await file.stat();

        if (
          opened.ino !== info.ino ||
          opened.dev !== info.dev ||
          opened.size !== info.size
        )
          throw probeError("operational_integrity_file_race");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(1024 * 1024);
        let count = 0;

        while (true) {
          check();
          const read = await file.read(buffer, 0, buffer.length, null);

          if (read.bytesRead === 0) break;
          count += read.bytesRead;
          if (count > info.size)
            throw probeError("operational_integrity_file_race");
          hash.update(new Uint8Array(buffer.subarray(0, read.bytesRead)));
        }
        const closed = await file.stat();

        if (
          count !== info.size ||
          closed.size !== info.size ||
          closed.mtimeMs !== info.mtimeMs
        )
          throw probeError("operational_integrity_file_race");
        source.push({
          path: relative,
          type: "file",
          sha256: hash.digest("hex"),
          mode,
        });
      } finally {
        await file.close();
      }
    } else throw probeError("operational_integrity_special_file");
    check();
  };

  for (const name of (await readdir(root)).sort())
    if (name !== ".git" || resourceKind === "plain_directory")
      await visit(name);
  if (resourceKind === "plain_directory")
    return {
      source,
      head: null,
      branch: null,
      indexDigest: null,
      indexContentDigest: null,
      historyDigest: null,
      gitIdentity: null,
      gitConfigDigest: null,
      refs: [],
    };
  const git = async (args: string[]): Promise<string> => {
    check();
    const result = await exec(
      "git",
      ["-C", root, "-c", "core.fsmonitor=false", ...args],
      {
        env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
        timeout: Math.max(1, Math.ceil(deadline - performance.now())),
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    check();

    return result.stdout;
  };
  const [
    head,
    branch,
    index,
    indexContent,
    history,
    gitDirectory,
    refsText,
    localConfig,
  ] = await Promise.all([
    git(["rev-parse", "--verify", "HEAD"]),
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["ls-files", "--stage", "-v", "-z"]),
    git(["ls-files", "--stage", "-z"]),
    git(["reflog", "show", "--format=%H:%gD", "HEAD"]),
    git(["rev-parse", "--absolute-git-dir"]),
    git(["for-each-ref", "--format=%(refname) %(objectname)"]),
    git(["config", "--local", "--null", "--list"]),
  ]);

  let worktreeConfigDigest: string | null = null;

  try {
    const handle = await open(
      path.join(gitDirectory.trim(), "config.worktree"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );

    try {
      const before = await handle.stat();
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let total = 0;

      while (true) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          total,
        );

        if (!bytesRead) break;
        total += bytesRead;
        if (total > 1024 * 1024)
          throw probeError("operational_integrity_limit");
        hash.update(buffer.subarray(0, bytesRead));
        check();
      }
      const after = await handle.stat();

      if (
        !before.isFile() ||
        before.size !== total ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw probeError("operational_integrity_file_race");
      worktreeConfigDigest = hash.digest("hex");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }

  return {
    source,
    head: head.trim(),
    branch: branch.trim(),
    indexDigest: digest(index),
    indexContentDigest: digest(indexContent),
    historyDigest: digest(history),
    gitIdentity: digest(await realpath(gitDirectory.trim())),
    gitConfigDigest: digest(
      canonicalCommandJson({ localConfig, worktreeConfigDigest }),
    ),
    refs: refsText
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, sha] = line.split(" ");

        return { ref, sha };
      }),
  };
}

export async function captureOperationalBaseline(
  cwd: string,
  resourceKind: OperationalResourceKind,
  limits: Limits = {},
): Promise<OperationalIntegrityBaseline> {
  try {
    return {
      version: 1,
      generation: 0,
      resourceKind,
      capturedAt: new Date().toISOString(),
      ...(await captureTree(cwd, resourceKind, limits)),
      platform: [],
    };
  } catch (error) {
    if (isMaisterError(error)) throw error;
    throw new MaisterError(
      "PRECONDITION",
      "operational integrity capture failed",
      {
        cause: error instanceof Error ? error : undefined,
        details: { reason: "operational_integrity_probe_failed" },
      },
    );
  }
}

function expectedEntries(
  baseline: OperationalIntegrityBaseline,
): Map<string, OperationalIntegrityEntry> {
  const expected = new Map(baseline.source.map((entry) => [entry.path, entry]));

  for (const entry of baseline.platform) {
    if (entry.type === "absent") expected.delete(entry.path);
    else expected.set(entry.path, entry);
  }

  return expected;
}

function changedEntries(
  expected: Map<string, OperationalIntegrityEntry>,
  actual: readonly OperationalIntegrityEntry[],
): OperationalIntegrityEntry[] {
  const current = new Map(actual.map((entry) => [entry.path, entry]));
  const changed: OperationalIntegrityEntry[] = [];

  for (const name of new Set([...expected.keys(), ...current.keys()])) {
    const before = expected.get(name);
    const after = current.get(name);

    if (before && after && entryKey(before) === entryKey(after)) continue;
    changed.push(
      after ?? { path: name, type: "absent", sha256: digest(""), mode: 0 },
    );
  }

  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

/** Only trusted generation writes may extend expected bytes; no directory exemptions survive. */
export async function captureOperationalGeneration(
  cwd: string,
  baseline: OperationalIntegrityBaseline,
  ownedPaths: readonly string[],
): Promise<OperationalIntegrityBaseline> {
  if (
    ownedPaths.some(
      (name) =>
        path.isAbsolute(name) ||
        name
          .split("/")
          .some((part) => !part || part === ".." || part === ".") ||
        name.includes("\\") ||
        name === ".git" ||
        name.startsWith(".git/"),
    )
  )
    throw probeError("operational_materialization_conflict");
  const tree = await captureTree(cwd, baseline.resourceKind, {});
  const expected = expectedEntries(baseline);
  const changed = changedEntries(expected, tree.source);
  const owned = new Set(ownedPaths);
  const parents = new Set(
    ownedPaths.flatMap((name) => {
      const segments = name.split("/");

      return segments
        .slice(0, -1)
        .map((_, index) => segments.slice(0, index + 1).join("/"));
    }),
  );
  const allowed = (entry: OperationalIntegrityEntry): boolean => {
    if (
      entry.type === "directory" &&
      parents.has(entry.path) &&
      !expected.has(entry.path)
    )
      return true;
    const segments = entry.path.split("/");

    return segments.some((_, index) =>
      owned.has(segments.slice(0, index + 1).join("/")),
    );
  };

  if (
    tree.head !== baseline.head ||
    tree.branch !== baseline.branch ||
    tree.historyDigest !== baseline.historyDigest ||
    tree.gitIdentity !== baseline.gitIdentity ||
    (baseline.gitConfigDigest !== undefined &&
      tree.gitConfigDigest !== baseline.gitConfigDigest) ||
    tree.indexContentDigest !== baseline.indexContentDigest ||
    changed.some((entry) => !allowed(entry))
  ) {
    throw probeError("operational_materialization_conflict");
  }

  return {
    ...baseline,
    generation: baseline.generation + 1,
    indexDigest: tree.indexDigest,
    platform: [...baseline.platform, ...changed],
  };
}

export async function verifyOperationalIntegrity(
  cwd: string,
  baseline: OperationalIntegrityBaseline | null,
  refEvidence: readonly OperationalRefEvidence[] = [],
): Promise<OperationalIntegrityResult> {
  if (!baseline || baseline.version !== 1 || baseline.generation < 1)
    return {
      verdict: "indeterminate",
      reasonCodes: ["operational_baseline_missing"],
      changedPaths: [],
    };
  try {
    const tree = await captureTree(cwd, baseline.resourceKind, {});
    const changedPaths = changedEntries(
      expectedEntries(baseline),
      tree.source,
    ).map((entry) => entry.path);
    const reasonCodes: string[] = [];

    if (changedPaths.length > 0) reasonCodes.push("operational_source_changed");
    if (
      tree.head !== baseline.head ||
      tree.branch !== baseline.branch ||
      tree.historyDigest !== baseline.historyDigest ||
      tree.gitIdentity !== baseline.gitIdentity ||
      (baseline.gitConfigDigest !== undefined &&
        tree.gitConfigDigest !== baseline.gitConfigDigest)
    )
      reasonCodes.push("operational_history_changed");
    if (
      tree.indexDigest !== baseline.indexDigest ||
      tree.indexContentDigest !== baseline.indexContentDigest
    )
      reasonCodes.push("operational_index_changed");
    const before = new Map(
      baseline.refs.map((entry) => [entry.ref, entry.sha]),
    );
    const after = new Map(tree.refs.map((entry) => [entry.ref, entry.sha]));
    const foreignConflict = [
      ...new Set([...before.keys(), ...after.keys()]),
    ].some(
      (ref) =>
        before.get(ref) !== after.get(ref) &&
        !refEvidence.some(
          (evidence) =>
            evidence.ref === ref &&
            (evidence.kind === "allocated"
              ? !before.has(ref) && after.get(ref) === evidence.sha
              : before.get(ref) === evidence.sha && !after.has(ref)),
        ),
    );

    if (foreignConflict && reasonCodes.length === 0)
      reasonCodes.push("operational_repository_conflict");
    const conflicted =
      baseline.resourceKind === "shared_repository" ||
      reasonCodes.includes("operational_repository_conflict");

    return {
      verdict:
        reasonCodes.length === 0
          ? "clean"
          : conflicted
            ? "indeterminate"
            : "changed",
      reasonCodes,
      changedPaths,
    };
  } catch (error) {
    return {
      verdict: "indeterminate",
      reasonCodes: [
        isMaisterError(error) && typeof error.details?.reason === "string"
          ? error.details.reason
          : "operational_integrity_probe_failed",
      ],
      changedPaths: [],
    };
  }
}

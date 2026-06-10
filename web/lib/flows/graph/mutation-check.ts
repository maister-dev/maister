import "server-only";

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import picomatch from "picomatch";
import pino from "pino";

import { atomicWriteJson } from "@/lib/atomic";
import { resolveBaseRef, resolveRefSha } from "@/lib/worktree";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "mutation-check",
  level: process.env.LOG_LEVEL ?? "info",
});

// Mirrors web/lib/worktree.ts runGit hardening (same timeout/buffer bounds).
const GIT_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export const GIT_UNAVAILABLE_REASON =
  "git unavailable — cannot evaluate mutation assertions";

const TOUCHED_CAP = 500;

// Same ref hardening as worktree.ts gitRefSchema, minus zod: refs here are
// server-resolved SHAs / branch names, never request input.
const REF_LIKE = /^[A-Za-z0-9_./-]+$/;

function isSafeRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 255 &&
    REF_LIKE.test(ref) &&
    !ref.startsWith("-") &&
    !ref.includes("..")
  );
}

// --- diff range (shared with the diff-artifact recording, D-C3) -----------

export type DiffRange = {
  // merge-base vs main; EMPTY_TREE when git is unavailable.
  base: string;
  // immutable head SHA; branch-name fallback when git is unavailable.
  head: string;
  // false when either ref resolution threw (synthetic test envs).
  evaluated: boolean;
  // resolveRefSha failure message — call sites WARN with their own context.
  headError?: string;
};

// The CUMULATIVE branch range (merge-base vs main → branch tip) — extracted
// from the runner-graph produces-recording diff block so the diff artifact and
// the mutation sensor compute the SAME range with the SAME fallbacks
// (byte-identical locators).
export async function resolveDiffRange(workspace: {
  worktreePath: string;
  branch: string;
}): Promise<DiffRange> {
  let base = EMPTY_TREE;
  let evaluated = true;

  try {
    base = await resolveBaseRef({
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      mainBranch: "main",
    });
  } catch {
    // no real git repo in test environments — use empty tree
    evaluated = false;
  }

  let head = workspace.branch;
  let headError: string | undefined;

  try {
    head = await resolveRefSha(workspace.worktreePath, workspace.branch);
  } catch (err) {
    // no real git repo — keep the branch name
    evaluated = false;
    headError = err instanceof Error ? err.message : String(err);
  }

  return headError !== undefined
    ? { base, head, evaluated, headError }
    : { base, head, evaluated };
}

// Repo-relative POSIX paths the range touched (`git diff --name-only`).
export async function touchedPaths(
  worktreePath: string,
  base: string,
  head: string,
): Promise<string[]> {
  if (!isSafeRef(base) || !isSafeRef(head)) {
    throw new Error(`unsafe git ref in diff range: ${base}..${head}`);
  }

  // core.quotePath=false: git would otherwise C-quote non-ASCII paths and a
  // quoted path silently mismatches every glob — a false-negative on the
  // must_not_touch direction.
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      worktreePath,
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      `${base}..${head}`,
    ],
    {
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      maxBuffer: EXEC_MAX_BUFFER,
    },
  );

  const touched = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  log.debug({ base, head, touchedCount: touched.length }, "touchedPaths");

  return touched;
}

// --- node-start head capture (D-C3, write-if-absent) ----------------------

// Mirrors flow-paths SAFE_PATH_SEGMENT: the node id becomes a filename
// segment. An unsafe id skips the capture (cumulative fallback at gate time)
// rather than crashing the attempt.
const SAFE_NODE_ID = /^[A-Za-z0-9._-]+$/;

function nodeStartFile(runDirPath: string, nodeId: string): string | null {
  if (!SAFE_NODE_ID.test(nodeId) || nodeId.includes("..")) return null;

  return path.join(runDirPath, `node-start-${nodeId}.json`);
}

// Write-if-absent: one file per (run, node). Attempt 2+ and checkpoint/resume
// keep the original, so the TRUE start survives process death and rework
// loops. Returns true when this call performed the write.
export async function captureNodeStartHead(
  runDirPath: string,
  nodeId: string,
  head: string,
): Promise<boolean> {
  const file = nodeStartFile(runDirPath, nodeId);

  if (file === null) {
    log.warn({ nodeId }, "node-start capture skipped — path-unsafe node id");

    return false;
  }

  try {
    await access(file);

    return false; // already captured — keep the original
  } catch {
    // absent → capture
  }

  await atomicWriteJson(file, { head });
  log.debug({ nodeId, head }, "node-start head captured");

  return true;
}

export async function readNodeStartHead(
  runDirPath: string,
  nodeId: string,
): Promise<string | null> {
  const file = nodeStartFile(runDirPath, nodeId);

  if (file === null) return null;

  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { head?: unknown }).head === "string"
    ) {
      return (parsed as { head: string }).head;
    }

    return null;
  } catch {
    return null;
  }
}

// The per-run artifact directory (`.maister/<slug>/runs/<runId>`) — mirrors
// the runner-graph private runDir so gates-exec resolves the same location.
export function runDirPath(
  runtimeRoot: string,
  projectSlug: string,
  runId: string,
): string {
  return path.join(runtimeRoot, ".maister", projectSlug, "runs", runId);
}

// --- pure assertion engine (D-C1/D-C2/D-C4) --------------------------------

export type RestrictionPathSet = {
  id: string;
  paths?: string[];
};

// Project the node's resolved restriction capability entries onto the path
// sets the sensor checks. `material.paths` is untyped jsonb — guard at
// runtime; an entry with no valid paths stays {id} (reported `unmatchable`).
export function restrictionPathSets(
  entries: ReadonlyArray<{
    capabilityRefId: string;
    kind: string;
    material: Record<string, unknown>;
  }>,
): RestrictionPathSet[] {
  return entries
    .filter((e) => e.kind === "restriction")
    .map((e) => {
      const raw = e.material.paths;
      const paths = Array.isArray(raw)
        ? raw.filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];

      return paths.length > 0
        ? { id: e.capabilityRefId, paths }
        : { id: e.capabilityRefId };
    });
}

export type MutationReport = {
  basis: "node" | "cumulative-fallback";
  nodeRange: { base: string; head: string };
  cumulativeRange?: { base: string; head: string };
  // node-range touched paths, truncated at 500.
  touched: string[];
  truncated: boolean;
  mustTouch: { globs: string[]; matched: string[]; matchedTruncated: boolean };
  restrictions: {
    checked: Array<{ id: string; paths: string[]; violations: string[] }>;
    unmatchable: string[];
  };
  violations: string[];
  evaluated: boolean;
};

// Bound the violating-path list inside the human-readable reason; the full
// list stays in report.restrictions.checked[].violations.
const REASON_PATH_CAP = 10;

export function evaluateMutationAssertions(args: {
  nodeTouched: string[];
  cumulativeTouched: string[];
  mustTouch?: string[];
  mustNotTouch?: "restrictions";
  restrictionSets?: RestrictionPathSet[];
  basis: "node" | "cumulative-fallback";
  nodeRange: { base: string; head: string };
  cumulativeRange?: { base: string; head: string };
  evaluated: boolean;
}): { pass: boolean; report: MutationReport } {
  const globs = args.mustTouch ?? [];
  const violations: string[] = [];

  const report: MutationReport = {
    basis: args.basis,
    nodeRange: args.nodeRange,
    cumulativeRange: args.cumulativeRange,
    touched: args.nodeTouched.slice(0, TOUCHED_CAP),
    truncated: args.nodeTouched.length > TOUCHED_CAP,
    mustTouch: { globs, matched: [], matchedTruncated: false },
    restrictions: { checked: [], unmatchable: [] },
    violations,
    evaluated: args.evaluated,
  };

  if (!args.evaluated) {
    // A sensor that cannot sense must not pass (D-C3).
    violations.push(GIT_UNAVAILABLE_REASON);

    return { pass: false, report };
  }

  if (args.mustTouch !== undefined) {
    const isMatch = picomatch(globs, { dot: true });
    const matched = args.nodeTouched.filter((p) => isMatch(p));

    report.mustTouch.matched = matched.slice(0, TOUCHED_CAP);
    report.mustTouch.matchedTruncated = matched.length > TOUCHED_CAP;

    if (matched.length === 0) {
      violations.push(`must_touch: no path matched [${globs.join(", ")}]`);
    }
  }

  if (args.mustNotTouch === "restrictions") {
    const violated = new Set<string>();

    for (const restriction of args.restrictionSets ?? []) {
      const paths = restriction.paths ?? [];

      if (paths.length === 0) {
        report.restrictions.unmatchable.push(restriction.id);
        continue;
      }

      const isMatch = picomatch(paths, { dot: true });
      const hits = args.cumulativeTouched.filter((p) => isMatch(p));

      report.restrictions.checked.push({
        id: restriction.id,
        paths,
        violations: hits,
      });
      for (const hit of hits) violated.add(hit);
    }

    if (violated.size > 0) {
      const listed = [...violated].slice(0, REASON_PATH_CAP);
      const suffix = violated.size > REASON_PATH_CAP ? ", …" : "";

      violations.push(
        `must_not_touch: ${violated.size} violation(s): ${listed.join(", ")}${suffix}`,
      );
    }
  }

  return { pass: violations.length === 0, report };
}

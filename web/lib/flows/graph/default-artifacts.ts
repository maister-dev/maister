import "server-only";

import type { Workspace as WorkspaceRow } from "@/lib/db/schema";

import { access } from "node:fs/promises";
import path from "node:path";

import { and, desc, eq, isNotNull } from "drizzle-orm";
import pino from "pino";

import { recordArtifact } from "./artifact-store";

import { resolveBaseRef, resolveRefSha } from "@/lib/worktree";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "default-artifacts",
  level: process.env.LOG_LEVEL ?? "info",
});

// Returns true when the file at `filePath` exists (best-effort, no throw).
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
}

// Attempt git merge-base to get the diff base commit. Falls back to the empty
// tree SHA so the diff locator always has a valid (if meaningless) baseCommit
// in environments without a real git repo (e.g. integration test containers
// where the worktree path is a temp dir with no git).
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function safeBaseCommit(workspace: WorkspaceRow): Promise<string> {
  try {
    return await resolveBaseRef({
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      mainBranch: "main",
    });
  } catch {
    return EMPTY_TREE_SHA;
  }
}

// Resolve the branch tip to an immutable SHA so the default diff locator's
// headRef never drifts when the branch advances (PR2/F3). Falls back to the
// mutable branch name when git is unavailable (e.g. integration test
// containers), and WARNs so the degraded-git record is traceable.
async function safeHeadRef(workspace: WorkspaceRow): Promise<string> {
  try {
    return await resolveRefSha(workspace.worktreePath, workspace.branch);
  } catch (err) {
    log.warn(
      { branch: workspace.branch, err: (err as Error).message },
      "resolveRefSha failed — storing mutable branch headRef",
    );

    return workspace.branch;
  }
}

export type RecordDefaultArtifactsArgs = {
  runId: string;
  nodeAttemptId?: string;
  stepRunId?: string;
  nodeId: string;
  attempt: number;
  projectSlug: string;
  workspace: WorkspaceRow;
  runtimeRoot: string;
};

// Record up to four default ("index") artifact rows for a just-finished
// node/step. The rows point at EXISTING payloads; no payload is created here.
// Called from BOTH runner-graph.ts (node finish) and runner.ts (step finish).
//
// - log: if <runDir>/<nodeId>.log exists → kind "log"
// - guards: if <runDir>/guards.jsonl exists → kind "generic_file"
// - hitl-response: if a hitl_requests row with non-null response exists for
//   (runId, nodeId) → kind "human_note", locator hitl-response
// - diff: always → kind "diff", locator git-range
//
// Deterministic id: run:<nodeAttemptId>:default:<kind> when nodeAttemptId
// present; else (linear) run:<stepRunId>:default:<kind> with
// node_attempt_id column = NULL, node_id = <nodeId>.
export async function recordDefaultArtifacts(
  args: RecordDefaultArtifactsArgs,
  db: Db,
): Promise<void> {
  const {
    runId,
    nodeAttemptId,
    stepRunId,
    nodeId,
    attempt,
    workspace,
    runtimeRoot,
    projectSlug,
  } = args;

  const runDir = path.join(runtimeRoot, ".maister", projectSlug, "runs", runId);

  // Deterministic id prefix: either nodeAttemptId (graph) or stepRunId (linear).
  const idBase = nodeAttemptId ?? stepRunId ?? `noid-${nodeId}`;

  function makeId(kind: string): string {
    return `run:${idBase}:default:${kind}`;
  }

  const baseArgs = {
    runId,
    nodeAttemptId: nodeAttemptId ?? null,
    nodeId,
    attempt,
    producer: "runner" as const,
    validity: "current" as const,
    visibility: "internal" as const,
    retention: "run" as const,
  };

  // 1. Log artifact (best-effort: only if payload exists)
  const logPath = path.join(runDir, `${nodeId}.log`);

  if (await fileExists(logPath)) {
    try {
      await recordArtifact(
        {
          ...baseArgs,
          id: makeId("log"),
          artifactDefId: `default:${nodeId}:log`,
          kind: "log",
          locator: { kind: "file", path: `${nodeId}.log` },
        },
        db,
      );
    } catch (err) {
      log.warn(
        { runId, nodeId, err: (err as Error).message },
        "default log artifact record failed (non-fatal)",
      );
    }
  }

  // 2. Guards metrics (best-effort: only if payload exists)
  const guardsPath = path.join(runDir, "guards.jsonl");

  if (await fileExists(guardsPath)) {
    try {
      await recordArtifact(
        {
          ...baseArgs,
          id: makeId("guards"),
          artifactDefId: `default:${nodeId}:guards`,
          kind: "generic_file",
          locator: { kind: "file", path: "guards.jsonl" },
        },
        db,
      );
    } catch (err) {
      log.warn(
        { runId, nodeId, err: (err as Error).message },
        "default guards artifact record failed (non-fatal)",
      );
    }
  }

  // 3. HITL response (best-effort: only if responded row exists)
  try {
    // On an on_reject rework loop a step has multiple responded HITL rows
    // (reject, then the final approve). Bind the human_note to the LATEST one
    // (newest by creation) so the final decision is current evidence, never a
    // stale earlier reject.
    const hitlRows: Array<{ id: string }> = await db
      .select({ id: hitlRequests.id })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, runId),
          eq(hitlRequests.stepId, nodeId),
          isNotNull(hitlRequests.response),
        ),
      )
      .orderBy(desc(hitlRequests.createdAt))
      .limit(1);

    const hitlRow = hitlRows[0];

    if (hitlRow) {
      await recordArtifact(
        {
          ...baseArgs,
          id: makeId("human_note"),
          artifactDefId: `default:${nodeId}:human_note`,
          kind: "human_note",
          locator: { kind: "hitl-response", hitlRequestId: hitlRow.id },
        },
        db,
      );
    }
  } catch (err) {
    log.warn(
      { runId, nodeId, err: (err as Error).message },
      "default hitl artifact record failed (non-fatal)",
    );
  }

  // 4. Diff artifact (always — uses safe fallback when git unavailable)
  try {
    const baseCommit = await safeBaseCommit(workspace);
    const headRef = await safeHeadRef(workspace);

    await recordArtifact(
      {
        ...baseArgs,
        id: makeId("diff"),
        artifactDefId: `default:${nodeId}:diff`,
        kind: "diff",
        locator: {
          kind: "git-range",
          baseCommit,
          headRef,
        },
      },
      db,
    );
  } catch (err) {
    log.warn(
      { runId, nodeId, err: (err as Error).message },
      "default diff artifact record failed (non-fatal)",
    );
  }
}

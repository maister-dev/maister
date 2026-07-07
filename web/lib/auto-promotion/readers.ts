import type {
  AutoPromotionReaders,
  ExternalCheckState,
} from "@/lib/auto-promotion/evaluate";
import type { DepsFile } from "@/lib/auto-promotion/deps-check";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { DiffChangeStatEntry } from "@/lib/worktree";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import {
  flowRevisions,
  flows,
  gateResults,
  hitlRequests,
  runs,
} from "@/lib/db/schema";
import { compileManifest } from "@/lib/flows/graph/compile";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { getNodeAttemptsForRun } from "@/lib/flows/graph/ledger";
import {
  collapseLatestExternalPerGate,
  isExternalGateReady,
  latestAttemptIdsByNode,
} from "@/lib/flows/graph/readiness-core";

// FIXME(any): tests pass a Testcontainers pg client; both expose select.
type Db = any;

const execFileAsync = promisify(execFile);

const log = pino({
  name: "auto-promote.readers",
  level: process.env.LOG_LEVEL ?? "info",
});

// The set of external_check gate ids DECLARED in the run's compiled flow graph
// (ADR-126 F3). The manifest lives in the DB — the pinned flow_revisions.manifest
// wins over the flow's current manifest (per-run immutability), the same
// precedence runner-core's loadRun uses. Fail-closed: any load/compile failure ⇒
// empty set (the lane's check reads as not_declared → ineligible), NEVER a throw
// into the sweep (evaluateAutoPromotion runs outside the candidate try — a bad
// manifest must not crash the tick).
async function declaredExternalCheckGateIds(
  db: Db,
  runId: string,
): Promise<Set<string>> {
  try {
    const [run] = await db
      .select({ flowId: runs.flowId, flowRevisionId: runs.flowRevisionId })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    if (!run) return new Set();

    let manifest: FlowYamlV1 | null = null;

    if (run.flowRevisionId) {
      const [rev] = await db
        .select({ manifest: flowRevisions.manifest })
        .from(flowRevisions)
        .where(eq(flowRevisions.id, run.flowRevisionId))
        .limit(1);

      manifest = (rev?.manifest ?? null) as FlowYamlV1 | null;
    } else if (run.flowId) {
      const [f] = await db
        .select({ manifest: flows.manifest })
        .from(flows)
        .where(eq(flows.id, run.flowId))
        .limit(1);

      manifest = (f?.manifest ?? null) as FlowYamlV1 | null;
    }

    if (!manifest) return new Set();

    const graph = compileManifest(manifest);
    const ids = new Set<string>();

    for (const node of graph.nodes.values()) {
      for (const gate of node.gates) {
        if (gate.kind === "external_check") ids.add(gate.id);
      }
    }

    return ids;
  } catch (err) {
    log.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "auto-promotion: failed to resolve declared external_check gates — fail-closed",
    );

    return new Set();
  }
}

// Best-effort git file-at-ref read (deps lane only). Absent at a ref ⇒ null;
// never throws.
async function showFileAtRef(
  worktreePath: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["show", `${ref}:${path}`], {
      cwd: worktreePath,
      maxBuffer: 8 * 1024 * 1024,
    });

    return stdout;
  } catch {
    return null;
  }
}

// The DB/git-backed readers evaluateAutoPromotion needs. Shared by the sweep, the
// panel route, and the run-detail RSC so all three produce byte-identical
// verdicts (INV-10).
export function buildAutoPromotionReaders(args: {
  db: Db;
  runId: string;
  worktreePath: string;
  baseRef: string;
  branch: string;
}): AutoPromotionReaders {
  const { db, runId, worktreePath, baseRef, branch } = args;

  return {
    async hasOpenHitl(): Promise<boolean> {
      const rows = await db
        .select({ id: hitlRequests.id })
        .from(hitlRequests)
        .where(
          and(eq(hitlRequests.runId, runId), isNull(hitlRequests.response)),
        )
        .limit(1);

      return rows.length > 0;
    },
    async readinessGreen(): Promise<boolean> {
      try {
        await assertEvidenceReady(runId, "review", db);

        return true;
      } catch {
        return false;
      }
    },
    async externalCheck(gateId: string): Promise<ExternalCheckState> {
      // A gateId absent from the run's compiled flow graph is a misconfiguration
      // (typo / wrong flow) ⇒ not_declared (external_check_missing).
      const declared = await declaredExternalCheckGateIds(db, runId);

      if (!declared.has(gateId)) return "not_declared";

      // Latest-live semantics, shared with readiness-core (Codex R3): drop rows on
      // superseded attempts, collapse to the newest report per gate, and inspect
      // that ONE status. A historical `passed` must never satisfy the lane after a
      // newer pending/failed/stale report on the live attempt.
      const liveAttemptIds = latestAttemptIdsByNode(
        await getNodeAttemptsForRun(runId, db),
      );
      const rows: Array<{
        id: string;
        nodeAttemptId: string;
        gateId: string;
        status: string;
        createdAt: Date;
      }> = await db
        .select({
          id: gateResults.id,
          nodeAttemptId: gateResults.nodeAttemptId,
          gateId: gateResults.gateId,
          status: gateResults.status,
          createdAt: gateResults.createdAt,
        })
        .from(gateResults)
        .where(
          and(
            eq(gateResults.runId, runId),
            eq(gateResults.gateId, gateId),
            eq(gateResults.kind, "external_check"),
          ),
        );

      const live = rows.filter((r) => liveAttemptIds.has(r.nodeAttemptId));
      const [latest] = collapseLatestExternalPerGate(live, (r) => r.gateId);

      if (!latest) return "declared_not_passed";

      return isExternalGateReady(latest.status)
        ? "passed"
        : "declared_not_passed";
    },
    async readDepsFiles(files: DiffChangeStatEntry[]): Promise<DepsFile[]> {
      return Promise.all(
        files.map(async (f) => ({
          path: f.path,
          status: f.status,
          base: await showFileAtRef(worktreePath, baseRef, f.oldPath ?? f.path),
          branch: await showFileAtRef(worktreePath, branch, f.path),
        })),
      );
    },
  };
}

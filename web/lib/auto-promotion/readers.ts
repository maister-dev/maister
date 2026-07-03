import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { and, eq, isNull } from "drizzle-orm";

import type {
  AutoPromotionReaders,
  ExternalCheckState,
} from "@/lib/auto-promotion/evaluate";
import type { DepsFile } from "@/lib/auto-promotion/deps-check";
import { gateResults, hitlRequests } from "@/lib/db/schema";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import type { DiffChangeStatEntry } from "@/lib/worktree";

// FIXME(any): tests pass a Testcontainers pg client; both expose select.
type Db = any;

const execFileAsync = promisify(execFile);

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
        .where(and(eq(hitlRequests.runId, runId), isNull(hitlRequests.response)))
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
      // Fail-closed: a passing/overridden external_check row ⇒ passed, else
      // declared_not_passed (the not_declared distinction needs the compiled
      // FlowGraph; both are ineligible, so the sweep/panel report
      // declared_not_passed).
      const rows = await db
        .select({ status: gateResults.status })
        .from(gateResults)
        .where(
          and(
            eq(gateResults.runId, runId),
            eq(gateResults.gateId, gateId),
            eq(gateResults.kind, "external_check"),
          ),
        );

      const passed = rows.some(
        (r: { status: string }) =>
          r.status === "passed" || r.status === "overridden",
      );

      return passed ? "passed" : "declared_not_passed";
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

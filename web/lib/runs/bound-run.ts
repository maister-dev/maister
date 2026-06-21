import "server-only";

import { and, eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { isTerminalRunStatus } from "@/lib/runs/run-status-sets";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type ActiveBoundRun = {
  id: string;
  taskId: string | null;
  rootRunId: string | null;
  status: string;
};

export type ActiveBoundRunResult =
  | { ok: true; run: ActiveBoundRun }
  | { ok: false; code: "PRECONDITION"; message: string };

// Codex adversarial review (Finding 1). A run-bound ext token
// (`orchestrator-run:<id>`) is best-effort revoked on the NORMAL graph-exit
// path, but abandon / crash / stop terminal transitions can flip the bound run
// terminal WITHOUT revoking it. A leftover or copied token would then keep
// delegating / cancelling / promoting / reworking / messaging under a TERMINAL
// tree for the token TTL — violating cancellation and terminal-state invariants.
//
// Every run-bound ext route MUST resolve the bound run through this helper and
// fail closed when it is missing or no longer orchestrating (terminal) BEFORE
// any task/child mutation. `projectId` is the token's auth-context binding and
// `boundRunId` its run binding (`ctx.actor.boundRunId`) — never body fields.
//
// Returns a result union rather than throwing: the run load happens outside each
// route's MaisterError-mapping try/catch, and `handleExt` re-throws (→ 500), so
// the routes early-`return NextResponse.json` from `{ ok: false }`.
export async function resolveActiveBoundRun(
  db: Db,
  boundRunId: string,
  projectId: string,
): Promise<ActiveBoundRunResult> {
  const rows = (await db
    .select({
      id: runs.id,
      taskId: runs.taskId,
      rootRunId: runs.rootRunId,
      status: runs.status,
    })
    .from(runs)
    .where(
      and(eq(runs.id, boundRunId), eq(runs.projectId, projectId)),
    )) as ActiveBoundRun[];

  const run = rows[0];

  if (!run) {
    return {
      ok: false,
      code: "PRECONDITION",
      message: "the token's bound run was not found in this project",
    };
  }

  if (isTerminalRunStatus(run.status)) {
    return {
      ok: false,
      code: "PRECONDITION",
      message: `the orchestrator run is no longer active (status=${run.status}) — a stale run-bound token cannot mutate a terminal tree`,
    };
  }

  return { ok: true, run };
}

import "server-only";

import type {
  RunnerResolutionWarning,
  RunnerSnapshot,
} from "@/lib/acp-runners/resolve";
import type { RunSession } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { runSessions } from "@/lib/db/schema";

// FIXME(any): mirrors the `Db = any` handle the graph runner threads through
// (lib/flows/graph/runner-core.ts) — a tx and a pool client are both valid here.
type Db = any;

// Seed a substep's `run_sessions` row with the runner it is about to spawn
// with, BEFORE the session-create command is issued.
//
// A substep (gate evaluation, consensus verification, consensus synthesis) runs
// its own ACP session beside the node's and names itself, so — unlike a node
// session — no row is pre-inserted for it at launch: `inspectFlowRunners` only
// enumerates the compiled manifest's sessions, and a substep name is dynamic.
// Without this seed the create acknowledgement takes its INSERT branch
// (`execution-host/create-ack.ts`), which writes only the host/ACP binding and
// leaves `runner_id`, `runner_resolution_tier`, `capability_agent`,
// `runner_snapshot` and `resolution_source` NULL. Nothing backfills them: that
// ack is the only writer of `run_sessions` on the spawn path.
//
// That matters beyond audit. `activeRunSessionScalar` picks a run's ACTIVE
// session live-handle-first, then newest — so a live substep row OUTRANKS the
// node's own session and becomes the row the portfolio, board, run and inbox
// screens read. It is also the row per-session cost attribution buckets by.
//
// Same shape as the branch-sync resolver's `sync-<attempt>` session
// (runs/sync-target.ts), which has pre-inserted its row since ADR-141.
//
// Idempotent: a substep whose session is respawned (a permission resume rebinds
// the same stable `gate-<id>` row) must not 23505 on the
// `(run_id, session_name)` unique constraint, and must not overwrite the
// binding a previous incarnation wrote.
export async function ensureSubstepRunSession(input: {
  db: Db;
  runId: string;
  sessionName: string;
  snapshot: RunnerSnapshot;
  // Only when the snapshot came from a FRESH catalog resolution. `runner_id` is
  // an FK to `platform_acp_runners`, so replaying an id off a stored snapshot
  // whose runner has since been deleted would fail the insert — and this column
  // is audit/index only. The display path reads `capability_agent` and
  // `runner_snapshot`, both of which are always written here.
  runnerId?: string | null;
  runnerResolutionTier?: RunSession["runnerResolutionTier"];
  resolutionSource: string;
  resolutionWarning?: RunnerResolutionWarning | null;
}): Promise<void> {
  await input.db
    .insert(runSessions)
    .values({
      id: randomUUID(),
      runId: input.runId,
      sessionName: input.sessionName,
      runnerId: input.runnerId ?? null,
      runnerResolutionTier: input.runnerResolutionTier ?? null,
      capabilityAgent: input.snapshot.capabilityAgent,
      runnerSnapshot: input.snapshot,
      acpSessionId: null,
      resolutionSource: input.resolutionSource,
      resolutionWarning: input.resolutionWarning ?? null,
    })
    .onConflictDoNothing({
      target: [runSessions.runId, runSessions.sessionName],
    });
}

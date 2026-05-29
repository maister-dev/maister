import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { nextKeepaliveAt } from "./keepalive-config";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-state",
  level: process.env.LOG_LEVEL ?? "info",
});

export type StateTransitionResult =
  | { ok: true }
  | { ok: false; reason: "status-guard-mismatch" | "not-found" };

export type StateTransitionOptions = {
  db?: Db;
};

// M8 D3 / D5: NeedsInput → NeedsInputIdle on keep-alive expiry. The
// sweeper calls this AFTER the supervisor has acknowledged the graceful
// checkpoint (or after the supervisor was found to be no longer holding
// the session). Atomicity guarantee: the UPDATE WHERE-clause is a
// status guard — if the row moved to Running/Crashed/Failed/etc. in the
// meantime (e.g. operator manually resumed via /respond before the
// sweeper tick fired), the UPDATE is a no-op and we return
// `{ok: false, reason: "status-guard-mismatch"}`.
export async function markCheckpointed(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
      keepaliveUntil: null,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, from: "NeedsInput", to: "NeedsInputIdle" },
      "markCheckpointed: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "NeedsInput", to: "NeedsInputIdle" },
    "run-state transition",
  );

  return { ok: true };
}

// M8 Codex review fix #1: same NeedsInput → NeedsInputIdle as
// markCheckpointed, but called from the runner-agent's event consumer
// when it observes `session.exited.reason === "checkpoint"` on the SSE
// stream (rather than from the keep-alive sweeper). The SQL is identical
// — only the log message differs so the trigger is auditable. Idempotent
// with the sweeper path because both share the status guard.
export async function markCheckpointedFromExit(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
      keepaliveUntil: null,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, from: "NeedsInput", to: "NeedsInputIdle", trigger: "exit" },
      "markCheckpointedFromExit: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "NeedsInput", to: "NeedsInputIdle", trigger: "exit" },
    "run-state transition — runner-agent observed checkpoint reason",
  );

  return { ok: true };
}

// M8 D7 (success path) / D8 Phase 2: NeedsInputIdle → NeedsInput on
// resume. Sets a fresh `keepalive_until` so the resumed run cannot be
// re-checkpointed by the next sweeper tick before the operator has even
// finished interacting. Clears `checkpoint_at` so the run looks like a
// fresh live session for diagnostics.
export async function markResumed(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({
      status: "NeedsInput",
      keepaliveUntil: nextKeepaliveAt(),
      checkpointAt: null,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, from: "NeedsInputIdle", to: "NeedsInput" },
      "markResumed: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "NeedsInputIdle", to: "NeedsInput" },
    "run-state transition",
  );

  return { ok: true };
}

// M8 T7: activity ping extends the keep-alive window without changing
// status. Status guard: only Running and NeedsInput rows accept a bump.
// NeedsInputIdle rows do NOT accept bumps — the activity route returns
// 409 with a hint to /respond instead.
export async function bumpKeepalive(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({ keepaliveUntil: nextKeepaliveAt() })
    .where(
      and(eq(runs.id, runId), inArray(runs.status, ["Running", "NeedsInput"])),
    )
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.debug({ runId }, "bumpKeepalive: status-guard mismatch");

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.debug({ runId }, "bumpKeepalive: extended");

  return { ok: true };
}

export type FailReason = string;

// M8 D7 failure rows that produce terminal Failed via failResumedRun:
//   - supervisor 400 spawn refused (CHECKPOINT)
//   - supervisor 201 but empty acpSessionId (CHECKPOINT)
//   - supervisor 404 unknown checkpoint (CHECKPOINT)
//
// [FIX] M8 review finding #3: with the new claim-before-spawn order in
// resumeRun the post-claim row is NeedsInput, not NeedsInputIdle. The
// status guard accepts both so the terminal Failed transition fires
// regardless of which side of the claim the spawn happened on.
export async function failResumedRun(
  runId: string,
  reason: FailReason,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({ status: "Failed", endedAt: new Date() })
    .where(
      and(
        eq(runs.id, runId),
        inArray(runs.status, ["NeedsInputIdle", "NeedsInput"]),
      ),
    )
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, to: "Failed", reason },
      "failResumedRun: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.warn(
    { runId, to: "Failed", reason },
    "run-state transition — failed during resume",
  );

  return { ok: true };
}

// [FIX] M8 review finding #3: when the atomic claim path
// (markResumed BEFORE createSession) has to undo itself because the
// supervisor spawn failed with a RETRYABLE error, we transition the
// run back to NeedsInputIdle so the next operator response (or the
// next sweeper pass) sees the original state. Status guard restricted
// to `NeedsInput` so a concurrent terminal transition (e.g.
// crashResumedRun) cannot be overwritten by the rollback.
export async function rollbackResumedRun(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
      keepaliveUntil: null,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, from: "NeedsInput", to: "NeedsInputIdle (rollback)" },
      "rollbackResumedRun: status-guard mismatch — concurrent transition won",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "NeedsInput", to: "NeedsInputIdle (rollback)" },
    "[FIX] run-state transition — resume claim rolled back after retryable spawn failure",
  );

  return { ok: true };
}

// M8 D9 / T11: NeedsInput → Crashed when the runner-agent's
// resume-prompt watchdog expires (the resumed session was supposed to
// re-issue session.permission_request within
// `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS` but did not).
export async function crashResumedRun(
  runId: string,
  reason: FailReason,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({ status: "Crashed", endedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, from: "NeedsInput", to: "Crashed", reason },
      "crashResumedRun: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.warn(
    { runId, from: "NeedsInput", to: "Crashed", reason },
    "run-state transition — crashed during resume",
  );

  return { ok: true };
}

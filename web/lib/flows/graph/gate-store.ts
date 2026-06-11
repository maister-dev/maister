import "server-only";

import type {
  GateResult,
  GateResultStatus,
  GateKind,
  GateVerdict,
} from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { recordArtifact } from "@/lib/flows/graph/artifact-store";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants (matches step-runs.ts idiom).
const { gateResults, runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "flow-gate-results",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type GateMode = "blocking" | "advisory";

// gate.decided fires only when a gate row REACHES a terminal decision. stale /
// skipped are non-terminal landings and emit nothing.
const TERMINAL_GATE_STATUSES = new Set(["passed", "failed", "overridden"]);

// gate_results rows carry runId but no projectId — resolve it via one PK lookup
// on the SAME handle that wrote the gate row so the emit rides the same tx.
async function projectIdForRun(db: Db, runId: string): Promise<string> {
  const rows = await db
    .select({ projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, runId));

  return rows[0].projectId;
}

// Create a gate_results row. Defaults to `running` (the live execution path,
// Phase 4.1); deferred kinds create directly at `skipped`/`pending` (Phase 4.5).
export async function createGateResult(args: {
  runId: string;
  nodeAttemptId: string;
  gateId: string;
  kind: GateKind;
  mode: GateMode;
  status?: GateResultStatus;
  inputArtifactRefs?: string[];
  staleFrom?: string[];
  verdict?: GateVerdict;
  db?: Db;
}): Promise<{ id: string }> {
  const db = args.db ?? getDb();
  const id = randomUUID();
  const status = args.status ?? "running";

  const row = {
    id,
    runId: args.runId,
    nodeAttemptId: args.nodeAttemptId,
    gateId: args.gateId,
    kind: args.kind,
    mode: args.mode,
    status,
    inputArtifactRefs: args.inputArtifactRefs ?? null,
    staleFrom: args.staleFrom ?? null,
    verdict: args.verdict ?? null,
    endedAt: status === "running" || status === "pending" ? null : new Date(),
  };

  if (TERMINAL_GATE_STATUSES.has(status)) {
    // Insert-at-terminal (reportExternalGate's supersede path) commits the row
    // and its gate.decided outbox row atomically — same invariant as
    // transition() below. If the caller's handle is already a transaction,
    // this nests as a savepoint.
    await db.transaction(async (tx: Db) => {
      await tx.insert(gateResults).values(row);

      await emitWebhookEvent({
        db: tx,
        type: "gate.decided",
        projectId: await projectIdForRun(tx, args.runId),
        runId: args.runId,
        data: {
          gateId: args.gateId,
          kind: args.kind,
          mode: args.mode,
          status,
          nodeAttemptId: args.nodeAttemptId,
        },
      });

      if (status === "failed") {
        await emitDomainEvent({
          db: tx,
          kind: "gate.failed",
          projectId: await projectIdForRun(tx, args.runId),
          runId: args.runId,
          actor: { type: "system", id: null },
          payload: {
            runId: args.runId,
            gateId: args.gateId,
            gateKind: args.kind,
            gateResultId: id,
            nodeAttemptId: args.nodeAttemptId,
            blocking: args.mode === "blocking",
          },
        });
      }
    });
  } else {
    await db.insert(gateResults).values(row);
  }

  log.info(
    {
      gateResultId: id,
      runId: args.runId,
      gateId: args.gateId,
      kind: args.kind,
      mode: args.mode,
      status,
    },
    "gate-result created",
  );

  return { id };
}

// The flip and its gate.decided outbox row commit in ONE transaction (ADR-077)
// — a crash between them must not flip the gate while losing the event. The
// `status <>` CAS makes a repeat same-status transition a no-op (0 rows, no
// emit) while cross-status moves (failed → overridden) still pass. Callers only
// ever hand in a plain db (gates-exec via ctx.db), so owning a transaction here
// never nests inside a caller tx.
async function transition(
  id: string,
  status: GateResultStatus,
  extra: Record<string, unknown>,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d.transaction(async (tx: Db) => {
    const rows = await tx
      .update(gateResults)
      .set({ status, endedAt: new Date(), ...extra })
      .where(and(eq(gateResults.id, id), ne(gateResults.status, status)))
      .returning({
        runId: gateResults.runId,
        gateId: gateResults.gateId,
        kind: gateResults.kind,
        mode: gateResults.mode,
        nodeAttemptId: gateResults.nodeAttemptId,
      });

    if (rows.length > 0 && TERMINAL_GATE_STATUSES.has(status)) {
      const row = rows[0];

      await emitWebhookEvent({
        db: tx,
        type: "gate.decided",
        projectId: await projectIdForRun(tx, row.runId),
        runId: row.runId,
        data: {
          gateId: row.gateId,
          kind: row.kind,
          mode: row.mode,
          status,
          nodeAttemptId: row.nodeAttemptId,
        },
      });

      if (status === "failed") {
        await emitDomainEvent({
          db: tx,
          kind: "gate.failed",
          projectId: await projectIdForRun(tx, row.runId),
          runId: row.runId,
          actor: { type: "system", id: null },
          payload: {
            runId: row.runId,
            gateId: row.gateId,
            gateKind: row.kind,
            gateResultId: id,
            nodeAttemptId: row.nodeAttemptId,
            blocking: row.mode === "blocking",
          },
        });
      }
    }
  });

  log.info({ gateResultId: id, status }, "gate-result transition");
}

export async function markGatePassed(
  id: string,
  verdict?: GateVerdict,
  db?: Db,
): Promise<void> {
  await transition(id, "passed", verdict ? { verdict } : {}, db);
}

export async function markGateFailed(
  id: string,
  verdict?: GateVerdict,
  db?: Db,
): Promise<void> {
  await transition(id, "failed", verdict ? { verdict } : {}, db);
}

export async function markGateStale(id: string, db?: Db): Promise<void> {
  await transition(id, "stale", {}, db);
}

export async function markGateSkipped(
  id: string,
  verdict?: GateVerdict,
  db?: Db,
): Promise<void> {
  await transition(id, "skipped", verdict ? { verdict } : {}, db);
}

// Override-without-erasure (ADR-028): records the deciding HITL in
// `overridden_by` and sets status `overridden`, but NEVER clears the prior
// `verdict` — the failed/stale evidence is retained.
export async function markGateOverridden(
  id: string,
  overriddenBy: string,
  db?: Db,
): Promise<void> {
  await transition(id, "overridden", { overriddenBy }, db);
}

// M16 §B: ingest an external_check report (CI/external system verdict). Finds
// the latest LIVE external_check gate row for (runId, gateId) and either flips it
// in place or — when a passed gate gets a report for a DIFFERENT commit and
// staleOnNewCommit is not disabled — re-stales the prior passed row and appends a
// fresh row. Records a `test_report` artifact carrying the inline report payload.
// All writes go through the passed db/tx handle so the route can compose this in
// its own transaction.
const LIVE_EXTERNAL_STATUSES = [
  "pending",
  "stale",
  "passed",
  "failed",
] as const;

// Thrown when no live external_check gate row exists at report time — e.g. a
// concurrent HITL override sealed the only row (status `overridden`, excluded
// from LIVE_EXTERNAL_STATUSES) between the route's reportability pre-check and
// this transaction. The route maps it to 404 "gate not reportable" instead of
// letting a bare Error surface as 500.
export class GateNotReportableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateNotReportableError";
  }
}

// CAS a live gate row from the EXACT status observed at SELECT time. Returns
// false when no row matched — i.e. a writer that does NOT take the run-row lock
// (HITL override → `overridden`, rework → `stale` via `markDownstreamStale`)
// changed the row between the live-row SELECT in `reportExternalGate` and this
// write. The route's run-row `FOR UPDATE` only serializes report-vs-report; this
// status guard is what stops a late external report from overwriting
// invalidated or sealed evidence on the gate row itself.
async function casLiveTransition(
  d: Db,
  id: string,
  fromStatus: GateResultStatus,
  toStatus: GateResultStatus,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const updated = await d
    .update(gateResults)
    .set({ status: toStatus, endedAt: new Date(), ...extra })
    .where(and(eq(gateResults.id, id), eq(gateResults.status, fromStatus)))
    .returning({ id: gateResults.id });

  return updated.length > 0;
}

export async function reportExternalGate(
  args: {
    runId: string;
    gateId: string;
    status: "passed" | "failed";
    verdict: GateVerdict;
    external?: { staleOnNewCommit?: boolean };
  },
  db?: Db,
): Promise<{ artifactId: string; gateResultId: string }> {
  const d = db ?? getDb();

  const liveRows: GateResult[] = await d
    .select()
    .from(gateResults)
    .where(
      and(
        eq(gateResults.runId, args.runId),
        eq(gateResults.gateId, args.gateId),
        eq(gateResults.kind, "external_check"),
        inArray(
          gateResults.status,
          LIVE_EXTERNAL_STATUSES as unknown as string[],
        ),
      ),
    )
    .orderBy(desc(gateResults.createdAt), desc(gateResults.id));

  const live = liveRows[0];

  if (!live) {
    throw new GateNotReportableError(
      `reportExternalGate: no live external_check gate for run ${args.runId} gate ${args.gateId}`,
    );
  }

  const staleOnNewCommit = args.external?.staleOnNewCommit !== false;
  const priorCommit = (live.verdict as GateVerdict | null)?.commitSha;
  const newCommit = args.verdict.commitSha;
  const supersede =
    live.status === "passed" &&
    staleOnNewCommit &&
    !!newCommit &&
    newCommit !== priorCommit;

  let gateResultId: string;

  if (supersede) {
    log.debug(
      {
        gateResultId: live.id,
        runId: args.runId,
        gateId: args.gateId,
        priorCommit,
        newCommit,
      },
      "external_check supersede-on-new-commit — re-staling prior passed result",
    );

    const restaled = await casLiveTransition(
      d,
      live.id,
      live.status,
      "stale",
      {},
    );

    if (!restaled) {
      throw new GateNotReportableError(
        `reportExternalGate: live external_check gate for run ${args.runId} gate ${args.gateId} changed concurrently before re-stale`,
      );
    }

    const fresh = await createGateResult({
      runId: args.runId,
      nodeAttemptId: live.nodeAttemptId,
      gateId: args.gateId,
      kind: "external_check",
      mode: live.mode as GateMode,
      status: args.status,
      verdict: args.verdict,
      db: d,
    });

    gateResultId = fresh.id;
  } else {
    // ADR-086: the CAS flip and its outbox emits commit in ONE transaction
    // (previously the emit rode the bare handle after the CAS — a crash
    // window). If `d` is already a transaction this nests as a savepoint;
    // the GateNotReportableError throw inside rolls back nothing but the
    // savepoint (the CAS matched zero rows anyway).
    await d.transaction(async (tx: Db) => {
      const moved = await casLiveTransition(
        tx,
        live.id,
        live.status,
        args.status,
        {
          verdict: args.verdict,
        },
      );

      if (!moved) {
        throw new GateNotReportableError(
          `reportExternalGate: live external_check gate for run ${args.runId} gate ${args.gateId} changed concurrently before report`,
        );
      }

      // The in-place flip is terminal (passed|failed) and won the CAS — emit
      // gate.decided here (the supersede branch above emits via createGateResult,
      // and its re-stale is non-terminal → no emit, so no double-emit).
      await emitWebhookEvent({
        db: tx,
        type: "gate.decided",
        projectId: await projectIdForRun(tx, args.runId),
        runId: args.runId,
        data: {
          gateId: args.gateId,
          kind: "external_check",
          mode: live.mode,
          status: args.status,
          nodeAttemptId: live.nodeAttemptId,
        },
      });

      if (args.status === "failed") {
        await emitDomainEvent({
          db: tx,
          kind: "gate.failed",
          projectId: await projectIdForRun(tx, args.runId),
          runId: args.runId,
          actor: { type: "system", id: null },
          payload: {
            runId: args.runId,
            gateId: args.gateId,
            gateKind: "external_check",
            gateResultId: live.id,
            nodeAttemptId: live.nodeAttemptId,
            blocking: live.mode === "blocking",
          },
        });
      }
    });

    gateResultId = live.id;
  }

  const { id: artifactId } = await recordArtifact(
    {
      id: randomUUID(),
      runId: args.runId,
      nodeAttemptId: live.nodeAttemptId,
      nodeId: null,
      kind: "test_report",
      producer: "gate",
      locator: { kind: "inline", text: JSON.stringify(args.verdict) },
    },
    d,
  );

  log.info(
    {
      gateId: args.gateId,
      runId: args.runId,
      status: args.status,
      commitSha: newCommit,
    },
    "external_check gate report ingested",
  );

  return { artifactId, gateResultId };
}

export async function getGateResultsForRun(
  runId: string,
  db?: Db,
): Promise<GateResult[]> {
  const d = db ?? getDb();

  const rows: GateResult[] = await d
    .select()
    .from(gateResults)
    .where(eq(gateResults.runId, runId))
    .orderBy(asc(gateResults.createdAt));

  return rows;
}

export async function getGateResultsForNodeAttempt(
  nodeAttemptId: string,
  db?: Db,
): Promise<GateResult[]> {
  const d = db ?? getDb();

  const rows: GateResult[] = await d
    .select()
    .from(gateResults)
    .where(eq(gateResults.nodeAttemptId, nodeAttemptId))
    .orderBy(asc(gateResults.createdAt));

  return rows;
}

// Returns true when every blocking gate for the node attempt is `passed` or
// `overridden` (no blocking gate is pending/running/failed/stale/skipped).
export async function blockingGatesSatisfied(
  nodeAttemptId: string,
  db?: Db,
): Promise<boolean> {
  const d = db ?? getDb();

  const rows: Array<{ status: GateResultStatus }> = await d
    .select({ status: gateResults.status })
    .from(gateResults)
    .where(
      and(
        eq(gateResults.nodeAttemptId, nodeAttemptId),
        eq(gateResults.mode, "blocking"),
      ),
    );

  return rows.every((r) => r.status === "passed" || r.status === "overridden");
}

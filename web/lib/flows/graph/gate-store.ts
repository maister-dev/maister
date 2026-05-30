import "server-only";

import type {
  GateResult,
  GateResultStatus,
  GateKind,
  GateVerdict,
} from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches step-runs.ts idiom).
const { gateResults } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "flow-gate-results",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type GateMode = "blocking" | "advisory";

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

  await db.insert(gateResults).values({
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
  });

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

async function transition(
  id: string,
  status: GateResultStatus,
  extra: Record<string, unknown>,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(gateResults)
    .set({ status, endedAt: new Date(), ...extra })
    .where(eq(gateResults.id, id));

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

// Override-without-erasure (ADR-024): records the deciding HITL in
// `overridden_by` and sets status `overridden`, but NEVER clears the prior
// `verdict` — the failed/stale evidence is retained.
export async function markGateOverridden(
  id: string,
  overriddenBy: string,
  db?: Db,
): Promise<void> {
  await transition(id, "overridden", { overriddenBy }, db);
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

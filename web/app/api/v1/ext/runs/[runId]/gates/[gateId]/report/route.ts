import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  GateNotReportableError,
  reportExternalGate,
} from "@/lib/flows/graph/gate-store";
import { resolveGateExternalConfig } from "@/lib/queries/readiness";
import { recordTokenAudit } from "@/lib/tokens/audit";
import { handleExt } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { gateResults, runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants — `.select`/`.transaction` on
// the union of node-postgres + better-sqlite3 handles is not call-compatible.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/[runId]/gates/[gateId]/report";
const SCOPE = "gates:report";

// A report cannot act on a run that has already finished — reject so a late CI
// report cannot re-stale an already-decided run.
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "Done",
  "Abandoned",
  "Crashed",
  "Failed",
]);

// Thrown inside the report transaction when the run-row re-read UNDER the lock
// shows the run finalized (or vanished) after the pre-check. The pre-check
// outside the transaction is only a fast path; this locked re-read is the
// authoritative guard, so a run that finalizes in the window before the lock is
// acquired cannot still receive a gate write. Carries the response shape so the
// catch maps it without re-deriving status.
class RunNotReportableError extends Error {
  readonly httpStatus: number;
  readonly code: "CONFLICT" | "NOT_FOUND";

  constructor(
    httpStatus: number,
    code: "CONFLICT" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "RunNotReportableError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

function isPostgres(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

type RouteParams = { params: Promise<{ runId: string; gateId: string }> };

// Inline-artifact size caps: every field below is serialized into the
// `test_report` artifact + the gate verdict jsonb, so an unbounded value from a
// token holder would bloat the DB. The whole schema reaches the same inline
// sink, so the sibling fields are capped together.
const MAX_PAYLOAD_BYTES = 65_536;

const bodySchema = z.object({
  status: z.enum(["passed", "failed"]),
  externalRunUrl: z.string().max(2048).nullish(),
  commitSha: z.string().max(200).nullish(),
  summary: z.string().max(4000).nullish(),
  payload: z
    .record(z.string(), z.unknown())
    .nullish()
    .refine(
      (p) => p == null || JSON.stringify(p).length <= MAX_PAYLOAD_BYTES,
      `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
    ),
});

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, gateId } = await params;
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      endpoint: ENDPOINT,
      method: "POST",
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      const raw = await req.json().catch(() => undefined);
      const parsed = bodySchema.safeParse(raw);

      if (!parsed.success) {
        return NextResponse.json(
          { code: "CONFIG", message: parsed.error.message },
          { status: 422 },
        );
      }

      const body = parsed.data;

      // Existence-hide: a run outside the token's project is indistinguishable
      // from a missing run (both 404).
      const runRows = await db
        .select({ id: runs.id, status: runs.status })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.projectId, ctx.projectId)));

      if (runRows.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "run not found" },
          { status: 404 },
        );
      }

      if (TERMINAL_RUN_STATUSES.has(runRows[0].status)) {
        return NextResponse.json(
          { code: "CONFLICT", message: "run is terminal" },
          { status: 409 },
        );
      }

      // Latest gate_result row for (runId, gateId). Reportable only when it is an
      // external_check gate that has not been sealed by an override.
      const gateRows = await db
        .select({ kind: gateResults.kind, status: gateResults.status })
        .from(gateResults)
        .where(
          and(eq(gateResults.runId, runId), eq(gateResults.gateId, gateId)),
        )
        .orderBy(desc(gateResults.createdAt))
        .limit(1);

      const gate = gateRows[0];

      if (
        !gate ||
        gate.kind !== "external_check" ||
        gate.status === "overridden"
      ) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "gate not reportable" },
          { status: 404 },
        );
      }

      const external = await resolveGateExternalConfig(runId, gateId, db);

      let artifactId: string;

      try {
        artifactId = await db.transaction(async (tx: typeof db) => {
          // Serialize concurrent reports for this run so a double-delivered CI
          // webhook for the SAME commit updates one row in place instead of
          // appending duplicate superseding rows. Postgres-only row lock;
          // SQLite's single-writer lock makes the bare path correct there.
          if (isPostgres()) {
            await tx.execute(
              sql`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`,
            );
          }

          // Authoritative existence + terminal guard, re-read under the lock:
          // the pre-check above goes stale if the run finalizes before this
          // transaction acquires the row lock, so re-validate here or a late
          // report mutates gate/artifact state on an already-decided run.
          const lockedRun = await tx
            .select({ id: runs.id, status: runs.status })
            .from(runs)
            .where(and(eq(runs.id, runId), eq(runs.projectId, ctx.projectId)));

          if (lockedRun.length === 0) {
            throw new RunNotReportableError(404, "NOT_FOUND", "run not found");
          }

          if (TERMINAL_RUN_STATUSES.has(lockedRun[0].status)) {
            throw new RunNotReportableError(409, "CONFLICT", "run is terminal");
          }

          const out = await reportExternalGate(
            {
              runId,
              gateId,
              status: body.status,
              verdict: {
                externalRunUrl: body.externalRunUrl ?? undefined,
                commitSha: body.commitSha ?? undefined,
                reporterTokenId: ctx.actor.tokenId,
                reportedAt: new Date().toISOString(),
                summary: body.summary ?? null,
                payload: body.payload ?? null,
              },
              external: { staleOnNewCommit: external.staleOnNewCommit },
            },
            tx,
          );

          await recordTokenAudit(
            {
              tokenId: ctx.actor.tokenId,
              projectId: ctx.actor.projectId,
              actorLabel: ctx.actor.actorLabel,
              scopeUsed: SCOPE,
              endpoint: ENDPOINT,
              method: "POST",
              result: "ok",
              statusCode: 200,
            },
            tx,
          );

          return out.artifactId;
        });
      } catch (err) {
        // The run finalized (or vanished) between the pre-check and the locked
        // re-read inside the transaction — return the authoritative 409/404 the
        // re-read decided, with the gate write rolled back.
        if (err instanceof RunNotReportableError) {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: err.httpStatus },
          );
        }

        // A concurrent override sealed the gate between the reportability
        // pre-check and this transaction — surface the same 404 the pre-check
        // would have, not a 500.
        if (err instanceof GateNotReportableError) {
          return NextResponse.json(
            { code: "NOT_FOUND", message: "gate not reportable" },
            { status: 404 },
          );
        }

        throw err;
      }

      return NextResponse.json(
        { gateId, status: body.status, artifactId },
        { status: 200 },
      );
    },
  );
}

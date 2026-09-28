import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { getDb } from "@/lib/db/client";
import { socialActorForToken } from "@/lib/tokens/verify";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { isLaunchedLineageRun } from "@/lib/evaluations/membership";
import {
  assertSyncEligible,
  syncRunTarget,
  type SyncActor,
} from "@/lib/runs/sync-target";
import {
  handleExt,
  httpStatusForExtCode,
  unknownLibrarianEffectResponse,
} from "@/lib/tokens/ext-handler";
import { recordRequiredTokenAudit } from "@/lib/tokens/ext-handler";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import { runProjectResolver } from "@/lib/tokens/run-project";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, workspaces } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/sync";
const SCOPE = "runs:sync";

const bodySchema = z
  .object({
    runId: z.string().min(1),
    strategy: z.enum(["rebase", "merge"]).optional(),
    agent: z.boolean().optional(),
    push: z.boolean().optional(),
    runnerId: z.string().min(1).max(255).optional(),
  })
  .strict();

type SyncBody = z.infer<typeof bodySchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const db = getDb() as Db;

  // AUTH FIRST — exactly like every sibling run-action route (promote, cancel,
  // rework, …): the token is verified, scoped, and AUDITED before this request's
  // body is ever touched. Keying `resolveProjectId` off a body field forced the
  // parse above `handleExt`, so a valid token sending a malformed body was
  // answered 422 with NO `token_audit_log` row — handleExt is that table's sole
  // writer. The project comes from the TOKEN; the run is then existence-hidden
  // against it below, which is the same boundary resolveProjectId was drawing.
  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      admitLibrarian: true,
      endpoint: ENDPOINT,
      method: "POST",
      requireScope: true,
      successAuditInWork: true,
      resolveLibrarianProjectId: async (handlerCtx) => {
        const parsed = bodySchema.safeParse(
          await req
            .clone()
            .json()
            .catch(() => null),
        );

        return parsed.success
          ? runProjectResolver(parsed.data.runId)(handlerCtx)
          : null;
      },
      idempotency: {
        kind: "run_sync",
        target: { route: "/api/v1/ext/runs/sync" },
        parseBody: async (request) => bodySchema.parse(await request.json()),
      },
      db,
    },
    async (ctx) => {
      let body: SyncBody;

      try {
        body = bodySchema.parse(await req.json());
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      // Existence-hide within the token's project: a run in ANOTHER project is
      // indistinguishable from one that does not exist. projectId is NEVER a
      // body field.
      const rows = await db
        .select({
          id: runs.id,
          status: runs.status,
          runKind: runs.runKind,
          parentRunId: runs.parentRunId,
          workspaceMode: runs.workspaceMode,
        })
        .from(runs)
        .where(and(eq(runs.id, body.runId), eq(runs.projectId, ctx.projectId)));

      if (rows.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "run not found" },
          { status: 404 },
        );
      }
      const [workspace] = await db
        .select({ removedAt: workspaces.removedAt })
        .from(workspaces)
        .where(eq(workspaces.runId, body.runId));

      if (!workspace) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: `workspace not found: ${body.runId}`,
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }
      try {
        assertSyncEligible(
          {
            status: rows[0].status,
            runKind: rows[0].runKind,
            parentRunId: rows[0].parentRunId,
            workspaceMode: rows[0].workspaceMode,
            isLaunchedLineage: await isLaunchedLineageRun(db, body.runId),
          },
          workspace,
        );
      } catch (err) {
        if (!isMaisterError(err)) throw err;

        return NextResponse.json(
          { code: err.code, message: err.message },
          { status: httpStatusForExtCode(err.code) },
        );
      }

      if (body.runnerId) {
        const catalog = await loadRunnerCatalog(db);

        if (!catalog.some((entry) => entry.id === body.runnerId)) {
          return NextResponse.json(
            { code: "CONFIG", message: `unknown runnerId: ${body.runnerId}` },
            { status: 422 },
          );
        }
      }

      // Use the CANONICAL mapper (every other polymorphic-actor ext route does).
      // A hand-rolled `agentId ? agent : user` mislabels an ownerless PROJECT
      // token — the default project-token shape — as `{user, id: null}`, so the
      // force-push ledger would claim a human did it and name nobody. The
      // canonical mapper resolves that case to `{system, null}`.
      const actor: SyncActor = socialActorForToken(ctx.actor);

      try {
        const result = await syncRunTarget({
          runId: body.runId,
          // ADR-181 C17: the ext surface keeps ADR-141's Review-only admission.
          admission: "review",
          strategy: body.strategy,
          agent: body.agent,
          push: body.push,
          runnerId: body.runnerId,
          actor,
          db,
        });

        const receipt = {
          runId: body.runId,
          attemptId: result.attemptId,
          outcome: result.outcome,
          behind: result.behind,
          pushed: result.pushed,
        };
        const statusCode = result.outcome === "agent_launched" ? 202 : 200;

        await db.transaction(async (tx: Db) => {
          await recordRequiredTokenAudit(
            {
              ...tokenAuditIdentity(ctx.actor),
              projectId: ctx.projectId,
              scopeUsed: SCOPE,
              endpoint: ENDPOINT,
              method: "POST",
              result: "ok",
              statusCode,
              operationId: ctx.operationId,
              operation: ctx.operationId
                ? { id: ctx.operationId, result: { statusCode, body: receipt } }
                : undefined,
            },
            tx,
          );
        });

        return NextResponse.json(receipt, { status: statusCode });
      } catch (err) {
        if (ctx.operationId) {
          return unknownLibrarianEffectResponse(
            {
              actor: ctx.actor,
              projectId: ctx.projectId,
              operationId: ctx.operationId,
              scopeLabel: SCOPE,
              endpoint: ENDPOINT,
              method: "POST",
              error: err,
            },
            db,
          );
        }
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: httpStatusForExtCode(err.code) },
          );
        }

        throw err;
      }
    },
  );
}

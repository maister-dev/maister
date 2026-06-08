import "server-only";

import type { TokenAuditInput } from "@/lib/tokens/audit";
import type { TokenActor } from "@/lib/tokens/verify";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { bumpTokenLastUsed, recordTokenAudit } from "@/lib/tokens/audit";
import { tokenHasScope } from "@/lib/tokens/scopes";
import {
  httpStatusForTokenAuth,
  TokenAuthError,
  verifyToken,
} from "@/lib/tokens/verify";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type ExtCtx = { actor: TokenActor; projectId: string };

const log = pino({
  name: "ext-token-handler",
  level: process.env.LOG_LEVEL ?? "info",
});

function errorFields(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack };
  }

  return { error: String(err) };
}

export async function recordRequiredTokenAudit(
  input: TokenAuditInput,
  db: Db,
): Promise<void> {
  try {
    await recordTokenAudit(input, db);
  } catch (err) {
    log.error(
      {
        ...errorFields(err),
        endpoint: input.endpoint,
        method: input.method,
        projectId: input.projectId,
        result: input.result,
        scopeUsed: input.scopeUsed,
        statusCode: input.statusCode,
        tokenId: input.tokenId,
      },
      "[FIX:token-audit-required] token audit write failed",
    );

    throw err;
  }
}

function bumpTokenLastUsedAsync(actor: TokenActor, db: Db): void {
  void bumpTokenLastUsed(actor.tokenId, db).catch((err: unknown) => {
    log.warn(
      {
        ...errorFields(err),
        projectId: actor.projectId,
        tokenId: actor.tokenId,
      },
      "[FIX:token-audit-required] token last-used update failed",
    );
  });
}

// Canonical MaisterError `code` → HTTP status for the /api/v1/ext/* surface, so
// sibling routes never diverge. `CONFIG` (a well-formed but unprocessable
// body/config) is 422 across the whole surface; `PRECONDITION`/`CONFLICT` are
// 409 (docs/error-taxonomy.md); a missing executor/supervisor is 503.
export function httpStatusForExtCode(code: string): number {
  switch (code) {
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "CONFIG":
      return 422;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    // Supervisor rejected the delivery at the protocol level — terminal upstream
    // failure, distinct from a generic 500.
    case "ACP_PROTOCOL":
      return 502;
    default:
      return 500;
  }
}

export async function handleExt(
  req: Request,
  opts: {
    slug?: string;
    scopeLabel: string;
    endpoint: string;
    method: string;
    db?: Db;
    // M16 §D: when set, `work` owns the success token_audit_log INSERT inside its
    // own db.transaction (so a rollback discards the audit too). handleExt then
    // SKIPS its success after-audit on a <400 response, but STILL writes the
    // failure audit on >=400 (work never reaches its in-tx audit on failure).
    successAuditInWork?: boolean;
    // Scope enforcement is default-on. A route can explicitly pass
    // requireScope:false only while preserving an older compatibility contract.
    // The 403 body never reveals which scopes the token holds.
    requireScope?: boolean;
  },
  work: (ctx: ExtCtx) => Promise<NextResponse>,
): Promise<NextResponse> {
  const d = opts.db ?? getDb();

  // 1. Extract bearer token.
  const authHeader = req.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/i.exec(authHeader);

  if (!match) {
    return NextResponse.json(
      { code: "UNAUTHENTICATED", message: "Missing bearer token" },
      { status: 401 },
    );
  }

  const presented = match[1];

  // 2. Verify token. Unidentifiable (invalid) → 401 with NO audit row.
  let actor: TokenActor;

  try {
    actor = await verifyToken(presented, d);
  } catch (err) {
    if (err instanceof TokenAuthError) {
      if (
        (err.kind === "expired" || err.kind === "revoked") &&
        err.tokenId &&
        err.projectId
      ) {
        // Identified failure: write audit row, then return 401.
        await recordRequiredTokenAudit(
          {
            tokenId: err.tokenId,
            projectId: err.projectId,
            actorLabel: "token:?",
            scopeUsed: opts.scopeLabel,
            endpoint: opts.endpoint,
            method: opts.method,
            result: "error",
            statusCode: 401,
          },
          d,
        );
      }

      return NextResponse.json(
        { code: "UNAUTHENTICATED", message: err.message },
        { status: 401 },
      );
    }

    throw err;
  }

  // 3. If slug provided: resolve project and validate token project ownership.
  if (opts.slug) {
    const rows = await d
      .select()
      .from(projects)
      .where(eq(projects.slug, opts.slug));
    const project = rows[0];

    if (!project || project.archivedAt || project.id !== actor.projectId) {
      await recordRequiredTokenAudit(
        {
          tokenId: actor.tokenId,
          projectId: actor.projectId,
          actorLabel: actor.actorLabel,
          scopeUsed: opts.scopeLabel,
          endpoint: opts.endpoint,
          method: opts.method,
          result: "error",
          statusCode: 404,
        },
        d,
      );

      return NextResponse.json(
        { code: "NOT_FOUND", message: "project not found" },
        { status: 404 },
      );
    }
  }

  // 3b. Scope enforcement. The 403 body MUST NOT leak which scopes the token holds.
  if (
    opts.requireScope !== false &&
    !tokenHasScope(actor.scopes, opts.scopeLabel)
  ) {
    await recordRequiredTokenAudit(
      {
        tokenId: actor.tokenId,
        projectId: actor.projectId,
        actorLabel: actor.actorLabel,
        scopeUsed: opts.scopeLabel,
        endpoint: opts.endpoint,
        method: opts.method,
        result: "error",
        statusCode: 403,
      },
      d,
    );
    bumpTokenLastUsedAsync(actor, d);

    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "insufficient scope" },
      { status: 403 },
    );
  }

  // 4. Run work().
  let response: NextResponse;

  try {
    response = await work({ actor, projectId: actor.projectId });
  } catch (err) {
    // Map TokenAuthError("wrong-project") thrown from authorize callback → 404.
    if (err instanceof TokenAuthError) {
      const status = httpStatusForTokenAuth(err.kind);
      const resp = NextResponse.json(
        { code: "NOT_FOUND", message: err.message },
        { status },
      );

      await recordRequiredTokenAudit(
        {
          tokenId: actor.tokenId,
          projectId: actor.projectId,
          actorLabel: actor.actorLabel,
          scopeUsed: opts.scopeLabel,
          endpoint: opts.endpoint,
          method: opts.method,
          result: "error",
          statusCode: status,
        },
        d,
      );
      bumpTokenLastUsedAsync(actor, d);

      return resp;
    }

    throw err;
  }

  // 5. Audit the result AFTER work resolves. When `successAuditInWork` is set,
  // `work` already wrote the success audit inside its own transaction — skip the
  // duplicate here on <400, but still write the failure audit on >=400.
  const statusCode = response.status;

  if (!(opts.successAuditInWork && statusCode < 400)) {
    await recordRequiredTokenAudit(
      {
        tokenId: actor.tokenId,
        projectId: actor.projectId,
        actorLabel: actor.actorLabel,
        scopeUsed: opts.scopeLabel,
        endpoint: opts.endpoint,
        method: opts.method,
        result: statusCode < 400 ? "ok" : "error",
        statusCode,
      },
      d,
    );
  }

  bumpTokenLastUsedAsync(actor, d);

  return response;
}

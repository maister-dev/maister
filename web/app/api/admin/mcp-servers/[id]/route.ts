import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  buildMcpServerFields,
  platformMcpPatchSchema,
  validateMcpServerDraft,
  type McpServerDraft,
} from "@/lib/mcp/mcp-form";
import { evaluateMcpReadiness } from "@/lib/mcp/readiness";
import { loadMcpReadinessContext } from "@/lib/mcp/readiness-host";
import { loadMcpUsageReferences } from "@/lib/mcp/usage";

const { platformMcpServers } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-admin-mcp-server",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-177: ONE body schema, built from the shared value grammar. It replaced a
// verbatim copy of the pre-ADR-177 key regex that lived here (and in three
// sibling route files). `trustStatus` is on it because platform trust is
// load-bearing at materialization (ADR-129).
const patchBodySchema = platformMcpPatchSchema.refine(
  (body) => Object.keys(body).length > 0,
  { message: "no fields to update" },
);

type RouteParams = { params: Promise<{ id: string }> };

function statusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, id: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { id, err: err instanceof Error ? err.message : String(err) },
    "platform MCP server mutation error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function notFound(id: string): NextResponse {
  return NextResponse.json(
    { code: "PRECONDITION", message: `MCP server not found: ${id}` },
    { status: 404 },
  );
}

async function parseJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function loadServer(
  db: any,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db
    .select()
    .from(platformMcpServers)
    .where(eq(platformMcpServers.id, id));

  return rows[0];
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { id } = await params;

  try {
    await requireGlobalRole("admin");

    const parsed = patchBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    const db = getDb() as any;
    const current = await loadServer(db, id);

    if (!current) return notFound(id);

    const nextDraft: McpServerDraft = {
      id,
      transport: (parsed.data.transport ??
        current.transport) as McpServerDraft["transport"],
      command: parsed.data.command ?? (current.command as string | null),
      args: parsed.data.args ?? (current.args as string[]),
      description:
        parsed.data.description ?? (current.description as string | null),
      env: parsed.data.env ?? (current.env as Record<string, string>),
      url: parsed.data.url ?? (current.url as string | null),
      headers:
        parsed.data.headers ?? (current.headers as Record<string, string>),
      bearerTokenEnv:
        parsed.data.bearerTokenEnv ?? (current.bearerTokenEnv as string | null),
      supportedAgents:
        parsed.data.supportedAgents ??
        (current.supportedAgents as McpServerDraft["supportedAgents"]),
      enabled: parsed.data.enabled ?? (current.enabled as boolean),
    };

    const validation = validateMcpServerDraft(nextDraft);

    if (!validation.ok) {
      throw new MaisterError(
        "CONFIG",
        `invalid MCP server: ${validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
      );
    }

    if (parsed.data.enabled === false) {
      const refs = await loadMcpUsageReferences(db, id);

      if (refs.length > 0) {
        throw new MaisterError(
          "CONFLICT",
          `cannot disable MCP server ${id}; referenced by ${refs.length} project materialization(s)`,
        );
      }
    }

    const fields = buildMcpServerFields(nextDraft);
    const readiness = evaluateMcpReadiness(
      fields,
      await loadMcpReadinessContext([fields], { serverId: id }),
    );

    await db
      .update(platformMcpServers)
      .set({
        ...fields,
        ...(parsed.data.trustStatus !== undefined
          ? { trustStatus: parsed.data.trustStatus }
          : {}),
        readinessStatus: readiness.status,
        readinessReasons: readiness.reasons,
        updatedAt: new Date(),
      })
      .where(eq(platformMcpServers.id, id));

    log.debug({ id }, "platform MCP server updated");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, id);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { id } = await params;

  try {
    await requireGlobalRole("admin");

    const db = getDb() as any;
    const current = await loadServer(db, id);

    if (!current) return notFound(id);

    const refs = await loadMcpUsageReferences(db, id);

    if (refs.length > 0) {
      log.info({ id, refs: refs.length }, "platform MCP server delete blocked");
      throw new MaisterError(
        "CONFLICT",
        `cannot delete MCP server ${id}; referenced by ${refs.length} project materialization(s)`,
      );
    }

    await db.delete(platformMcpServers).where(eq(platformMcpServers.id, id));

    log.info({ id }, "platform MCP server deleted");

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, id);
  }
}

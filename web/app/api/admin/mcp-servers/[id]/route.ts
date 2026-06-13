import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  buildMcpServerFields,
  validateMcpServerDraft,
  type McpServerDraft,
} from "@/lib/mcp/mcp-form";
import { evaluateMcpReadiness } from "@/lib/mcp/readiness";
import { loadMcpUsageReferences } from "@/lib/mcp/usage";
import { checkSupervisorDiagnostics } from "@/lib/supervisor-client";

const { platformMcpServers } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-admin-mcp-server",
  level: process.env.LOG_LEVEL ?? "info",
});

const envKeyRefSchema = z
  .string()
  .regex(
    /^(env:)?[A-Za-z_][A-Za-z0-9_]*$/,
    "secret must be env:NAME, not a value",
  );

const patchBodySchema = z
  .object({
    transport: z.enum(["stdio", "sse", "http"]).optional(),
    command: z.string().min(1).nullable().optional(),
    args: z.array(z.string()).optional(),
    envKeys: z.array(envKeyRefSchema).optional(),
    url: z.string().url().nullable().optional(),
    headerKeys: z.array(envKeyRefSchema).optional(),
    supportedAgents: z.array(z.enum(ADAPTER_IDS)).min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "no fields to update",
  });

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
      envKeys: parsed.data.envKeys ?? (current.envKeys as string[]),
      url: parsed.data.url ?? (current.url as string | null),
      headerKeys: parsed.data.headerKeys ?? (current.headerKeys as string[]),
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
    const diagnostics = await checkSupervisorDiagnostics();
    const readiness = evaluateMcpReadiness(fields, diagnostics);

    await db
      .update(platformMcpServers)
      .set({
        ...fields,
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

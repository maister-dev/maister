import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { buildCreateBody, validateMcpServerDraft } from "@/lib/mcp/mcp-form";

const { platformMcpServers } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-admin-mcp-servers",
  level: process.env.LOG_LEVEL ?? "info",
});

const envKeyRefSchema = z
  .string()
  .regex(
    /^(env:)?[A-Za-z_][A-Za-z0-9_]*$/,
    "secret must be env:NAME, not a value",
  );

// Flat shape (mirrors the permissive OpenAPI PlatformMcpServerBody + the PATCH
// route). Transport-specific requirements (stdio→command, sse/http→url) are
// enforced by validateMcpServerDraft; off-transport fields are normalized away
// by buildCreateBody so a stray field never persists.
const postBodySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/),
    transport: z.enum(["stdio", "sse", "http"]),
    // nullable: the client sends the normalized body (off-transport fields as
    // null); validateMcpServerDraft + buildCreateBody handle the nulls. Matches
    // the PATCH schema.
    command: z.string().min(1).nullable().optional(),
    args: z.array(z.string()).optional(),
    envKeys: z.array(envKeyRefSchema).optional(),
    url: z.string().url().nullable().optional(),
    headerKeys: z.array(envKeyRefSchema).optional(),
    supportedAgents: z.array(z.enum(ADAPTER_IDS)).min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

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

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "platform MCP server API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
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

export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const db = getDb() as any;
    const servers = await db.select().from(platformMcpServers);

    return NextResponse.json({ servers });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const parsed = postBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const validation = validateMcpServerDraft(parsed.data);

    if (!validation.ok) {
      throw new MaisterError(
        "CONFIG",
        `invalid MCP server: ${validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
      );
    }

    const values = buildCreateBody(parsed.data);
    const db = getDb() as any;

    // Race-safe create: rely on the id primary key, not a read-then-write
    // SELECT (mirrors the ADR-065 runner route). onConflictDoNothing + an empty
    // returning() yields the typed 409, never a raw 23505 -> 500.
    const inserted = await db
      .insert(platformMcpServers)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: platformMcpServers.id });

    if (inserted.length === 0) {
      throw new MaisterError(
        "CONFLICT",
        `MCP server already exists: ${parsed.data.id}`,
      );
    }

    log.debug({ id: parsed.data.id }, "platform MCP server created");

    return NextResponse.json({ ok: true, id: parsed.data.id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

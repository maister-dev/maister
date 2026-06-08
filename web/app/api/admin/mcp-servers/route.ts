import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { buildCreateBody } from "@/lib/mcp/mcp-form";

const { platformMcpServers } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-admin-mcp-servers",
  level: process.env.LOG_LEVEL ?? "info",
});

const idSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/);
// Secret key references only: `env:NAME` or a bare env NAME. Plaintext values
// are NEVER accepted, stored, or echoed (§7.2.1).
const envKeyRefSchema = z
  .string()
  .regex(
    /^(env:)?[A-Za-z_][A-Za-z0-9_]*$/,
    "secret must be env:NAME, not a value",
  );
const agentsSchema = z.array(z.enum(["claude", "codex"])).min(1);

const stdioMemberSchema = z
  .object({
    id: idSchema,
    transport: z.literal("stdio"),
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    envKeys: z.array(envKeyRefSchema).optional(),
    supportedAgents: agentsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const sseMemberSchema = z
  .object({
    id: idSchema,
    transport: z.literal("sse"),
    url: z.string().url(),
    headerKeys: z.array(envKeyRefSchema).optional(),
    supportedAgents: agentsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const httpMemberSchema = z
  .object({
    id: idSchema,
    transport: z.literal("http"),
    url: z.string().url(),
    headerKeys: z.array(envKeyRefSchema).optional(),
    supportedAgents: agentsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const mcpBodySchema = z.discriminatedUnion("transport", [
  stdioMemberSchema,
  sseMemberSchema,
  httpMemberSchema,
]);

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

    const parsed = mcpBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
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

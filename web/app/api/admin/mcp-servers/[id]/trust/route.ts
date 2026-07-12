import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// ADR-129 (W-E/T3.2): flip a platform MCP server's trust status. `id` is
// server-state (URL path). Trust is load-bearing: an `untrusted` server
// materializes for no project (recorded withheld `platform-untrusted`) but stays
// visible in every project hub. Live-join, so the flip takes effect next launch.

const { platformMcpServers } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-admin-mcp-trust",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z
  .object({
    trustStatus: z.enum(["untrusted", "trusted", "trusted_by_policy"]),
  })
  .strict();

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

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { id } = await params;

  try {
    await requireGlobalRole("admin");

    let body: unknown;

    try {
      body = await req.json();
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = bodySchema.safeParse(body);

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid trust body: ${parsed.error.message}`,
      );
    }

    const db = getDb() as any;
    const updated = await db
      .update(platformMcpServers)
      .set({ trustStatus: parsed.data.trustStatus, updatedAt: new Date() })
      .where(eq(platformMcpServers.id, id))
      .returning({ id: platformMcpServers.id });

    if (updated.length === 0) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `MCP server not found: ${id}` },
        { status: 404 },
      );
    }

    log.info(
      { id, to: parsed.data.trustStatus },
      "[api.admin.mcp] trust status updated",
    );

    return NextResponse.json({
      ok: true,
      trustStatus: parsed.data.trustStatus,
    });
  } catch (err) {
    if (isMaisterError(err)) {
      return NextResponse.json(
        { code: err.code, message: err.message },
        { status: statusForCode(err.code) },
      );
    }

    log.error(
      { id, err: err instanceof Error ? err.message : String(err) },
      "trust mutation error",
    );

    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}

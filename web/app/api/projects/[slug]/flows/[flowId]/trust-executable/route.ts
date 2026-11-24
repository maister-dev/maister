import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { packageErrorResponse } from "@/lib/packages/http";
import { trustExecutable } from "@/lib/flows/exec-trust";

// FIXME(any): dual drizzle-orm peer-dep variants (matches version-binding route).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-flows-trust-executable",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string; flowId: string }> };

// Flip exec_trust='trusted' for the enabled revision of a flow in this project
// and run any pending setup.sh. Idempotent.
// Executable trust is granted by an active platform administrator.
export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, flowId } = await params;

  try {
    const actor = await requireGlobalRole("admin");

    const db = getDb() as any;

    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    log.debug({ projectId: project.id, flowId }, "trust-executable POST");

    const result = await trustExecutable({
      projectId: project.id,
      flowId,
      actorUserId: actor.id,
      db,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return packageErrorResponse(err, `projects/${slug}/flows trust-executable`);
  }
}

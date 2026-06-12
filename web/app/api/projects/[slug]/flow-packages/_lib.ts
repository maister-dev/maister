import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import {
  requireActiveSession,
  requireGlobalRole,
  requireProjectAction,
} from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/runs/route.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-flow-packages",
  level: process.env.LOG_LEVEL ?? "info",
});

export function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "CONFIG":
      return 422;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "FLOW_INSTALL":
      return 502;
    default:
      return 500;
  }
}

export function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ slug, err: message }, "flow-packages route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

async function resolveProjectBySlug(
  slug: string,
): Promise<{ project: Record<string, any>; db: Db }> {
  const db = getDb() as unknown as {
    select: any;
    insert: any;
    update: any;
    delete: any;
  };

  const rows = await db.select().from(projects).where(eq(projects.slug, slug));
  const project = rows[0];

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  return { project, db };
}

// Auth-first, then resolve the project from the URL slug (server-state, never a
// body field), then enforce the managePackages project action. Returns the
// trusted project row + the db handle for downstream service calls.
export async function authorizeManagePackages(
  slug: string,
): Promise<{ project: Record<string, any>; db: Db }> {
  await requireActiveSession();

  const resolved = await resolveProjectBySlug(slug);

  await requireProjectAction(resolved.project.id, "managePackages");

  return resolved;
}

// Package trust is a PLATFORM-level decision (ADR-088: one operator decision
// per package revision fans trust onto every project attached to the same
// install), so the gate is the global admin role — project-scoped
// managePackages is implied for global admins but NOT sufficient on its own.
export async function authorizePackageTrust(
  slug: string,
): Promise<{ project: Record<string, any>; db: Db }> {
  await requireGlobalRole("admin");

  return resolveProjectBySlug(slug);
}

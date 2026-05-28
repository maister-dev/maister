import "server-only";

import { randomUUID } from "node:crypto";
import path from "node:path";

import { eq, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { loadProjectConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { upsertExecutorsFromConfig } from "@/lib/executors";
import { projectSlugSchema } from "@/lib/flow-paths";
import { installFlowPlugin } from "@/lib/flows";

// FIXME(any): dual drizzle-orm peer-dep variants (matches usage in
// web/app/api/runs/route.ts, web/lib/flows.ts, web/lib/executors.ts).
const { flows, projectMembers, projects } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-projects",
  level: process.env.LOG_LEVEL ?? "info",
});

// `dir` is body-controlled and flows into filesystem reads. Constrain it to an
// absolute path with no traversal segment (sink-invariant rule). The slug is
// derived server-side from project.name — never from the body.
const postBodySchema = z.object({
  dir: z
    .string()
    .min(1)
    .refine(
      (p) => p.startsWith("/") && !p.split("/").includes(".."),
      "dir must be an absolute path with no '..' segment",
    ),
});

function deriveSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const parsed = projectSlugSchema.safeParse(slug);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `cannot derive a valid kebab-case slug from project.name "${name}"`,
    );
  }

  return parsed.data;
}

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ err: message }, "POST /api/projects unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "CONFIG":
      return 422;
    case "FLOW_INSTALL":
      return 502;
    default:
      return 500;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof postBodySchema>;

  try {
    body = postBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      ),
    );
  }

  try {
    // Authn/authz BEFORE any filesystem or DB work. Throws
    // UNAUTHENTICATED/UNAUTHORIZED → 401/403.
    const admin = await requireGlobalRole("admin");

    const maisterYamlPath = path.join(body.dir, "maister.yaml");

    log.info({ dir: body.dir, userId: admin.id }, "register project start");

    // Phase (a): load + validate maister.yaml. On failure → CONFIG (422),
    // NO db row written.
    const config = await loadProjectConfig(maisterYamlPath);

    const slug = deriveSlug(config.project.name);
    const repoPath = config.project.repo_path;

    const db = getDb() as unknown as {
      select: any;
      insert: any;
      update: any;
      delete: any;
      transaction: any;
    };

    // Phase (b): slug / repo_path uniqueness. Collision → CONFLICT (409).
    const collisions = await db
      .select({ slug: projects.slug, repoPath: projects.repoPath })
      .from(projects)
      .where(or(eq(projects.slug, slug), eq(projects.repoPath, repoPath)));

    if (collisions.length > 0) {
      log.warn(
        { slug, repoPath, collisions: collisions.length },
        "register project collision",
      );
      throw new MaisterError(
        "CONFLICT",
        `project slug "${slug}" or repo_path "${repoPath}" already registered`,
      );
    }

    const projectId = randomUUID();

    // Phase (c): durable rows (project + executors) inside a transaction.
    // upsertExecutorsFromConfig opens its own transaction; the project row
    // must exist first (FK), so insert it before, then set the resolved
    // default_executor_id and the owner membership.
    await db.insert(projects).values({
      id: projectId,
      slug,
      name: config.project.name,
      repoPath,
      mainBranch: config.project.main_branch,
      branchPrefix: config.project.branch_prefix,
      maisterYamlPath,
    });

    const { defaultExecutorId } = await upsertExecutorsFromConfig({
      projectId,
      config,
      db,
    });

    await db
      .update(projects)
      .set({ defaultExecutorId })
      .where(eq(projects.id, projectId));

    await db.insert(projectMembers).values({
      id: randomUUID(),
      projectId,
      userId: admin.id,
      role: "owner",
    });

    log.info(
      { projectId, slug, repoPath },
      "register project rows persisted, installing flows",
    );

    // Phase (d): flow-install side-effects. Each install upserts its own
    // flows row + symlink. On failure → FLOW_INSTALL (502). Best-effort
    // compensation: clear any flows rows already written this call; the
    // project row may remain (admin can retry or archive).
    try {
      for (const flow of config.flows) {
        await installFlowPlugin({
          source: flow.source,
          version: flow.version,
          projectId,
          projectSlug: slug,
          flowId: flow.id,
          db,
        });
      }

      // Re-apply per-flow executor overrides now that flow rows exist (the
      // first upsert call warned + skipped them — see executors.ts doc).
      if (config.flows.some((f) => f.executor_override)) {
        await upsertExecutorsFromConfig({ projectId, config, db });
      }
    } catch (err) {
      log.error(
        { projectId, slug, err: (err as Error).message },
        "flow install failed during register",
      );
      await db
        .delete(flows)
        .where(eq(flows.projectId, projectId))
        .catch((delErr: unknown) =>
          log.error(
            { projectId, delErr: (delErr as Error).message },
            "compensating flows cleanup failed (manual cleanup may be required)",
          ),
        );

      if (isMaisterError(err)) throw err;
      throw new MaisterError(
        "FLOW_INSTALL",
        `flow install failed for project ${slug}: ${(err as Error).message}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    log.info({ projectId, slug, repoPath }, "register project success");

    return NextResponse.json({ slug, projectId }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

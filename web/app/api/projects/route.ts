import "server-only";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
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
const { projectMembers, projects } = schemaModule as unknown as Record<
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

// Postgres unique_violation (23505) — a concurrent registration of the same
// slug/repo_path that slipped past the read-time collision check (TOCTOU).
// The unique constraint is the real guard; translate it to a clean 409.
function isUniqueViolation(err: unknown): boolean {
  const e = err as {
    code?: string;
    cause?: { code?: string };
    message?: string;
  };

  if (e?.code === "23505" || e?.cause?.code === "23505") return true;

  return (
    typeof e?.message === "string" &&
    /duplicate key value|unique constraint/i.test(e.message)
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

    // Phase (c): project + executors + default-executor + owner membership in
    // ONE transaction (atomic — a crash mid-way leaves no owner-less project).
    // upsertExecutorsFromConfig calls `.transaction()` on the db it's given;
    // passing the outer `tx` nests via a savepoint, so it joins this unit.
    try {
      await db.transaction(async (tx: any) => {
        await tx.insert(projects).values({
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
          db: tx,
        });

        await tx
          .update(projects)
          .set({ defaultExecutorId })
          .where(eq(projects.id, projectId));

        await tx.insert(projectMembers).values({
          id: randomUUID(),
          projectId,
          userId: admin.id,
          role: "owner",
        });
      });
    } catch (err) {
      // Concurrent registration of the same slug/repo_path that beat the
      // read-time collision check → the unique constraint fires. Nothing was
      // committed (atomic), so just report the conflict.
      if (isUniqueViolation(err)) {
        throw new MaisterError(
          "CONFLICT",
          `project slug "${slug}" or repo_path "${repoPath}" already registered`,
        );
      }
      throw err;
    }

    log.info(
      { projectId, slug, repoPath },
      "register project rows persisted, installing flows",
    );

    // Phase (d): flow-install side-effects (clone + symlink + flows row), which
    // cannot live inside a DB transaction. On any failure, fully compensate so
    // registration is all-or-nothing and the same maister.yaml can be retried:
    //   1. delete the project row — FK ON DELETE CASCADE removes executors,
    //      flows, and project_members in one shot (frees the unique slug/repo).
    //   2. remove the slug-scoped artifact subtree this call may have created.
    // The shared, content-addressed system cache (~/.maister/flows/<id>@<sha>)
    // is intentionally left — it is reused across projects and across retries.
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
        "flow install failed during register — compensating",
      );

      // (1) DB rollback first — frees the unique slug/repo so a retry isn't
      // blocked by a 409. This is the critical compensation; log loudly if it
      // fails (the only path that leaves a stuck row).
      await db
        .delete(projects)
        .where(eq(projects.id, projectId))
        .catch((delErr: unknown) =>
          log.error(
            { projectId, slug, delErr: (delErr as Error).message },
            "CRITICAL: project rollback failed — manual cleanup required",
          ),
        );

      // (2) Disk cleanup — slug-scoped subtree only (matches installFlowPlugin's
      // default workspaceRoot = process.cwd()). Leftover symlinks are harmless
      // on retry (they re-resolve to the cache), so this is best-effort.
      const slugSubtree = path.join(process.cwd(), ".maister", slug);

      await rm(slugSubtree, { recursive: true, force: true }).catch(
        (rmErr: unknown) =>
          log.error(
            { slugSubtree, rmErr: (rmErr as Error).message },
            "compensating artifact cleanup failed",
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

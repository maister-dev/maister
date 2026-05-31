import "server-only";

import { randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import path from "node:path";

import { eq, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { loadPlatformMcpCapabilities, loadProjectConfig } from "@/lib/config";
import { upsertCapabilitiesFromConfig } from "@/lib/capabilities/catalog";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { upsertExecutorsFromConfig } from "@/lib/executors";
import { projectSlugSchema } from "@/lib/flow-paths";
import { installFlowPlugin } from "@/lib/flows";
import { withRegistrationLock } from "@/lib/registration-lock";
import {
  gitInit,
  resolveProjectSource,
  type ResolvedSource,
} from "@/lib/repo-source";

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

async function resolvePlatformMcpRegistryPath(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), ".mcp.json"),
    path.resolve(process.cwd(), "../.mcp.json"),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);

      return candidate;
    } catch {
      // Try the next conventional runtime cwd.
    }
  }

  return candidates[0];
}

// `repoUrl`/`target` are body-controlled and flow into filesystem reads + git
// clone. Deep path/URL validation lives in resolveProjectSource (sink-invariant
// rule). The slug is derived server-side from project.name — never from the body.
const postBodySchema = z
  .object({
    repoUrl: z.string().min(1).max(2048).optional(),
    target: z.string().min(1).max(4096).optional(),
  })
  .refine((b) => Boolean(b.repoUrl || b.target), "provide repoUrl or target");

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
    case "PASSWORD_CHANGE_REQUIRED":
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

    // Serialize the clone+register critical section so two concurrent
    // registrations can't race on the same derived target (TOCTOU).
    return await withRegistrationLock(async () => {
      const resolved = await resolveProjectSource(body);

      try {
        return await register(resolved, admin.id);
      } catch (err) {
        if (resolved.clonedByUs) {
          await rm(resolved.dir, { recursive: true, force: true }).catch(
            (rmErr) =>
              log.error(
                { dir: resolved.dir, rmErr: (rmErr as Error).message },
                "clone cleanup failed",
              ),
          );
        }
        throw err;
      }
    });
  } catch (err) {
    return errorResponse(err);
  }
}

async function register(
  resolved: ResolvedSource,
  adminId: string,
): Promise<NextResponse> {
  const maisterYamlPath = path.join(resolved.dir, "maister.yaml");

  log.info(
    { dir: resolved.dir, gitStatus: resolved.gitStatus, userId: adminId },
    "register project start",
  );

  // Phase (a): load + validate maister.yaml. On failure → CONFIG (422),
  // NO db row written.
  const config = await loadProjectConfig(maisterYamlPath);
  const platformMcps = await loadPlatformMcpCapabilities(
    await resolvePlatformMcpRegistryPath(),
  );

  const slug = deriveSlug(config.project.name);
  const repoPath = resolved.dir;

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
        repoUrl: resolved.repoUrl,
        provider: resolved.provider,
        mainBranch: config.project.main_branch,
        branchPrefix: config.project.branch_prefix,
        maisterYamlPath,
      });

      const { defaultExecutorId } = await upsertExecutorsFromConfig({
        projectId,
        config,
        db: tx,
      });

      await upsertCapabilitiesFromConfig({
        projectId,
        config: config.capabilities,
        platformMcps,
        db: tx,
      });

      await tx
        .update(projects)
        .set({ defaultExecutorId })
        .where(eq(projects.id, projectId));

      await tx.insert(projectMembers).values({
        id: randomUUID(),
        projectId,
        userId: adminId,
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
  // The clone we created (if any) is cleaned up by POST's outer catch.
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

    // Mutate the operator's directory LAST — only after the manifest is valid
    // and the project is otherwise committed. A bad maister.yaml / flow install
    // therefore never leaves a half-initialized git repo behind.
    if (resolved.gitStatus === "initialized") {
      await gitInit(resolved.dir);
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

    // (3) Revert the `git init` we ran above — remove only the `.git` we
    // created (gated on "initialized" so a pre-existing repo's .git is never
    // touched). On a flow-install failure init never ran, so this is a no-op.
    if (resolved.gitStatus === "initialized") {
      await rm(path.join(resolved.dir, ".git"), {
        recursive: true,
        force: true,
      }).catch((rmErr: unknown) =>
        log.error(
          { dir: resolved.dir, rmErr: (rmErr as Error).message },
          "compensating git-init cleanup failed",
        ),
      );
    }

    if (isMaisterError(err)) throw err;
    throw new MaisterError(
      "FLOW_INSTALL",
      `flow install failed for project ${slug}: ${(err as Error).message}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  log.info(
    {
      projectId,
      slug,
      repoPath,
      provider: resolved.provider,
      gitStatus: resolved.gitStatus,
    },
    "register project success",
  );

  return NextResponse.json(
    { slug, projectId, gitStatus: resolved.gitStatus },
    { status: 201 },
  );
}

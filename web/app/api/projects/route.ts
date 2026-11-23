import "server-only";

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { eq, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { loadProjectConfig, parseProjectConfig } from "@/lib/config";
import { syncProjectFlowRolesFromConfig } from "@/lib/assignments/service";
import { upsertCapabilitiesFromConfig } from "@/lib/capabilities/catalog";
import { serializeProjectConfig } from "@/lib/packages/yaml-writeback";
import { loadPlatformMcpCapabilitiesFromDb } from "@/lib/mcp/projection";
import { getDb } from "@/lib/db/client";
import { platformAcpRunners, projectMembers, projects } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { projectSlugSchema } from "@/lib/flow-paths";
import { registrationDependencies } from "@/lib/project-dependencies/registration";
import { enqueueProjectDependencies } from "@/lib/project-dependencies/store";
import {
  cleanRegistrationDirectory,
  createRegistrationDirectory,
  type OwnedDirectory,
} from "@/lib/registration-directory";
import { withRegistrationLock } from "@/lib/registration-lock";
import { deriveTaskKey, TASK_KEY_REGEX } from "@/lib/social/task-key";
import {
  gitInit,
  resolveProjectSource,
  type ResolvedSource,
} from "@/lib/repo-source";
import { DEFAULT_PUBLIC_BRANCH_TEMPLATE } from "@/lib/workbench-git/public-branch-name";
import { getDefaultBranch } from "@/lib/worktree";

const log = pino({
  name: "api-projects",
  level: process.env.LOG_LEVEL ?? "info",
});

// `repoUrl`/`target` are body-controlled and flow into filesystem reads + git
// clone. Deep path/URL validation lives in resolveProjectSource (sink-invariant
// rule). The slug is derived server-side from project.name — never from the body.
const postBodySchema = z
  .object({
    repoUrl: z.string().min(1).max(2048).optional(),
    target: z.string().min(1).max(4096).optional(),
    // The body name initializes runtime defaults only when the repo has no
    // maister.yaml; an existing manifest remains authoritative.
    name: z.string().min(1).max(200).optional(),
    // ADR-078 D2: body-controlled but regex allow-listed; names no path and
    // no cross-resource lookup — it becomes an attribute of the new project.
    taskKey: z
      .string()
      .regex(TASK_KEY_REGEX, "task key must match ^[A-Z][A-Z0-9]{1,9}$")
      .optional(),
    // ADR-093: onboarding mode — optional; absent infers clone (repoUrl) /
    // existing (target). "new" must be explicit (greenfield mkdir + git init).
    mode: z.enum(["clone", "existing", "new"]).optional(),
    // ADR-093: one-off HTTPS token (NEVER persisted) — answered to git's
    // credential prompt via askpass; only used for an http(s) clone.
    token: z.string().min(1).max(512).optional(),
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
    // ADR-093: surface the advisory clone { reason, detail } (when present) so
    // the UI can map reason -> a specific remediation. UI still branches on code.
    const details = err.details ?? {};

    return NextResponse.json(
      {
        code: err.code,
        message: err.message,
        ...("reason" in details ? { reason: details.reason } : {}),
        ...("detail" in details ? { detail: details.detail } : {}),
      },
      { status: httpStatusForCode(err.code) },
    );
  }
  log.error(
    { errorType: err instanceof Error ? err.name : "unknown" },
    "POST /api/projects unhandled error",
  );

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

// [FIX] Codex F3: only a genuinely missing file may be bootstrapped. A
// present-but-unreadable manifest (EACCES/EPERM) or transient I/O error fails
// fast as CONFIG; it must never be mistaken for an absent configuration.
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === "ENOENT" || code === "ENOTDIR") return false;

    throw new MaisterError(
      "CONFIG",
      `cannot stat ${p}: ${(err as Error).message}`,
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // [FIX] Codex F4: authenticate/authorize BEFORE parsing the body, so an
    // unauthenticated/unauthorized caller gets 401/403 — not a schema-specific
    // 422 that leaks the route contract before the auth gate.
    const admin = await requireGlobalRole("admin");

    let body: z.infer<typeof postBodySchema>;

    try {
      body = postBodySchema.parse(await req.json());
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      );
    }

    // Serialize the clone+register critical section so two concurrent
    // registrations can't race on the same derived target (TOCTOU).
    return await withRegistrationLock(async () => {
      const resolved = await resolveProjectSource(body);

      let accepted;

      try {
        accepted = await register(resolved, admin.id, body.taskKey, body.name);
      } catch (err) {
        if (resolved.ownedDirectory && !isUnknownCommit(err))
          await cleanRegistrationDirectory(resolved.ownedDirectory);
        throw err;
      }

      return NextResponse.json(accepted, { status: 201 });
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function isUnknownCommit(err: unknown): boolean {
  return (
    isMaisterError(err) && err.details?.reason === "registration_commit_unknown"
  );
}

async function lockRegistrationDecision(
  tx: Pick<ReturnType<typeof getDb>, "execute">,
  projectId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`,
  );
}

async function register(
  resolved: ResolvedSource,
  adminId: string,
  explicitTaskKey?: string,
  explicitName?: string,
): Promise<{
  projectId: string;
  slug: string;
  gitStatus: ResolvedSource["gitStatus"];
}> {
  const maisterYamlPath = path.join(resolved.dir, "maister.yaml");

  log.info(
    { dir: resolved.dir, gitStatus: resolved.gitStatus, userId: adminId },
    "register project start",
  );

  const manifestPresent = await pathExists(maisterYamlPath);
  const config = manifestPresent
    ? await loadProjectConfig(maisterYamlPath)
    : parseProjectConfig(
        serializeProjectConfig({
          name: explicitName?.trim() || path.basename(resolved.dir),
          mainBranch: await getDefaultBranch(resolved.dir),
          branchPrefix: "maister/",
          defaultRunnerId: null,
          promotionMode: null,
        }),
        "registration defaults",
      );

  log.info(
    { manifestPresent, dir: resolved.dir },
    "project registration configuration resolved",
  );
  const flowRoles = config.flow_roles ?? [];

  const slug = deriveSlug(config.project.name);
  const repoPath = resolved.dir;

  const db = getDb();
  const declarations = registrationDependencies(config);

  // ADR-078 D2: explicit key wins, else derive from the project name. A
  // collision (explicit OR derived) refuses registration — auto-uniquify
  // exists only in the migration backfill.
  const taskKey = explicitTaskKey ?? deriveTaskKey(config.project.name, slug);

  log.info(
    { slug, taskKey, source: explicitTaskKey ? "explicit" : "derived" },
    "task key assigned",
  );

  // Phase (b): slug / repo_path / task_key uniqueness. Collision → CONFLICT (409).
  const collisions = await db
    .select({
      slug: projects.slug,
      repoPath: projects.repoPath,
      taskKey: projects.taskKey,
    })
    .from(projects)
    .where(
      or(
        eq(projects.slug, slug),
        eq(projects.repoPath, repoPath),
        eq(projects.taskKey, taskKey),
      ),
    );

  if (collisions.length > 0) {
    const taskKeyTaken = collisions.some(
      (c: { taskKey: string }) => c.taskKey === taskKey,
    );

    log.warn(
      { slug, repoPath, taskKey, taskKeyTaken, collisions: collisions.length },
      "register project collision",
    );
    throw new MaisterError(
      "CONFLICT",
      taskKeyTaken
        ? `task key "${taskKey}" already registered`
        : `project slug "${slug}" or repo_path "${repoPath}" already registered`,
    );
  }

  const projectId = randomUUID();
  const defaultRunnerId = config.project.default_runner ?? null;

  if (defaultRunnerId) {
    const runnerRows = await db
      .select({
        id: platformAcpRunners.id,
        enabled: platformAcpRunners.enabled,
        readinessStatus: platformAcpRunners.readinessStatus,
      })
      .from(platformAcpRunners)
      .where(eq(platformAcpRunners.id, defaultRunnerId));
    const runner = runnerRows[0];

    if (!runner) {
      throw new MaisterError(
        "CONFIG",
        `project.default_runner "${defaultRunnerId}" is not configured as a platform runner`,
      );
    }
    if (runner.enabled === false || runner.readinessStatus !== "Ready") {
      throw new MaisterError(
        "CONFIG",
        `project.default_runner "${defaultRunnerId}" is not a ready platform runner`,
      );
    }
  }

  // Phase (c): project + runner binding + owner membership in
  // ONE transaction (atomic — a crash mid-way leaves no owner-less project).
  let gitDirectory: OwnedDirectory | undefined;
  let readyToCommit = false;

  try {
    if (resolved.gitStatus === "initialized") {
      gitDirectory = await createRegistrationDirectory(
        path.join(resolved.dir, ".git"),
      );
      await gitInit(resolved.dir);
    }

    await db.transaction(async (tx) => {
      await lockRegistrationDecision(tx, projectId);
      await tx.insert(projects).values({
        id: projectId,
        slug,
        name: config.project.name,
        taskQualificationBaseline: "required",
        taskQualificationOverride: config.project.task_qualification ?? null,
        repoPath,
        repoUrl: resolved.repoUrl,
        provider: resolved.provider,
        mainBranch: config.project.main_branch,
        branchPrefix: config.project.branch_prefix,
        // ADR-181 D6: same SET/CLEAR symmetry — an absent key is the default,
        // written explicitly so the row never depends on the column DEFAULT.
        publicBranchTemplate:
          config.project.public_branch_template ??
          DEFAULT_PUBLIC_BRANCH_TEMPLATE,
        maisterYamlPath: manifestPresent ? maisterYamlPath : null,
        // M18 (§3.4) SET/CLEAR symmetry: a present promotion.mode materializes
        // to projects.promotion_mode; an absent one resets to NULL (default)
        // in the same write — the launch resolver folds the local_merge default.
        promotionMode: config.project.promotion?.mode ?? null,
        defaultRunnerId,
        taskKey,
      });

      await syncProjectFlowRolesFromConfig({
        projectId,
        roles: flowRoles,
        db: tx,
      });

      await tx.insert(projectMembers).values({
        id: randomUUID(),
        projectId,
        userId: adminId,
        role: "owner",
      });

      await upsertCapabilitiesFromConfig({
        projectId,
        config: config.capabilities,
        platformMcps: await loadPlatformMcpCapabilitiesFromDb(tx),
        db: tx,
      });
      await enqueueProjectDependencies(tx, {
        projectId,
        actorUserId: adminId,
        declarations,
      });
      readyToCommit = true;
    });
  } catch (err) {
    if (readyToCommit) {
      // Wait for the original transaction to finish before interpreting a missing row.
      // A lost COMMIT acknowledgment can otherwise destroy a successfully accepted clone.
      try {
        const row = await db.transaction(async (tx) => {
          await lockRegistrationDecision(tx, projectId);
          const [accepted] = await tx
            .select({
              slug: projects.slug,
              repoPath: projects.repoPath,
              repoUrl: projects.repoUrl,
            })
            .from(projects)
            .where(eq(projects.id, projectId));

          return accepted;
        });

        if (row) {
          if (
            row.slug === slug &&
            row.repoPath === repoPath &&
            row.repoUrl === resolved.repoUrl
          )
            return { projectId, slug, gitStatus: resolved.gitStatus };
          throw new MaisterError(
            "CONFLICT",
            "Registration identity changed during recovery.",
          );
        }
      } catch (cause) {
        log.error(
          { projectId, slug },
          "registration outcome unavailable; retaining source",
        );
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "Could not verify the registration outcome. Check the project before retrying.",
          {
            cause: cause instanceof Error ? cause : undefined,
            details: { reason: "registration_commit_unknown" },
          },
        );
      }
    }
    if (gitDirectory) await cleanRegistrationDirectory(gitDirectory);
    if (isUniqueViolation(err)) {
      throw new MaisterError(
        "CONFLICT",
        `project slug "${slug}", repo_path "${repoPath}", or task key "${taskKey}" already registered`,
      );
    }
    throw err;
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

  return { slug, projectId, gitStatus: resolved.gitStatus };
}

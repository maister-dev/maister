import "server-only";

import type { AgentDefinitionCapabilityConfig } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import path from "node:path";

import { eq, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { requireGlobalRole } from "@/lib/authz";
import { buildCapabilityRefIds, loadProjectConfig } from "@/lib/config";
import { syncProjectFlowRolesFromConfig } from "@/lib/assignments/service";
import { installAndIngestCapabilityImports } from "@/lib/capabilities/import";
import { resolveTrust } from "@/lib/flows/trust";
import { attachPackage, installPackageRevision } from "@/lib/packages/attach";
import { packageVersionLabel } from "@/lib/packages/install";
import { loadPlatformMcpCapabilitiesFromDb } from "@/lib/mcp/projection";
import { syncFlowRunnerReconfigurationRequirements } from "@/lib/acp-runners/flow-reconfiguration";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { projectSlugSchema } from "@/lib/flow-paths";
import { installFlowPlugin } from "@/lib/flows";
import { withRegistrationLock } from "@/lib/registration-lock";
import { deriveTaskKey, TASK_KEY_REGEX } from "@/lib/social/task-key";
import {
  gitInit,
  resolveProjectSource,
  type ResolvedSource,
} from "@/lib/repo-source";
import { getDefaultBranch } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants (matches usage in
// web/app/api/runs/route.ts and web/lib/flows.ts).
const { flows, platformAcpRunners, projectMembers, projects } =
  schemaModule as unknown as Record<string, any>;

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
    // ADR-093: optional project name (the "what"). Authoritative only when the
    // repo has no maister.yaml; precedence is yaml.project.name > body.name >
    // basename(dir). Becomes a project attribute — validated via deriveSlug.
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

// [FIX] Codex F3: ONLY a genuinely missing file falls back to DB-default
// registration. A present-but-unreadable manifest (EACCES/EPERM) or a transient
// IO error MUST fail fast as CONFIG — never be silently treated as "absent",
// which would skip manifest parsing + declared flows/packages/setup.
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

      try {
        return await register(resolved, admin.id, body.taskKey, body.name);
      } catch (err) {
        if (resolved.clonedByUs || resolved.createdByUs) {
          await rm(resolved.dir, { recursive: true, force: true }).catch(
            (rmErr) =>
              log.error(
                { dir: resolved.dir, rmErr: (rmErr as Error).message },
                "source cleanup failed",
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

// ADR-093: register a project with NO maister.yaml on disk — from DB defaults,
// leaving the repo untouched (maisterYamlPath NULL). No flow/package/import
// install runs here (none declared) → there is no fetch-then-execute and no
// trust gate to clear. The manifest can be persisted later via
// POST /api/projects/{slug}/persist-config.
async function registerFromDbDefaults(
  resolved: ResolvedSource,
  adminId: string,
  explicitName?: string,
  explicitTaskKey?: string,
): Promise<NextResponse> {
  const name = explicitName?.trim() || path.basename(resolved.dir);
  const slug = deriveSlug(name);
  const repoPath = resolved.dir;
  const taskKey = explicitTaskKey ?? deriveTaskKey(name, slug);
  const mainBranch = await getDefaultBranch(resolved.dir);

  log.info(
    {
      slug,
      taskKey,
      mainBranch,
      source: explicitTaskKey ? "explicit" : "derived",
    },
    "register project (no maister.yaml) — DB defaults",
  );

  const db = getDb() as unknown as {
    select: any;
    insert: any;
    delete: any;
    transaction: any;
  };

  // Same slug / repo_path / task_key uniqueness as the manifest path.
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
      { slug, repoPath, taskKey, taskKeyTaken },
      "register project collision (DB defaults)",
    );
    throw new MaisterError(
      "CONFLICT",
      taskKeyTaken
        ? `task key "${taskKey}" already registered`
        : `project slug "${slug}" or repo_path "${repoPath}" already registered`,
    );
  }

  const projectId = randomUUID();

  // Project + owner membership in ONE transaction (atomic). maisterYamlPath is
  // NULL — the "config lives only in the DB" signal.
  try {
    await db.transaction(async (tx: any) => {
      await tx.insert(projects).values({
        id: projectId,
        slug,
        name,
        repoPath,
        repoUrl: resolved.repoUrl,
        provider: resolved.provider,
        mainBranch,
        branchPrefix: "maister/",
        maisterYamlPath: null,
        promotionMode: null,
        defaultRunnerId: null,
        taskKey,
      });

      await tx.insert(projectMembers).values({
        id: randomUUID(),
        projectId,
        userId: adminId,
        role: "owner",
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MaisterError(
        "CONFLICT",
        `project slug "${slug}", repo_path "${repoPath}", or task key "${taskKey}" already registered`,
      );
    }
    throw err;
  }

  // Mutate the operator's directory LAST — only after the row is committed. On
  // gitInit failure, roll the project row back so the unique slug/repo is freed
  // for a retry (mirrors the manifest path's compensation).
  if (resolved.gitStatus === "initialized") {
    try {
      await gitInit(resolved.dir);
    } catch (err) {
      await db
        .delete(projects)
        .where(eq(projects.id, projectId))
        .catch((delErr: unknown) =>
          log.error(
            { projectId, slug, delErr: (delErr as Error).message },
            "CRITICAL: project rollback failed — manual cleanup required",
          ),
        );
      throw err;
    }
  }

  log.info(
    {
      projectId,
      slug,
      repoPath,
      provider: resolved.provider,
      gitStatus: resolved.gitStatus,
    },
    "register project success (DB defaults)",
  );

  return NextResponse.json(
    { slug, projectId, gitStatus: resolved.gitStatus },
    { status: 201 },
  );
}

async function register(
  resolved: ResolvedSource,
  adminId: string,
  explicitTaskKey?: string,
  explicitName?: string,
): Promise<NextResponse> {
  const maisterYamlPath = path.join(resolved.dir, "maister.yaml");

  log.info(
    { dir: resolved.dir, gitStatus: resolved.gitStatus, userId: adminId },
    "register project start",
  );

  // ADR-093: maister.yaml is OPTIONAL at manual registration. A *missing*
  // manifest registers from DB defaults (repo untouched, maisterYamlPath NULL).
  // A present-but-invalid manifest still fails CONFIG below — only an absent
  // file takes the DB-default branch.
  if (!(await pathExists(maisterYamlPath))) {
    return registerFromDbDefaults(
      resolved,
      adminId,
      explicitName,
      explicitTaskKey,
    );
  }

  // Phase (a): load + validate maister.yaml. On failure → CONFIG (422),
  // NO db row written.
  const config = await loadProjectConfig(maisterYamlPath);
  const flowRoles = config.flow_roles ?? [];

  const slug = deriveSlug(config.project.name);
  const repoPath = resolved.dir;

  const db = getDb() as unknown as {
    select: any;
    insert: any;
    update: any;
    delete: any;
    transaction: any;
  };

  // M27/T-C3: platform MCPs come from the admin-managed platform_mcp_servers
  // table (ADR-067), projected as source='platform' capabilities — replacing
  // the legacy .mcp.json registry.
  const platformMcps = await loadPlatformMcpCapabilitiesFromDb(db);

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
    });
  } catch (err) {
    // Concurrent registration of the same slug/repo_path that beat the
    // read-time collision check → the unique constraint fires. Nothing was
    // committed (atomic), so just report the conflict.
    if (isUniqueViolation(err)) {
      throw new MaisterError(
        "CONFLICT",
        `project slug "${slug}", repo_path "${repoPath}", or task key "${taskKey}" already registered`,
      );
    }
    throw err;
  }

  log.info(
    { projectId, slug, repoPath },
    "register project rows persisted, installing flows",
  );
  const configuredRoleRefs =
    flowRoles.length > 0 ? flowRoles.map((role) => role.ref) : undefined;

  // Phase (d): flow-install side-effects (clone + symlink + flows row), which
  // cannot live inside a DB transaction. On any failure, fully compensate so
  // registration is all-or-nothing and the same maister.yaml can be retried:
  //   1. delete the project row — FK ON DELETE CASCADE removes flows and
  //      project_members in one shot (frees the unique slug/repo).
  //   2. remove the slug-scoped artifact subtree this call may have created.
  // The shared, content-addressed system cache (~/.maister/flows/<id>@<sha>)
  // is intentionally left — it is reused across projects and across retries.
  // The clone we created (if any) is cleaned up by POST's outer catch.
  try {
    // Complete capability registry (capabilities block + capability_imports),
    // derived from the manifest so the flow loader rejects node settings refs
    // unknown to this project at install time (M14 carve-b, T1.4). Inside the
    // try so any failure is compensated by the project rollback below.
    const capabilityRefIds = buildCapabilityRefIds(config);
    const platformRunnerRows = await db
      .select({ id: platformAcpRunners.id })
      .from(platformAcpRunners);
    const platformRunnerIds = new Set<string>(
      platformRunnerRows.map((row: { id: string }) => row.id),
    );

    for (const flow of config.flows) {
      const installed = await installFlowPlugin({
        source: flow.source,
        version: flow.version,
        projectId,
        projectSlug: slug,
        flowId: flow.id,
        roleRefs: configuredRoleRefs,
        capabilityRefIds,
        db,
      });
      const missing = await syncFlowRunnerReconfigurationRequirements({
        db,
        projectId,
        flowId: flow.id,
        flowRevisionId: installed.revisionId,
        manifest: installed.manifest,
        platformRunnerIds,
      });

      if (missing.length > 0) {
        await db
          .update(flows)
          .set({ enablementState: "Disabled", updatedAt: new Date() })
          .where(eq(flows.id, installed.flowRowId));
        log.warn(
          {
            projectId,
            flowId: flow.id,
            flowRowId: installed.flowRowId,
            missingRunnerTargets: missing.length,
          },
          "flow attachment disabled until ACP runner targets are reconfigured",
        );
      }
    }

    // ADR-088: packages[] bootstrap — the SAME platform-install + project-
    // attach pipeline as the UI surface (package_installs row + attachment
    // group + FK links + mcp/restriction ingestion), so bootstrapped packages
    // are visible on the packages tab and manageable (detach/upgrade/trust)
    // after registration. Failures unwind via the SAME compensation below.
    const packageCapabilityDerived: AgentDefinitionCapabilityConfig[] = [];

    for (const pkg of config.packages) {
      const installedPkg = await installPackageRevision({
        source: pkg.source,
        version: pkg.version,
        path: pkg.path,
        trustStatus: resolveTrust(pkg.source),
        db,
      });
      const attached = await attachPackage({
        projectId,
        projectSlug: slug,
        packageInstallId: installedPkg.id,
        roleRefs: configuredRoleRefs,
        db,
      });

      if (attached === null) {
        throw new MaisterError(
          "FLOW_INSTALL",
          `package install ${installedPkg.id} disappeared during registration`,
        );
      }

      const memberVersionLabel = packageVersionLabel(installedPkg.versionLabel);

      for (const cap of installedPkg.manifest.spec.capabilities) {
        packageCapabilityDerived.push({
          id: cap.id,
          kind: "agent_definition",
          label: cap.id,
          source: "flow-package",
          version: memberVersionLabel,
          revision: installedPkg.resolvedRevision,
          agents: [...ADAPTER_IDS],
          enforceability: "instructed",
          selected_by_default: true,
        });
      }

      log.info(
        {
          projectId,
          packageId: pkg.id,
          packageName: installedPkg.name,
          revision: installedPkg.resolvedRevision.slice(0, 12),
          attachmentId: attached.attachmentId,
          flowIds: attached.memberFlows.map((f) => f.flowRowId),
        },
        "packages[] entry installed + attached",
      );

      for (const installed of attached.memberFlows) {
        const missing = await syncFlowRunnerReconfigurationRequirements({
          db,
          projectId,
          flowId: installed.manifest.name,
          flowRevisionId: installed.revisionId,
          manifest: installed.manifest,
          platformRunnerIds,
        });

        if (missing.length > 0) {
          await db
            .update(flows)
            .set({ enablementState: "Disabled", updatedAt: new Date() })
            .where(eq(flows.id, installed.flowRowId));
          log.warn(
            {
              projectId,
              packageId: pkg.id,
              flowRowId: installed.flowRowId,
              missingRunnerTargets: missing.length,
            },
            "package flow attachment disabled until ACP runner targets are reconfigured",
          );
        }
      }
    }

    // Install git-pinned capability imports (clone → trust → trust-gated setup)
    // and ingest the resolved set into capability_records ALONGSIDE the
    // capabilities block in one SET/CLEAR upsert — package-derived bundle
    // entries (ADR-088) ride the same symmetric write. Lives here (not in the
    // phase-c tx) because each import is a clone side-effect FK-ing the
    // committed project row; a failure is compensated by the project rollback
    // below.
    await installAndIngestCapabilityImports({
      config,
      projectId,
      platformMcps,
      additionalImportDerived: packageCapabilityDerived,
      db,
    });

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

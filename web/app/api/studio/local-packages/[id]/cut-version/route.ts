import "server-only";

import { rm } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  assertPackageCuttable,
  exportWorkingDir,
  getLocalPackage,
  stampLastCutInstall,
} from "@/lib/local-packages/service";
import { attachPackage, installPackageRevision } from "@/lib/packages/attach";

// FIXME(any): dual drizzle-orm peer-dep variants (matches sibling routes).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api/studio/local-packages/[id]/cut-version",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({ attachToProjectId: z.string().min(1).optional() })
  .strict();

// `id` is a url-param (→ server row → working_dir). `attachToProjectId` is a
// BODY id; requireProjectAction(member) validates membership against it before
// any attach. The cut is two-phase: the irreversible git/export + content-
// addressed install happen BEFORE the durable stamp/attach.
//
// Crash windows (each recoverable, no half-registered state):
//   (a) export done, install not started → only an orphan tmp dir (GC'd; the
//       finally rm covers the happy path). NOTHING persisted.
//   (b) install done, stamp not written → an immutable, content-addressed
//       package_installs row exists but local_packages.last_cut_install_id is
//       stale; re-running cut-version reuses the identical install (idempotent
//       by digest) and stamps. No duplicate, no leak.
//   (c) stamp done, attach pending → the package is cut + recorded; the attach
//       simply did not happen. Re-run with attachToProjectId, or attach later.
//       attachPackage is itself one-tx (its own crash windows apply).
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  let exportDir: string | null = null;

  try {
    const user = await requireGlobalRole("member");
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    // Cut gate (ADR-105 D3): publish ONLY a clean, committed, fully-valid tree.
    // Uncommitted WIP or an invalid committed baseline is refused (PRECONDITION)
    // before any irreversible export/install.
    await assertPackageCuttable(pkg);

    // Gate the optional attach BEFORE any irreversible side-effect: an
    // inaccessible attach target must not leave a cut install behind.
    let attachTarget: { id: string; slug: string; repoPath: string } | null =
      null;

    if (parsed.data.attachToProjectId) {
      await requireProjectAction(
        parsed.data.attachToProjectId,
        "manageLocalPackages",
      );
      const db = getDb() as unknown as { select: any };
      const [row] = await db
        .select({
          id: projects.id,
          slug: projects.slug,
          repoPath: projects.repoPath,
          archivedAt: projects.archivedAt,
        })
        .from(projects)
        .where(eq(projects.id, parsed.data.attachToProjectId));

      if (!row || row.archivedAt) {
        return notFoundResponse("attach target project not found");
      }
      attachTarget = { id: row.id, slug: row.slug, repoPath: row.repoPath };
    }

    // Phase 1 (BEFORE the durable writes): clean-export the working dir minus
    // `.git`, then install it content-addressed (immutable local-<digest>).
    exportDir = await exportWorkingDir(pkg);
    const install = await installPackageRevision({
      source: exportDir,
      version: "local",
      trustStatus: "trusted_by_policy",
    });

    // Phase 2 (the durable mark): stamp the cut + optionally attach.
    await stampLastCutInstall(pkg.id, install.id);

    let attachmentId: string | undefined;

    if (attachTarget) {
      const attached = await attachPackage({
        projectId: attachTarget.id,
        projectSlug: attachTarget.slug,
        packageInstallId: install.id,
        workspaceRoot: attachTarget.repoPath,
      });

      attachmentId = attached?.attachmentId;
    }

    log.info(
      {
        id,
        installId: install.id,
        versionLabel: install.versionLabel,
        attachedTo: attachTarget?.id,
        createdBy: user.id,
      },
      "local package version cut",
    );

    return NextResponse.json(
      {
        installId: install.id,
        versionLabel: install.versionLabel,
        attachmentId,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(
      err,
      log,
      "studio/local-packages/[id]/cut-version POST",
    );
  } finally {
    if (exportDir) {
      await rm(exportDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

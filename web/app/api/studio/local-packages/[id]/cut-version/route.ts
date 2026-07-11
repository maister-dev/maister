import "server-only";

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
  getLocalPackage,
} from "@/lib/local-packages/service";
import {
  cutLocalPackageVersion,
  listAdoptTargetProjects,
  type AdoptTargetProject,
} from "@/lib/local-packages/versions";
import { attachPackage, upgradeAttachment } from "@/lib/packages/attach";
import { isMaisterError, MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches sibling routes).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api/studio/local-packages/[id]/cut-version",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    attachToProjectId: z.string().min(1).optional(),
    adoptInProjectIds: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict();

// `id` is a url-param (→ server row → working_dir). `attachToProjectId` is a
// BODY id; requireProjectAction(member) validates membership against it before
// any attach. `adoptInProjectIds` (ADR-129 §c) are BODY ids; EACH is validated
// pre-cut via requireProjectAction(manageLocalPackages) + server-state
// eligibility (the project's current attachment must point at a cut of THIS
// package — upstream-pinned projects → 409, nothing mutated). The cut is
// two-phase: the irreversible git/export + content-addressed install happen
// BEFORE the durable stamp/attach (see cutLocalPackageVersion). The cut
// records the source-link provenance (source_local_package_id +
// source_commit_sha) so a project's attached cut can detect a newer version
// at launch (M39 Stream B, ADR-107).
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
//   (d) cut done, adopts partial (ADR-129) → the cut is NEVER rolled back;
//       each adopt is an idempotent per-project after-write
//       (upgradeAttachment), reported per-project in `adoptions[]` and
//       re-runnable from the dialog (re-adopting an already-adopted project
//       is a no-op upgrade to the same install).
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
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

    // Gate EVERY adopt id BEFORE the irreversible cut (ADR-129): per-project
    // authz first (an inaccessible id must not leak eligibility state), then
    // server-state eligibility — the id's current attachment must be a cut of
    // THIS package. Any refusal → nothing mutated.
    const adoptTargets: AdoptTargetProject[] = [];

    if (parsed.data.adoptInProjectIds?.length) {
      const requestedIds = [...new Set(parsed.data.adoptInProjectIds)];
      const eligible = await listAdoptTargetProjects([id]);
      const eligibleById = new Map(eligible.map((t) => [t.projectId, t]));

      for (const projectId of requestedIds) {
        await requireProjectAction(projectId, "manageLocalPackages");
        const target = eligibleById.get(projectId);

        if (!target) {
          throw new MaisterError(
            "CONFLICT",
            `project ${projectId} is not eligible to adopt: its attachment does not point at a cut of this package`,
          );
        }
        adoptTargets.push(target);
      }
    }

    // Phase 1+2: clean-export → content-addressed install WITH the source link →
    // stamp last_cut_install_id (the durable cut marker). cutLocalPackageVersion
    // owns the tmp export dir + its cleanup.
    const cut = await cutLocalPackageVersion(pkg);

    let attachmentId: string | undefined;

    if (attachTarget) {
      const attached = await attachPackage({
        projectId: attachTarget.id,
        projectSlug: attachTarget.slug,
        packageInstallId: cut.installId,
        workspaceRoot: attachTarget.repoPath,
      });

      attachmentId = attached?.attachmentId;
    }

    // Post-cut adopts: per-project after-writes, failures reported — the cut
    // above is never rolled back (crash window (d)).
    let adoptions:
      | { projectId: string; status: "adopted" | "failed"; error?: string }[]
      | undefined;

    if (parsed.data.adoptInProjectIds !== undefined) {
      adoptions = [];
      for (const target of adoptTargets) {
        try {
          await upgradeAttachment({
            projectId: target.projectId,
            projectSlug: target.slug,
            attachmentId: target.attachmentId,
            packageInstallId: cut.installId,
            workspaceRoot: target.repoPath,
          });
          adoptions.push({ projectId: target.projectId, status: "adopted" });
        } catch (err) {
          adoptions.push({
            projectId: target.projectId,
            status: "failed",
            error: isMaisterError(err)
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err),
          });
        }
      }
    }

    log.info(
      {
        id,
        installId: cut.installId,
        versionLabel: cut.versionLabel,
        attachedTo: attachTarget?.id,
        adopted: adoptions?.filter((a) => a.status === "adopted").length,
        adoptFailed: adoptions?.filter((a) => a.status === "failed").length,
        createdBy: user.id,
      },
      "local package version cut",
    );

    return NextResponse.json(
      {
        installId: cut.installId,
        versionLabel: cut.versionLabel,
        attachmentId,
        ...(adoptions !== undefined ? { adoptions } : {}),
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(
      err,
      log,
      "studio/local-packages/[id]/cut-version POST",
    );
  }
}

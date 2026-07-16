import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalPackage } from "@/lib/db/schema";

import { rm } from "node:fs/promises";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import pino from "pino";

import { gitHeadSha } from "./git";
import {
  acquireWorkingDirLock,
  readLockState,
  releaseWorkingDirLock,
} from "./lock";
import {
  assertPackageCuttable,
  exportWorkingDir,
  stampLastCutInstall,
} from "./service";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  installPackageRevision,
  upgradeAttachment,
} from "@/lib/packages/attach";

const log = pino({
  name: "local-packages/versions",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = NodePgDatabase<typeof schema>;

function resolveDb(db?: Db): Db {
  return db ?? (getDb() as unknown as Db);
}

const pa = schema.projectPackageAttachments;
const pi = schema.packageInstalls;
const lp = schema.localPackages;

export type VersionAdoptOption =
  | "keep"
  | "adopt"
  | "cut_and_adopt"
  // ADR-132: ephemeral per-run pin to the newest cut — the attachment is
  // never advanced; offered exactly when `adopt` is offered.
  | "try_once";

// The launch-time "version available" state for ONE attached centralized package.
export type AvailablePackageVersion = {
  /** The project's currently-attached cut (the pin) — the `packageVersions` map key. */
  packageInstallId: string;
  attachmentId: string;
  packageName: string;
  localPackageId: string;
  localPackageName: string;
  currentVersionLabel: string;
  /** The package's newest cut, when it is newer than the pin (else null). */
  newerCutInstallId: string | null;
  newerVersionLabel: string | null;
  /** The local package has committed edits beyond its newest cut. */
  hasUncutEdits: boolean;
  /** Always includes `keep`; `adopt`/`cut_and_adopt` only when applicable. */
  offeredOptions: VersionAdoptOption[];
};

// The irreversible cut of a centralized local package (M39 Stream B): clean-export
// the working dir, install it content-addressed WITH the source-link provenance,
// then stamp `last_cut_install_id`. The caller MUST have passed
// `assertPackageCuttable` first (clean, valid tree). Reused by the cut-version
// route and the launch-time `cut_and_adopt` path.
export async function cutLocalPackageVersion(
  pkg: LocalPackage,
  opts?: { db?: Db },
): Promise<{ installId: string; versionLabel: string }> {
  const lockToken = await acquireWorkingDirLock(pkg.id, opts?.db);

  try {
    let headSha: string | null = null;

    try {
      headSha = await gitHeadSha(pkg.workingDir);
    } catch (err) {
      log.warn(
        { slug: pkg.slug, err: (err as Error).message },
        "gitHeadSha failed at cut — source_commit_sha omitted",
      );
    }

    const exportDir = await exportWorkingDir(pkg);

    try {
      const install = await installPackageRevision({
        source: exportDir,
        version: "local",
        trustStatus: "trusted_by_policy",
        sourceLocalPackageId: pkg.id,
        ...(headSha ? { sourceCommitSha: headSha } : {}),
        db: opts?.db,
      });

      await stampLastCutInstall(pkg.id, install.id, opts?.db);

      return { installId: install.id, versionLabel: install.versionLabel };
    } finally {
      await rm(exportDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  } finally {
    await releaseWorkingDirLock(pkg.id, lockToken, opts?.db);
  }
}

// ADR-132 §c (T16): the projects eligible for "adopt in attached projects
// now" at cut time — those whose CURRENT attachment for this package points
// at a cut of THIS local package (`package_installs.source_local_package_id`
// = the package id). Projects attached to the UPSTREAM install of the same
// name are deliberately absent: they are never offered and never silently
// migrated. Archived projects are excluded. Batch-shaped so the Studio list
// page can feed every row's dialog in one query.
export type AdoptTargetProject = {
  localPackageId: string;
  projectId: string;
  slug: string;
  name: string;
  repoPath: string;
  attachmentId: string;
};

// ADR-132 §d (T20): the sync dialog's target set for a fork with lineage —
// already-installed OTHER versions of the lineage package (same name +
// sourceUrl), plus the lineage source's discovered-but-uninstalled tags for
// the "install & sync" path. Null when the lineage row is gone (the
// divergence panel already renders that degradation). Client-safe.
export type SyncTargetOptions = {
  targets: { installId: string; versionLabel: string }[];
  source: { sourceId: string; packageName: string; tags: string[] } | null;
};

export async function listSyncTargets(
  pkg: LocalPackage,
  db?: Db,
): Promise<SyncTargetOptions | null> {
  if (!pkg.sourceInstallId) return null;
  const d = resolveDb(db);
  const [lineage] = await d
    .select({ name: pi.name, sourceUrl: pi.sourceUrl })
    .from(pi)
    .where(eq(pi.id, pkg.sourceInstallId));

  if (!lineage) return null;

  const siblings = await d
    .select({ id: pi.id, versionLabel: pi.versionLabel })
    .from(pi)
    .where(
      and(
        eq(pi.name, lineage.name),
        eq(pi.sourceUrl, lineage.sourceUrl),
        eq(pi.packageStatus, "Installed"),
      ),
    );
  const targets = siblings
    .filter((s) => s.id !== pkg.sourceInstallId)
    .map((s) => ({ installId: s.id, versionLabel: s.versionLabel }));

  const [sourceRow] = await d
    .select({
      id: schema.packageSources.id,
      discovered: schema.packageSources.discovered,
    })
    .from(schema.packageSources)
    .where(eq(schema.packageSources.url, lineage.sourceUrl));
  let source: SyncTargetOptions["source"] = null;

  if (sourceRow) {
    const entry = (sourceRow.discovered ?? []).find(
      (e) => e.name === lineage.name,
    );
    const known = new Set([
      ...siblings.map((s) => s.versionLabel),
      pkg.sourceRef ?? "",
    ]);
    const tags = (
      entry?.tags.length
        ? entry.tags
        : entry?.digestVersionLabel
          ? [entry.digestVersionLabel]
          : []
    ).filter((tag) => !known.has(tag));

    source = { sourceId: sourceRow.id, packageName: lineage.name, tags };
  }

  return { targets, source };
}

// The package's OWN cuts (newest first) — the divergence drawer's picker
// (ADR-132 T18). Client-safe pair only; installed paths stay server-side.
export async function listPackageCuts(
  localPackageId: string,
  db?: Db,
): Promise<{ installId: string; versionLabel: string }[]> {
  const d = resolveDb(db);
  const rows = await d
    .select({
      installId: pi.id,
      versionLabel: pi.versionLabel,
      createdAt: pi.createdAt,
    })
    .from(pi)
    .where(
      and(
        eq(pi.sourceLocalPackageId, localPackageId),
        eq(pi.packageStatus, "Installed"),
      ),
    );

  return rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => ({ installId: r.installId, versionLabel: r.versionLabel }));
}

export async function listAdoptTargetProjects(
  localPackageIds: string[],
  db?: Db,
): Promise<AdoptTargetProject[]> {
  if (localPackageIds.length === 0) return [];
  const d = resolveDb(db);
  const p = schema.projects;

  return d
    .select({
      localPackageId: pi.sourceLocalPackageId,
      projectId: p.id,
      slug: p.slug,
      name: p.name,
      repoPath: p.repoPath,
      attachmentId: pa.id,
    })
    .from(pa)
    .innerJoin(
      pi,
      and(
        eq(pi.id, pa.packageInstallId),
        inArray(pi.sourceLocalPackageId, localPackageIds),
      ),
    )
    .innerJoin(p, and(eq(p.id, pa.projectId), isNull(p.archivedAt)))
    .then((rows) =>
      rows.map((r) => ({ ...r, localPackageId: r.localPackageId as string })),
    );
}

// Detect, for a project's attached CENTRALIZED packages (those whose pinned
// install carries a `source_local_package_id`), whether a newer cut and/or uncut
// Studio edits are available — the launch-time prompt set. Read-only. One
// `git rev-parse HEAD` per centralized package.
export async function detectAvailablePackageVersions(opts: {
  projectId: string;
  db?: Db;
}): Promise<AvailablePackageVersion[]> {
  const db = resolveDb(opts.db);

  const rows = await db
    .select({
      attachmentId: pa.id,
      packageName: pa.packageName,
      pinInstallId: pa.packageInstallId,
      pinVersionLabel: pi.versionLabel,
      pinCommitSha: pi.sourceCommitSha,
      localPackageId: pi.sourceLocalPackageId,
    })
    .from(pa)
    .innerJoin(pi, eq(pi.id, pa.packageInstallId))
    .where(eq(pa.projectId, opts.projectId));

  const out: AvailablePackageVersion[] = [];

  for (const row of rows) {
    if (!row.localPackageId) continue; // not a centralized cut

    const [lpRow] = await db
      .select()
      .from(lp)
      .where(eq(lp.id, row.localPackageId));

    if (!lpRow || lpRow.status !== "active") continue;

    const newestCutId = lpRow.lastCutInstallId;
    const hasNewerCut = newestCutId != null && newestCutId !== row.pinInstallId;

    let newerVersionLabel: string | null = null;
    // The commit the newest cut was taken from — uncut edits are measured
    // against it, not against the (possibly older) pin.
    let newestCutCommitSha: string | null = row.pinCommitSha;

    if (newestCutId) {
      const [cut] = await db
        .select({
          versionLabel: pi.versionLabel,
          commitSha: pi.sourceCommitSha,
        })
        .from(pi)
        .where(eq(pi.id, newestCutId));

      if (cut) {
        newestCutCommitSha = cut.commitSha;
        if (hasNewerCut) newerVersionLabel = cut.versionLabel;
      }
    }

    let headSha: string | null = null;

    try {
      headSha = await gitHeadSha(lpRow.workingDir);
    } catch {
      log.warn(
        { localPackageId: lpRow.id },
        "gitHeadSha failed — uncut-edit detection skipped",
      );
    }
    const hasUncutEdits =
      headSha != null &&
      newestCutCommitSha != null &&
      headSha !== newestCutCommitSha;

    if (!hasNewerCut && !hasUncutEdits) continue;

    const offeredOptions: VersionAdoptOption[] = ["keep"];

    if (hasNewerCut) offeredOptions.push("adopt", "try_once");
    if (hasUncutEdits) offeredOptions.push("cut_and_adopt");

    out.push({
      packageInstallId: row.pinInstallId,
      attachmentId: row.attachmentId,
      packageName: row.packageName,
      localPackageId: lpRow.id,
      localPackageName: lpRow.name,
      currentVersionLabel: row.pinVersionLabel,
      newerCutInstallId: hasNewerCut ? newestCutId : null,
      newerVersionLabel,
      hasUncutEdits,
      offeredOptions,
    });
  }

  return out;
}

// What `applyPackageVersionChoices` advanced — enough to re-pin (revert) each
// attachment to its prior install if the launch fails after the adopt.
export type AdoptRevert = { attachmentId: string; priorInstallId: string };

// ADR-132: a `try_once` choice translated into an ephemeral per-run pin
// instruction — the launch resolves the flow revision from this TARGET cut
// install; no attachment mutation happened and no AdoptRevert exists.
export type TryOncePin = { packageInstallId: string; packageName: string };

export type PackageVersionChoicesResult = {
  reverts: AdoptRevert[];
  tryOncePins: TryOncePin[];
};

const NO_CHOICES: PackageVersionChoicesResult = {
  reverts: [],
  tryOncePins: [],
};

// Apply the launcher's per-package version choices BEFORE the enablement check in
// `launchRunStaged`. Returns the per-attachment reverts it made (empty = nothing
// advanced) so the caller can re-pin if the launch fails AFTER the adopt
// (adopt+launch is atomic), plus the ADR-132 `try_once` pin instructions
// (validated like `adopt` but with NO attachment write and NO compensation).
// `keep` / absent choices = no-op. A key not in the
// detected set, or an option not offered for that package, → CONFLICT (409); a
// `cut_and_adopt` on a locked or invalid package → PRECONDITION (can still `keep`).
export async function applyPackageVersionChoices(opts: {
  projectId: string;
  projectSlug: string;
  workspaceRoot: string;
  choices?: Record<string, VersionAdoptOption>;
  db?: Db;
  signal?: AbortSignal;
}): Promise<PackageVersionChoicesResult> {
  const choices = opts.choices;

  if (!choices || Object.keys(choices).length === 0) return NO_CHOICES;

  const db = resolveDb(opts.db);
  const detected = await detectAvailablePackageVersions({
    projectId: opts.projectId,
    db,
  });
  const byInstall = new Map(detected.map((d) => [d.packageInstallId, d]));

  // Phase 1 — validate + resolve every choice WITHOUT mutating, so a statically
  // invalid choice (unknown install / unoffered option / adopt with no newer cut)
  // refuses before any attachment is advanced.
  type AdoptStep = {
    attachmentId: string;
    priorInstallId: string;
    localPackageId: string;
    choice: VersionAdoptOption;
    // adopt: the resolved target cut; cut_and_adopt: null (minted in phase 2).
    adoptTargetInstallId: string | null;
  };
  const steps: AdoptStep[] = [];
  const tryOncePins: TryOncePin[] = [];

  for (const [packageInstallId, choice] of Object.entries(choices)) {
    const avail = byInstall.get(packageInstallId);

    if (!avail) {
      throw new MaisterError(
        "CONFLICT",
        `no newer version available for package install ${packageInstallId}`,
      );
    }
    if (!avail.offeredOptions.includes(choice)) {
      throw new MaisterError(
        "CONFLICT",
        `version option "${choice}" is not offered for package "${avail.packageName}"`,
      );
    }
    if (choice === "keep") continue;
    if (
      (choice === "adopt" || choice === "try_once") &&
      !avail.newerCutInstallId
    ) {
      throw new MaisterError(
        "CONFLICT",
        `package "${avail.packageName}" has no newer cut to ${choice === "adopt" ? "adopt" : "try"}`,
      );
    }
    // ADR-132: try_once validates like adopt but mutates NOTHING — it becomes
    // an ephemeral per-run pin instruction the launch translates into the
    // packagePin resolution (which re-validates the full pin matrix).
    if (choice === "try_once") {
      tryOncePins.push({
        packageInstallId: avail.newerCutInstallId!,
        packageName: avail.packageName,
      });
      continue;
    }

    steps.push({
      attachmentId: avail.attachmentId,
      priorInstallId: avail.packageInstallId,
      localPackageId: avail.localPackageId,
      choice,
      adoptTargetInstallId: choice === "adopt" ? avail.newerCutInstallId : null,
    });
  }

  // Phase 2 — apply each advance; on ANY failure re-pin the ones already advanced
  // in THIS call before rethrowing, so a multi-package adopt is all-or-nothing (a
  // later package's lock / cut / upgrade failure never leaves an earlier pin moved).
  const reverts: AdoptRevert[] = [];

  try {
    for (const step of steps) {
      let targetInstallId: string;

      if (step.adoptTargetInstallId) {
        targetInstallId = step.adoptTargetInstallId;
      } else {
        // cut_and_adopt: mint a fresh cut from the uncut Studio edits via the gate.
        const [lpRow] = await db
          .select()
          .from(lp)
          .where(eq(lp.id, step.localPackageId));

        if (!lpRow) {
          throw new MaisterError(
            "CONFLICT",
            `local package ${step.localPackageId} not found`,
          );
        }
        // The Studio editor must be free — no one mid-edit (the launcher holds no
        // editor session, so any live lock means another session is editing).
        const lock = await readLockState(lpRow.id, "", db);

        if (lock.held) {
          throw new MaisterError(
            "PRECONDITION",
            `package "${lpRow.name}" is being edited (locked by ${lock.holderLabel ?? "another session"}) — cannot cut at launch`,
          );
        }
        await assertPackageCuttable(lpRow);
        const cut = await cutLocalPackageVersion(lpRow, { db });

        targetInstallId = cut.installId;
      }

      await upgradeAttachment({
        projectId: opts.projectId,
        projectSlug: opts.projectSlug,
        attachmentId: step.attachmentId,
        packageInstallId: targetInstallId,
        workspaceRoot: opts.workspaceRoot,
        db,
        signal: opts.signal,
      });
      reverts.push({
        attachmentId: step.attachmentId,
        priorInstallId: step.priorInstallId,
      });
      log.info(
        {
          projectId: opts.projectId,
          packageInstallId: step.priorInstallId,
          choice: step.choice,
          targetInstallId,
        },
        "version-adopt applied at launch",
      );
    }
  } catch (err) {
    await revertPackageVersionChoices(reverts, {
      projectId: opts.projectId,
      projectSlug: opts.projectSlug,
      workspaceRoot: opts.workspaceRoot,
      db,
    });
    throw err;
  }

  return { reverts, tryOncePins };
}

// Compensation for adopt-at-launch (ADR-107): re-pin each advanced attachment to
// its prior install when the launch fails AFTER the adopt — so a failed launch
// never leaves the shared project pin silently advanced. Best-effort per revert;
// a revert failure is logged (manual re-pin) but never masks the original error.
export async function revertPackageVersionChoices(
  reverts: AdoptRevert[],
  opts: {
    projectId: string;
    projectSlug: string;
    workspaceRoot: string;
    db?: Db;
  },
): Promise<void> {
  if (reverts.length === 0) return;
  const db = resolveDb(opts.db);

  for (const revert of reverts) {
    try {
      await upgradeAttachment({
        projectId: opts.projectId,
        projectSlug: opts.projectSlug,
        attachmentId: revert.attachmentId,
        packageInstallId: revert.priorInstallId,
        workspaceRoot: opts.workspaceRoot,
        db,
      });
      log.info(
        { projectId: opts.projectId, ...revert },
        "version-adopt reverted after a failed launch",
      );
    } catch (err) {
      log.error(
        { projectId: opts.projectId, ...revert, err: (err as Error).message },
        "version-adopt revert FAILED — manual re-pin may be required",
      );
    }
  }
}

export type RunPackageProvenance = {
  packageName: string;
  versionLabel: string;
  localPackageName: string | null;
  // ADR-132: provenance kind + short digest for the comparison-lab badges.
  kind: "local_cut" | "upstream";
  installDigest12: string;
};

// Provenance for a run's snapshotted flow revision: match `runs.flow_revision`
// to the install that shipped it. Two arms (ADR-132): a centralized local-cut
// install (carries `source_local_package_id`) or a plain upstream install.
// Derivable with NO `runs` column (ADR-107). Null when no install matches
// (degradation — the lab renders the run without package badges). A local-cut
// row wins over an upstream row on a shared revision string; the `asc(pi.id)`
// tie-break makes the pick STABLE even when two byte-identical forks collide on
// one digest (their identical `resolved_revision` means the same content ran —
// only the fork NAME badge is then lossy, deterministically).
export async function resolvePackageProvenanceByRevision(
  resolvedRevision: string,
  db?: Db,
): Promise<RunPackageProvenance | null> {
  const d = resolveDb(db);
  const rows = await d
    .select({
      packageName: pi.name,
      versionLabel: pi.versionLabel,
      localPackageName: lp.name,
      sourceLocalPackageId: pi.sourceLocalPackageId,
      resolvedRevision: pi.resolvedRevision,
    })
    .from(pi)
    .leftJoin(lp, eq(lp.id, pi.sourceLocalPackageId))
    .where(eq(pi.resolvedRevision, resolvedRevision))
    .orderBy(asc(pi.id))
    .limit(2);
  const row =
    rows.find(
      (candidate: Record<string, unknown>) => candidate.sourceLocalPackageId,
    ) ?? rows[0];

  if (!row) return null;

  return {
    packageName: row.packageName,
    versionLabel: row.versionLabel,
    localPackageName: row.localPackageName ?? null,
    kind: row.sourceLocalPackageId ? "local_cut" : "upstream",
    installDigest12: String(row.resolvedRevision ?? resolvedRevision).slice(
      0,
      12,
    ),
  };
}

export async function getRunPackageProvenance(
  runId: string,
  db?: Db,
): Promise<RunPackageProvenance | null> {
  const d = resolveDb(db);
  const [run] = await d
    .select({ flowRevision: schema.runs.flowRevision })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  if (!run?.flowRevision) return null;

  return resolvePackageProvenanceByRevision(run.flowRevision, d);
}

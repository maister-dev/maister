import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalPackage } from "@/lib/db/schema";

import { rm } from "node:fs/promises";

import { and, eq, isNotNull } from "drizzle-orm";
import pino from "pino";

import { gitHeadSha } from "./git";
import { readLockState } from "./lock";
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

export type VersionAdoptOption = "keep" | "adopt" | "cut_and_adopt";

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

    if (hasNewerCut) offeredOptions.push("adopt");
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

// Apply the launcher's per-package version choices BEFORE the enablement check in
// `launchRunStaged`. Returns the per-attachment reverts it made (empty = nothing
// advanced) so the caller can re-pin if the launch fails AFTER the adopt
// (adopt+launch is atomic). `keep` / absent choices = no-op. A key not in the
// detected set, or an option not offered for that package, → CONFLICT (409); a
// `cut_and_adopt` on a locked or invalid package → PRECONDITION (can still `keep`).
export async function applyPackageVersionChoices(opts: {
  projectId: string;
  projectSlug: string;
  workspaceRoot: string;
  choices?: Record<string, VersionAdoptOption>;
  db?: Db;
  signal?: AbortSignal;
}): Promise<AdoptRevert[]> {
  const choices = opts.choices;

  if (!choices || Object.keys(choices).length === 0) return [];

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
    if (choice === "adopt" && !avail.newerCutInstallId) {
      throw new MaisterError(
        "CONFLICT",
        `package "${avail.packageName}" has no newer cut to adopt`,
      );
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

  return reverts;
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
};

// Provenance for a run whose flow came from a centralized local-package cut:
// match the run's flow-revision digest to the cut install (the one carrying a
// `source_local_package_id`) and read the package name + version + originating
// local package. Derivable with NO `runs` column (ADR-107). Null when the run's
// flow did not come from a centralized cut.
export async function resolvePackageProvenanceByRevision(
  resolvedRevision: string,
  db?: Db,
): Promise<RunPackageProvenance | null> {
  const d = resolveDb(db);
  const [row] = await d
    .select({
      packageName: pi.name,
      versionLabel: pi.versionLabel,
      localPackageName: lp.name,
    })
    .from(pi)
    .leftJoin(lp, eq(lp.id, pi.sourceLocalPackageId))
    .where(
      and(
        eq(pi.resolvedRevision, resolvedRevision),
        isNotNull(pi.sourceLocalPackageId),
      ),
    )
    .limit(1);

  return row ?? null;
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

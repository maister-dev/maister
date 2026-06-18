import "server-only";

import { stat, unlink } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, isNull } from "drizzle-orm";
import pino from "pino";

import { atomicWriteText } from "@/lib/atomic";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  serializeProjectConfig,
  type SerializeProjectAttachments,
} from "@/lib/packages/yaml-writeback";
import {
  commitFile,
  currentBranchName,
  isGitRepo,
  pushBranch,
  showFileAtHead,
  statusPorcelain,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants (matches route usage).
const { packageInstalls, projectPackageAttachments, projects } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "persist-config",
  level: process.env.LOG_LEVEL ?? "info",
});

const MAISTER_YAML = "maister.yaml";
const COMMIT_MESSAGE = "chore(maister): persist project config";

export type PersistConfigProject = {
  id: string;
  repoPath: string;
  name: string;
  mainBranch: string;
  branchPrefix: string;
  defaultRunnerId: string | null;
  promotionMode: string | null;
  maisterYamlPath: string | null;
};

export type PersistConfigResult = {
  // true = a prior persist committed the file but crashed before the DB flip;
  // this call only flipped the DB (no new write/commit).
  reconciled: boolean;
  usedDefaultAuthor: boolean;
  pushed: boolean;
  pushWarning?: string;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

// Gather the project's attached packages so the persisted file matches the DB
// (design §7.1). `flows: []` stays empty by construction: a project reaches
// persist only with `maisterYamlPath` NULL — i.e. it was registered with no
// manifest — so it has no standalone flows; its only attachments come from
// packages[] (their member flows re-derive on re-register, exactly as
// writeBackPackagesPin's packages[]-only write-back contract).
async function gatherAttachments(
  db: any,
  projectId: string,
): Promise<SerializeProjectAttachments> {
  const attachments = await db
    .select()
    .from(projectPackageAttachments)
    .where(eq(projectPackageAttachments.projectId, projectId));

  if (attachments.length === 0) return { flows: [], packages: [] };

  const installs = await db
    .select()
    .from(packageInstalls)
    .where(
      inArray(
        packageInstalls.id,
        attachments.map((a: any) => a.packageInstallId),
      ),
    );
  const installById = new Map<string, any>(installs.map((i: any) => [i.id, i]));

  const packages = attachments
    .map((att: any) => {
      const install = installById.get(att.packageInstallId);

      if (!install) return null;
      const manifest = install.manifest as
        | { sourceSubpath?: string }
        | undefined;

      return {
        id: install.name as string,
        source: install.sourceUrl as string,
        version: install.versionLabel as string,
        ...(manifest?.sourceSubpath !== undefined
          ? { path: manifest.sourceSubpath }
          : {}),
      };
    })
    .filter((p: unknown): p is NonNullable<typeof p> => p !== null);

  return { flows: [], packages };
}

// ADR-093 Workstream 4: materialize a DB-only project's config into a complete,
// schema-valid maister.yaml v2 on the main branch — a multi-store transition
// (working-tree file -> git commit -> DB column -> optional push) with the
// crash-window recovery enumerated in the ADR. The route owns slug->project
// resolution + authz; this owns the preconditions and the ordered writes.
export async function persistProjectConfig(opts: {
  project: PersistConfigProject;
  db: any;
  push: boolean;
}): Promise<PersistConfigResult> {
  const { project, db, push } = opts;
  const repo = project.repoPath;
  const yamlPath = path.join(repo, MAISTER_YAML);

  // (1) Already persisted — the DB column is the durable signal; never re-write.
  if (project.maisterYamlPath !== null) {
    throw new MaisterError(
      "CONFLICT",
      "Project config is already persisted to maister.yaml.",
    );
  }

  // (2) Preconditions on repo_path (server-state). All map to PRECONDITION 409.
  if (!(await isGitRepo(repo))) {
    throw new MaisterError(
      "PRECONDITION",
      `Persist requires a git repository at ${repo}.`,
    );
  }

  const branch = await currentBranchName(repo);

  if (branch === null) {
    throw new MaisterError(
      "PRECONDITION",
      "Persist requires HEAD on the project main branch (HEAD is detached).",
    );
  }
  if (branch !== project.mainBranch) {
    throw new MaisterError(
      "PRECONDITION",
      `Persist requires HEAD on the project main branch (on "${branch}", expected "${project.mainBranch}").`,
    );
  }

  const serialized = serializeProjectConfig(
    {
      name: project.name,
      mainBranch: project.mainBranch,
      branchPrefix: project.branchPrefix,
      defaultRunnerId: project.defaultRunnerId,
      promotionMode: project.promotionMode,
    },
    await gatherAttachments(db, project.id),
  );

  let reconciled = false;
  let usedDefaultAuthor = false;

  if (await pathExists(yamlPath)) {
    // Idempotent-completing recovery (ADR-093): a prior persist committed the
    // file but crashed before the DB flip. Reconcile ONLY when the tree is
    // clean AND HEAD's maister.yaml is byte-identical to what we would write
    // now — then flip the DB only. Anything else is an unexpected / operator
    // file → PRECONDITION (never clobber).
    const clean = (await statusPorcelain({ worktreePath: repo })).trim() === "";
    const headContent = await showFileAtHead(repo, MAISTER_YAML);

    if (clean && headContent !== null && headContent === serialized) {
      reconciled = true;
      log.info(
        { projectId: project.id },
        "persist: reconciling a prior crash — flipping the DB only",
      );
    } else {
      throw new MaisterError(
        "PRECONDITION",
        "A maister.yaml already exists in the repo; resolve it before persisting.",
      );
    }
  } else {
    // Fresh path: clean tree → write → commit. A commit failure removes the
    // just-written file (the precondition proved it did not pre-exist) and
    // leaves the DB column NULL, so the banner stays and a retry is clean.
    const clean = (await statusPorcelain({ worktreePath: repo })).trim() === "";

    if (!clean) {
      throw new MaisterError(
        "PRECONDITION",
        "Persist requires a clean working tree.",
      );
    }

    log.info(
      { projectId: project.id, yamlPath },
      "persist: writing maister.yaml",
    );
    await atomicWriteText(yamlPath, serialized);

    try {
      const committed = await commitFile({
        repo,
        file: MAISTER_YAML,
        message: COMMIT_MESSAGE,
      });

      usedDefaultAuthor = committed.usedDefaultAuthor;
      log.info(
        { projectId: project.id, usedDefaultAuthor },
        "persist: committed maister.yaml",
      );
    } catch (err) {
      await unlink(yamlPath).catch(() => undefined);
      throw err;
    }
  }

  // (3) DB flip — CAS on `maisterYamlPath IS NULL` so a concurrent persist that
  // already flipped is a no-op, never a double-write.
  await db
    .update(projects)
    .set({ maisterYamlPath: yamlPath })
    .where(and(eq(projects.id, project.id), isNull(projects.maisterYamlPath)));
  log.info({ projectId: project.id, yamlPath }, "persist: DB column flipped");

  // (4) Optional push AFTER the flip. Persist has already succeeded; a push
  // failure (GitPushRejectedError / EXECUTOR_UNAVAILABLE — both MaisterError,
  // already redacted) is advisory only and NEVER rolls back the commit/flip.
  let pushed = false;
  let pushWarning: string | undefined;

  if (push) {
    try {
      await pushBranch({
        projectRepoPath: repo,
        remote: "origin",
        branch: project.mainBranch,
      });
      pushed = true;
      log.info({ projectId: project.id }, "persist: pushed to origin");
    } catch (err) {
      if (err instanceof MaisterError) {
        pushWarning = err.message;
        log.warn(
          { projectId: project.id, pushWarning },
          "persist: push failed (advisory; persist already succeeded)",
        );
      } else {
        throw err;
      }
    }
  }

  return { reconciled, usedDefaultAuthor, pushed, pushWarning };
}

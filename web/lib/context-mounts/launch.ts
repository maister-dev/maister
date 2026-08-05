import "server-only";

import type {
  ContextMountSnapshot,
  ContextRepoDecl,
} from "@/lib/context-mounts/types";

import { eq } from "drizzle-orm";
import pino from "pino";

import { requireProjectActionForUser } from "@/lib/authz";
import {
  materializeContextMounts,
  resolveContextMounts,
} from "@/lib/context-mounts/service";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contextMountEnabled } from "@/lib/instance-config";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/context-mounts/service.ts).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "context-mounts-launch",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-157 D11: on the FLOW path the launching user is the consent event, so the
// launch refuses unless that user holds `readRepoFiles` on every sibling. The
// AGENT path passes `consent: "attach-time"` because there is no launching user
// — a project admin already authorized the sibling when writing
// `agent_project_links.context_repos` (authorizeContextRepos), and re-checking
// here would only be able to check the wrong identity.
export type ContextMountConsent =
  | { kind: "launching-user"; userId: string | null | undefined }
  | { kind: "attach-time" };

export type PrepareContextMountsArgs = {
  db: Db;
  runId: string;
  consumingProjectSlug: string;
  decls: ContextRepoDecl[] | null | undefined;
  consent: ContextMountConsent;
};

async function authorizeLaunchingUser(
  snapshot: ContextMountSnapshot[],
  userId: string | null | undefined,
): Promise<void> {
  for (const mount of snapshot) {
    if (!userId) {
      throw new MaisterError(
        "PRECONDITION",
        `context_repos: reading project "${mount.slug}" requires an authenticated launching user`,
      );
    }

    try {
      await requireProjectActionForUser(
        userId,
        mount.projectId,
        "readRepoFiles",
      );
    } catch {
      throw new MaisterError(
        "PRECONDITION",
        `context_repos: the launching user lacks readRepoFiles on project "${mount.slug}"`,
      );
    }
  }
}

// ADR-157: merge onto whatever this run already mounted rather than replace it.
// A graph run can visit several mount-declaring nodes, and the terminal release
// reads ONLY this column — a per-node overwrite would strand every mount but the
// last one. Keyed on mountPath (the sibling slug is unique within a run dir).
async function persistLaunchSnapshot(
  db: Db,
  runId: string,
  snapshot: ContextMountSnapshot[],
): Promise<void> {
  await db.transaction(async (tx: Db) => {
    // `FOR UPDATE` on the run row, not just a transaction: a transaction is
    // atomicity, not mutual exclusion. Two mount-declaring nodes merging
    // concurrently would both read the same `existing` and the second write
    // would silently drop the first node's mounts, stranding those worktrees
    // (the terminal release reads ONLY this column). The graph runner is a
    // single writer per run today, so this is defence in depth — but it is one
    // line, and the lost-update shape is the exact class this repo keeps
    // rediscovering.
    const rows = (await tx
      .select({ contextMounts: runs.contextMounts })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update")) as Array<{
      contextMounts: ContextMountSnapshot[] | null;
    }>;
    const existing = rows[0]?.contextMounts ?? [];
    const merged = new Map(existing.map((m) => [m.mountPath, m]));

    for (const mount of snapshot) merged.set(mount.mountPath, mount);

    await tx
      .update(runs)
      .set({ contextMounts: [...merged.values()] })
      .where(eq(runs.id, runId));
  });
}

/**
 * Resolve → consent → materialize → snapshot, in that order. Git side-effects
 * land BEFORE the durable snapshot write (ADR-157's one accepted residual crash
 * window: mounts created but the snapshot never committed are reaped by the GC
 * backstop on path shape alone).
 *
 * Returns the mounts this call materialized — the value the caller threads onto
 * the supervisor session. `[]` whenever the kill-switch is off or nothing was
 * declared, so a declaring node/attachment launches with no mounts and no
 * checkout.
 */
export async function prepareContextMounts(
  args: PrepareContextMountsArgs,
): Promise<ContextMountSnapshot[]> {
  const decls = args.decls ?? [];

  if (decls.length === 0) return [];

  if (!contextMountEnabled()) {
    log.info(
      { runId: args.runId, declared: decls.map((d) => d.project) },
      "context mounts declared but MAISTER_CONTEXT_MOUNT_ENABLED=false — launching with no mounts",
    );

    return [];
  }

  const snapshot = await resolveContextMounts({
    consumingProjectSlug: args.consumingProjectSlug,
    runId: args.runId,
    decls,
    db: args.db,
  });

  if (args.consent.kind === "launching-user") {
    await authorizeLaunchingUser(snapshot, args.consent.userId);
  }

  await materializeContextMounts(snapshot);
  await persistLaunchSnapshot(args.db ?? getDb(), args.runId, snapshot);

  log.debug(
    {
      runId: args.runId,
      mounts: snapshot.map((m) => ({
        slug: m.slug,
        committish: m.committish,
        mountPath: m.mountPath,
      })),
    },
    "context mount launch snapshot persisted",
  );

  return snapshot;
}

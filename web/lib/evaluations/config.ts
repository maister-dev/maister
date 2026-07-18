import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type {
  EvaluationPanelPolicy,
  EvaluationPanelRoleBinding,
} from "@/lib/evaluations/types";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  evaluationJudgePanels,
  evaluationMethodRevisions,
  evaluationProfiles,
  evaluationProjectProfileOverrides,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "evaluations-config",
  level: process.env.LOG_LEVEL ?? "info",
});

// A stale optimistic-revision write and a missing row are distinct outcomes: a
// missing row is PRECONDITION (404-shaped), a version mismatch is CONFLICT
// (409). Shared by every config PATCH so the contract can never drift.
async function assertRevisionOrThrow(
  d: Db,
  table: PgTable & { id: AnyPgColumn },
  id: string,
  updated: unknown[],
  what: string,
  expectedRevision: number,
): Promise<void> {
  if (updated.length) return;

  const [exists] = await d
    .select({ id: table.id })
    .from(table)
    .where(eq(table.id, id));

  if (!exists) {
    throw new MaisterError("PRECONDITION", `${what} not found: ${id}`);
  }

  throw new MaisterError(
    "CONFLICT",
    `${what} ${id} revision mismatch (expected ${expectedRevision})`,
  );
}

// --- Read helpers ------------------------------------------------------------

export async function listPanels(db?: Db): Promise<Record<string, unknown>[]> {
  const d = db ?? getDb();

  return d.select().from(evaluationJudgePanels);
}

export async function getPanel(
  panelId: string,
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const [row] = await d
    .select()
    .from(evaluationJudgePanels)
    .where(eq(evaluationJudgePanels.id, panelId));

  if (!row) {
    throw new MaisterError("PRECONDITION", `judge panel not found: ${panelId}`);
  }

  return row;
}

export async function listProfiles(
  db?: Db,
): Promise<Record<string, unknown>[]> {
  const d = db ?? getDb();

  return d.select().from(evaluationProfiles);
}

export async function getProfile(
  profileId: string,
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const [row] = await d
    .select()
    .from(evaluationProfiles)
    .where(eq(evaluationProfiles.id, profileId));

  if (!row) {
    throw new MaisterError(
      "PRECONDITION",
      `evaluation profile not found: ${profileId}`,
    );
  }

  return row;
}

export async function getProjectOverride(
  args: { projectId: string; profileId: string },
  db?: Db,
): Promise<Record<string, unknown> | null> {
  const d = db ?? getDb();
  const [row] = await d
    .select()
    .from(evaluationProjectProfileOverrides)
    .where(
      and(
        eq(evaluationProjectProfileOverrides.projectId, args.projectId),
        eq(evaluationProjectProfileOverrides.profileId, args.profileId),
      ),
    );

  return row ?? null;
}

// --- Judge Panels ------------------------------------------------------------

export async function createPanel(
  args: {
    name: string;
    roleBindings: EvaluationPanelRoleBinding[];
    policy: EvaluationPanelPolicy;
    createdByUserId?: string | null;
  },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const [panel] = await d
    .insert(evaluationJudgePanels)
    .values({
      name: args.name,
      roleBindings: args.roleBindings,
      policy: args.policy,
      createdByUserId: args.createdByUserId ?? null,
      updatedByUserId: args.createdByUserId ?? null,
    })
    .returning();

  log.info({ panelId: panel.id }, "judge panel created");

  return panel;
}

export async function patchPanel(
  args: {
    panelId: string;
    expectedRevision: number;
    name?: string;
    roleBindings?: EvaluationPanelRoleBinding[];
    policy?: EvaluationPanelPolicy;
    enabled?: boolean;
    updatedByUserId?: string | null;
  },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const updated = await d
    .update(evaluationJudgePanels)
    .set({
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.roleBindings !== undefined
        ? { roleBindings: args.roleBindings }
        : {}),
      ...(args.policy !== undefined ? { policy: args.policy } : {}),
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      updatedByUserId: args.updatedByUserId ?? null,
      revision: args.expectedRevision + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(evaluationJudgePanels.id, args.panelId),
        eq(evaluationJudgePanels.revision, args.expectedRevision),
      ),
    )
    .returning();

  await assertRevisionOrThrow(
    d,
    evaluationJudgePanels,
    args.panelId,
    updated,
    "judge panel",
    args.expectedRevision,
  );

  return updated[0];
}

// Usage-guarded hard delete: a Panel referenced by any Profile cannot be
// deleted (historical executions use snapshots, so the Panel row must stay
// referenceable). Returns CONFLICT rather than cascading. The revision
// predicate lives in the DELETE's WHERE (same CAS shape as patchPanel) so a
// concurrent PATCH between any pre-read and the delete can never be lost.
export async function deletePanel(
  args: { panelId: string; expectedRevision: number },
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const [inUse] = await tx
      .select({ id: evaluationProfiles.id })
      .from(evaluationProfiles)
      .where(eq(evaluationProfiles.panelId, args.panelId))
      .limit(1);

    if (inUse) {
      throw new MaisterError(
        "CONFLICT",
        `judge panel ${args.panelId} is referenced by a profile`,
      );
    }

    const deleted = await tx
      .delete(evaluationJudgePanels)
      .where(
        and(
          eq(evaluationJudgePanels.id, args.panelId),
          eq(evaluationJudgePanels.revision, args.expectedRevision),
        ),
      )
      .returning({ id: evaluationJudgePanels.id });

    await assertRevisionOrThrow(
      tx,
      evaluationJudgePanels,
      args.panelId,
      deleted,
      "judge panel",
      args.expectedRevision,
    );
  });
}

// --- Profiles ----------------------------------------------------------------

export async function createProfile(
  args: {
    name: string;
    methodRevisionId: string;
    panelId: string;
    defaults?: Record<string, unknown> | null;
    hardLimits?: Record<string, unknown> | null;
    allowedOverrides?: Record<string, unknown> | null;
    createdByUserId?: string | null;
  },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const [method] = await tx
      .select({ id: evaluationMethodRevisions.id })
      .from(evaluationMethodRevisions)
      .where(eq(evaluationMethodRevisions.id, args.methodRevisionId));

    if (!method) {
      throw new MaisterError(
        "PRECONDITION",
        `method revision not found: ${args.methodRevisionId}`,
      );
    }

    const [panel] = await tx
      .select({ id: evaluationJudgePanels.id })
      .from(evaluationJudgePanels)
      .where(eq(evaluationJudgePanels.id, args.panelId));

    if (!panel) {
      throw new MaisterError(
        "PRECONDITION",
        `judge panel not found: ${args.panelId}`,
      );
    }

    const [profile] = await tx
      .insert(evaluationProfiles)
      .values({
        name: args.name,
        methodRevisionId: args.methodRevisionId,
        panelId: args.panelId,
        defaults: args.defaults ?? null,
        hardLimits: args.hardLimits ?? null,
        allowedOverrides: args.allowedOverrides ?? null,
        createdByUserId: args.createdByUserId ?? null,
        updatedByUserId: args.createdByUserId ?? null,
      })
      .returning();

    log.info({ profileId: profile.id }, "evaluation profile created");

    return profile;
  });
}

export async function patchProfile(
  args: {
    profileId: string;
    expectedRevision: number;
    name?: string;
    defaults?: Record<string, unknown> | null;
    hardLimits?: Record<string, unknown> | null;
    allowedOverrides?: Record<string, unknown> | null;
    enabled?: boolean;
    updatedByUserId?: string | null;
  },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const updated = await d
    .update(evaluationProfiles)
    .set({
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.defaults !== undefined ? { defaults: args.defaults } : {}),
      ...(args.hardLimits !== undefined ? { hardLimits: args.hardLimits } : {}),
      ...(args.allowedOverrides !== undefined
        ? { allowedOverrides: args.allowedOverrides }
        : {}),
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      updatedByUserId: args.updatedByUserId ?? null,
      revision: args.expectedRevision + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(evaluationProfiles.id, args.profileId),
        eq(evaluationProfiles.revision, args.expectedRevision),
      ),
    )
    .returning();

  await assertRevisionOrThrow(
    d,
    evaluationProfiles,
    args.profileId,
    updated,
    "evaluation profile",
    args.expectedRevision,
  );

  return updated[0];
}

export async function deleteProfile(
  args: { profileId: string; expectedRevision: number },
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const [inUse] = await tx
      .select({ id: evaluationProjectProfileOverrides.id })
      .from(evaluationProjectProfileOverrides)
      .where(eq(evaluationProjectProfileOverrides.profileId, args.profileId))
      .limit(1);

    if (inUse) {
      throw new MaisterError(
        "CONFLICT",
        `evaluation profile ${args.profileId} has project overrides`,
      );
    }

    const deleted = await tx
      .delete(evaluationProfiles)
      .where(
        and(
          eq(evaluationProfiles.id, args.profileId),
          eq(evaluationProfiles.revision, args.expectedRevision),
        ),
      )
      .returning({ id: evaluationProfiles.id });

    await assertRevisionOrThrow(
      tx,
      evaluationProfiles,
      args.profileId,
      deleted,
      "evaluation profile",
      args.expectedRevision,
    );
  });
}

// --- Project overrides (SET / CLEAR / re-set symmetry) -----------------------

// SET: upsert the override for (project, profile), bumping revision. The
// paired CLEAR (deleteProjectOverride) removes the row entirely — absent means
// "inherit the Profile default", never a stale value (bidirectional contract).
export async function putProjectOverride(
  args: {
    projectId: string;
    profileId: string;
    overrides: Record<string, unknown>;
    updatedByUserId?: string | null;
  },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const [row] = await d
    .insert(evaluationProjectProfileOverrides)
    .values({
      projectId: args.projectId,
      profileId: args.profileId,
      overrides: args.overrides,
      updatedByUserId: args.updatedByUserId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        evaluationProjectProfileOverrides.projectId,
        evaluationProjectProfileOverrides.profileId,
      ],
      set: {
        overrides: args.overrides,
        updatedByUserId: args.updatedByUserId ?? null,
        revision: sql`${evaluationProjectProfileOverrides.revision} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();

  return row;
}

// CLEAR: an absent row means inherit — deleting is the honest reset. Idempotent
// (deleting an absent override is a no-op).
export async function clearProjectOverride(
  args: { projectId: string; profileId: string },
  db?: Db,
): Promise<{ cleared: boolean }> {
  const d = db ?? getDb();
  const deleted = await d
    .delete(evaluationProjectProfileOverrides)
    .where(
      and(
        eq(evaluationProjectProfileOverrides.projectId, args.projectId),
        eq(evaluationProjectProfileOverrides.profileId, args.profileId),
      ),
    )
    .returning({ id: evaluationProjectProfileOverrides.id });

  return { cleared: deleted.length > 0 };
}
